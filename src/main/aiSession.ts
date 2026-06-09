import { ModelGateway } from "../gateway/gateway.js";
import { KeyStore } from "../gateway/keyStore.js";
import { anthropicAdapter } from "../gateway/providers/anthropic.js";
import { openaiAdapter } from "../gateway/providers/openai.js";
import { createScrubbingLogger, toSafeError } from "../gateway/redaction.js";
import { runProposalTurn } from "../gateway/propose.js";
import { proposalPolicyMessage } from "../gateway/proposalPrompt.js";
import type { ProposalDraft, StoredProposal } from "../shared/proposal.js";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { GroundingService } from "../grounding/vaultIndexer.js";
import { ChildProcessEmbedder } from "../grounding/childEmbedder.js";
import { IndexStore } from "../grounding/indexStore.js";
import { ElectronKeychain } from "./keychainElectron.js";
import type {
  AiIndexResult,
  AiSendOptions,
  AiSendResult,
  AiSetKeyResult,
  AiStatus,
  ChatMessage,
  ChatRequest,
  GroundingMeta,
  GroundingStatus,
  ProviderId,
} from "../shared/ai.js";

let keyStore: KeyStore | null = null;
let gateway: ModelGateway | null = null;
let grounder: GroundingService | null = null;
let embedder: ChildProcessEmbedder | null = null;
/** App-private dir holding the per-vault persisted indexes (D16). */
let groundingDir = "";
/** The current vault's index store (null when no vault / no dir yet). */
let currentStore: IndexStore | null = null;

/** 384-dim all-MiniLM-L6-v2. */
const EMBED_DIMENSION = 384;

/** Per-vault index file, keyed by a hash of the vault root so vaults never share
 *  (or clobber) each other's saved vectors. Null when there's no vault/dir. */
function storeFor(root: string | null): IndexStore | null {
  if (!root || !groundingDir) return null;
  const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return new IndexStore(path.join(groundingDir, `${key}.jsonl`));
}

/** (Re)build the grounder for `root`, wiring its persistent store. */
function buildGrounder(root: string | null): void {
  currentStore = storeFor(root);
  try {
    grounder = new GroundingService(makeEmbedder(), {}, currentStore);
  } catch {
    grounder = null;
  }
}

/**
 * Build the embedder. The real model runs in a STOCK-NODE child process (via
 * tsx), NOT the Electron main process — onnxruntime-node is a native addon that
 * SIGTRAPs the main process. Disposes any prior child first (vault switch).
 *
 * NOTE (D17 / eventual packaged-build fix): this spawns the .ts worker via tsx,
 * which only exists in dev. A packaged build can't rely on tsx or src/ — it must
 * bundle the model + onnxruntime and fork compiled JS (or use a utilityProcess).
 */
function makeEmbedder(): ChildProcessEmbedder {
  embedder?.dispose();
  // __dirname is <root>/dist/main at runtime.
  const root = path.join(__dirname, "..", "..");
  const tsx = path.join(root, "node_modules", ".bin", "tsx");
  const child = path.join(root, "src", "grounding", "embedderChild.ts");
  embedder = new ChildProcessEmbedder({
    command: tsx,
    args: [child],
    dimension: EMBED_DIMENSION,
  });
  return embedder;
}

/**
 * Sink that persists a parsed proposal into the proposal store and returns the
 * stored record (or null if the proposal was rejected, e.g. an unsafe path).
 * Wired by the main bootstrap so this module needs no proposalSession import —
 * the same decoupling pattern as setOnSaved on vaultSession.
 */
type ProposalSink = (
  draft: ProposalDraft,
  backref: { chatId: string; turnTs: number }
) => Promise<StoredProposal | null>;
let proposalSink: ProposalSink | null = null;
export function setProposalSink(sink: ProposalSink): void {
  proposalSink = sink;
}

/**
 * Build the AI layer at app start. This MUST NOT throw — a broken keychain or a
 * tampered keys.enc leaves the store "locked"/"tampered" but the app still
 * opens (D5). Any unexpected error here is swallowed so the editor launches.
 */
export async function initAi(opts: {
  keysPath: string;
  keychainBlobPath: string;
  groundingDir: string;
}): Promise<void> {
  try {
    groundingDir = opts.groundingDir;
    const keychain = new ElectronKeychain(opts.keychainBlobPath);
    keyStore = await KeyStore.open({ path: opts.keysPath, keychain });
    const logger = createScrubbingLogger(() => keyStore?.secrets() ?? []);
    gateway = new ModelGateway({
      keyStore,
      adapters: { anthropic: anthropicAdapter, openai: openaiAdapter },
      fetchImpl: (url, init) => fetch(url, init),
      logger,
    });
    // No vault is bound yet; the bootstrap calls resetGrounding(root) once the
    // active vault is known (launch) and on every switch.
    buildGrounder(null);
  } catch {
    keyStore = null;
    gateway = null;
    grounder = null;
  }
}

/** True if the current vault has a persisted index on disk → launch can
 *  auto-reconcile (cheap) instead of waiting for an explicit re-index. */
export function groundingHasSavedIndex(): Promise<boolean> {
  return currentStore ? currentStore.exists() : Promise.resolve(false);
}

/** Reconcile the in-memory index against the persisted one (D16): reuse saved
 *  vectors for unchanged notes, re-embed only what changed. The launch + button
 *  path. Wrapped like aiIndexVault so only a safe result crosses IPC. */
export async function reconcileGrounding(root: string): Promise<AiIndexResult> {
  if (!grounder) return { ok: false, message: "grounding is unavailable" };
  try {
    const { notes, chunks } = await grounder.reconcile(root);
    return { ok: true, notes, chunks };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "indexing failed",
    };
  }
}

