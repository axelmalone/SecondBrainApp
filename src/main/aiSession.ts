import { ModelGateway } from "../gateway/gateway.js";
import { KeyStore } from "../gateway/keyStore.js";
import { anthropicAdapter } from "../gateway/providers/anthropic.js";
import { openaiAdapter } from "../gateway/providers/openai.js";
import { createScrubbingLogger, toSafeError } from "../gateway/redaction.js";
import { GroundingService } from "../grounding/vaultIndexer.js";
import { TransformersEmbedder } from "../grounding/embedderTransformers.js";
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

/**
 * Build the AI layer at app start. This MUST NOT throw — a broken keychain or a
 * tampered keys.enc leaves the store "locked"/"tampered" but the app still
 * opens (D5). Any unexpected error here is swallowed so the editor launches.
 */
export async function initAi(opts: {
  keysPath: string;
  keychainBlobPath: string;
}): Promise<void> {
  try {
    const keychain = new ElectronKeychain(opts.keychainBlobPath);
    keyStore = await KeyStore.open({ path: opts.keysPath, keychain });
    const logger = createScrubbingLogger(() => keyStore?.secrets() ?? []);
    gateway = new ModelGateway({
      keyStore,
      adapters: { anthropic: anthropicAdapter, openai: openaiAdapter },
      fetchImpl: (url, init) => fetch(url, init),
      logger,
    });
    // The embedder is cheap to construct; the model only loads on first index.
    grounder = new GroundingService(new TransformersEmbedder());
  } catch {
    keyStore = null;
    gateway = null;
    grounder = null;
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

function dedupeSources(
  chunks: { notePath: string; heading?: string }[]
): GroundingMeta {
  const seen = new Set<string>();
  const sources: { notePath: string; heading?: string }[] = [];
  for (const c of chunks) {
    if (seen.has(c.notePath)) continue;
    seen.add(c.notePath);
    sources.push(c.heading !== undefined ? { notePath: c.notePath, heading: c.heading } : { notePath: c.notePath });
  }
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
    return { messages, grounding: dedupeSources(result.chunks) };
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
  try {
    const response = await gateway.call({ ...req, messages });
    return { ok: true, response, grounding };
  } catch (err) {
    // The single redaction boundary: only {variant, status} crosses IPC.
    return { ok: false, error: toSafeError(err) };
  }
}

export function aiGroundingStatus(): GroundingStatus {
  if (!grounder) {
    return { ready: false, indexing: false, notes: 0, chunks: 0 };
  }
  return grounder.status();
}

/**
 * Drop the in-memory grounding index and start fresh. Called when the user
 * switches vaults — the index is vault-specific, so stale vectors must never
 * bleed from one vault into another. The user re-indexes the new vault on demand.
 */
export function resetGrounding(): void {
  try {
    grounder = new GroundingService(new TransformersEmbedder());
  } catch {
    grounder = null;
  }
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

export async function aiIndexVault(root: string): Promise<AiIndexResult> {
  if (!grounder) return { ok: false, message: "grounding is unavailable" };
  try {
    const { notes, chunks } = await grounder.indexVault(root);
    return { ok: true, notes, chunks };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "indexing failed",
    };
  }
}