export function aiStatus(): AiStatus {
  if (!keyStore) return { keyStoreState: "locked", configured: [] };
  return {
    keyStoreState: keyStore.state,
    configured: keyStore.configuredProviders(),
  };
}

export async function aiSetKey(
  provider: ProviderId,
  key: string
): Promise<AiSetKeyResult> {
  if (!keyStore) return { ok: false, error: { variant: "AuthFailed" } };
  try {
    await keyStore.setKey(provider, key);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toSafeError(err) };
  }
}

function lastUserMessage(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") return m.content;
  }
  return undefined;
}

/**
 * Map the retrieved chunks to grounding sources IN ORDER, one per excerpt.
 * Order matters: excerpt N in the injected context (see buildContext) is
 * numbered [N], so `sources[N-1]` is the note the model means when it writes
 * "[N]". The renderer relies on this alignment to thread an inline citation to
 * the right sidenote. Duplicates (two chunks from the same note) are kept —
 * they're distinct excerpts and may be cited separately; the UI dedupes for the
 * summary count.
 */
function orderedSources(
  chunks: { notePath: string; heading?: string }[]
): GroundingMeta {
  const sources = chunks.map((c) =>
    c.heading !== undefined
      ? { notePath: c.notePath, heading: c.heading }
      : { notePath: c.notePath }
  );
  return { grounded: true, sources };
}

/**
 * Build the (possibly grounded) message list + grounding meta. D12: when
 * grounding is requested but produces nothing usable, we return a `grounded:
 * false` meta with the reason and DO NOT inject anything — the caller still
 * answers, and the UI shows the visible badge.
 */
async function applyGrounding(
  req: ChatRequest,
  opts?: AiSendOptions
): Promise<{ messages: ChatMessage[]; grounding: GroundingMeta }> {
  if (!opts?.ground) {
    return { messages: req.messages, grounding: { grounded: false, reason: "off" } };
  }
  if (!grounder || !grounder.status().ready) {
    return {
      messages: req.messages,
      grounding: { grounded: false, reason: "not-indexed" },
    };
  }
  const query = lastUserMessage(req.messages);
  if (query === undefined) {
    return {
      messages: req.messages,
      grounding: { grounded: false, reason: "no-matches" },
    };
  }
  const result = await grounder.ground(query);
  if (result.status === "grounded") {
    const messages: ChatMessage[] = [
      { role: "system", content: result.injected },
      ...req.messages,
    ];
    return { messages, grounding: orderedSources(result.chunks) };
  }
  return {
    messages: req.messages,
    grounding: { grounded: false, reason: result.reason },
  };
}

export async function aiSend(
  req: ChatRequest,
  opts?: AiSendOptions
): Promise<AiSendResult> {
  if (!gateway) return { ok: false, error: { variant: "AuthFailed" } };
  const { messages, grounding } = await applyGrounding(req, opts);
  // Prompt ordering (see proposalPrompt.ts): stable policy FIRST, then the
  // dynamic grounding excerpts inside `messages`, then the conversation.
  const fullMessages = [proposalPolicyMessage(), ...messages];
  try {
    const { parsed, response } = await runProposalTurn(gateway, {
      ...req,
      messages: fullMessages,
    });
    // The user sees the cleaned text (proposal block stripped on the fallback path).
    const cleanResponse = { ...response, text: parsed.text };

    let stored: StoredProposal | null = null;
    if (parsed.proposal && proposalSink && opts?.chatId && opts.turnTs !== undefined) {
      // Persisting runs the mandatory isInside(root)+.md security check; an
      // unsafe path returns null and the proposal is simply never queued.
      stored = await proposalSink(parsed.proposal, {
        chatId: opts.chatId,
        turnTs: opts.turnTs,
      });
    }

    return stored
      ? { ok: true, response: cleanResponse, grounding, proposal: stored }
      : { ok: true, response: cleanResponse, grounding };
  } catch (err) {
    // The single redaction boundary: only {variant, status} crosses IPC.
    return { ok: false, error: toSafeError(err) };
  }
}

export function aiGroundingStatus(): GroundingStatus {
  if (!grounder) {
    return {
      ready: false,
      indexing: false,
      notes: 0,
      chunks: 0,
      processed: 0,
      total: 0,
      notesTotal: 0,
    };
  }
  return grounder.status();
}

/**
 * Rebuild the grounder for `root`, wiring that vault's persistent index store.
 * Called at launch (once the active vault is known) and on every vault switch —
 * the index is vault-specific, so each vault gets its own saved vectors and they
 * never bleed across. The caller can then auto-reconcile if a saved index exists.
 */
export function resetGrounding(root: string | null = null): void {
  buildGrounder(root);
}

/**
 * Incrementally re-index one note (called by the watcher and by the app's own
 * save path). No-op until a full index exists, so a single change never builds
 * a misleading one-note index. Never throws.
 */
export async function reindexNote(absPath: string): Promise<void> {
  if (!grounder || !grounder.status().ready) return;
  await grounder.reindexNote(absPath);
}

/** Drop a deleted/renamed note from the index. No-op until indexed. */
export function removeNoteFromIndex(absPath: string): void {
  if (!grounder || !grounder.status().ready) return;
  grounder.removeNote(absPath);
}

/** The explicit "Index / Re-index" button. Routes through reconcile so it
 *  persists (D16): the first run is a full build + save; later runs reuse the
 *  saved vectors and only re-embed what changed. */
export function aiIndexVault(root: string): Promise<AiIndexResult> {
  return reconcileGrounding(root);
}
