// Shared AI data + IPC contract. Safe for the renderer to import: it carries
// NO provider code and NO secrets — only plain data shapes and the typed error
// variants the UI needs to branch on.

import type { StoredProposal } from "./proposal.js";

export type ProviderId = "anthropic" | "openai";

export interface ModelSpec {
  provider: ProviderId;
  model: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /**
   * (1A) Tool calls this assistant turn emitted. Set ONLY by the agentic loop
   * when it replays the assistant's tool-use turn back to the provider; the
   * renderer never sets this (it still only ever holds plain user/assistant
   * text). The adapters reconstruct each provider's tool-call shape from it (6A).
   */
  toolCalls?: ToolCall[];
  /**
   * (1A) The id of the tool call a `role: "tool"` message answers. Lets the
   * adapters key the result to its call (Anthropic `tool_use_id` / OpenAI
   * `tool_call_id`). Set ONLY by the agentic loop.
   */
  toolCallId?: string;
  /**
   * Prompt-caching hint: "cache everything up to and including this message."
   * Set on the LAST message of the STABLE prefix (policy + persona + goals) —
   * the span that is byte-identical across every turn — so a provider can reuse
   * it instead of reprocessing it each message. Provider-neutral: the Anthropic
   * adapter turns this into a `cache_control: {type:"ephemeral"}` breakpoint;
   * OpenAI caches automatically and ignores it. NEVER set it on a volatile
   * message (active-note, recent-activity, grounding, conversation) — that would
   * bust the cache every turn.
   */
  cacheBreakpoint?: boolean;
}

/**
 * A tool the model may call. Provider-neutral: the adapter maps this to the
 * Anthropic `tools` / OpenAI `function` shape. `inputSchema` is a JSON Schema
 * object describing the tool's arguments.
 */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * A tool invocation the model emitted. `input` is the raw parsed arguments
 * object — NOT yet validated against any app schema (that is parseProposal's
 * job). `id` is the provider's call id when present (Anthropic tool_use id /
 * OpenAI tool_call id), needed only if we ever return tool results.
 */
export interface ToolCall {
  id?: string;
  name: string;
  input: unknown;
}

export interface ChatRequest {
  model: ModelSpec;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Tools the model may call this turn (e.g. the propose-note-edit tool). */
  tools?: ToolSpec[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResponse {
  provider: ProviderId;
  model: string;
  text: string;
  usage?: TokenUsage;
  /** Tool calls the model emitted this turn (tool-use path). */
  toolCalls?: ToolCall[];
}

/** The gateway's typed error variants (D4). Mirrored here so the UI can branch. */
export type GatewayErrorVariant =
  | "Timeout"
  | "RateLimited"
  | "BadResponse"
  | "Refusal"
  | "AuthFailed"
  | "QuotaExceeded"
  // A proposal was attempted but failed schema validation even after one bounded
  // re-ask. The turn's text answer is discarded; nothing is ever applied.
  | "MalformedProposal";

/** The only error shape that crosses the IPC boundary (D6): no free text. */
export interface SafeError {
  variant: GatewayErrorVariant;
  status?: number;
}

// ---- IPC result types for the AI surface ----

export type KeyStoreState = "ready" | "locked" | "tampered";

export interface AiStatus {
  /** false when the keychain is unavailable or keys.enc is tampered. */
  keyStoreState: KeyStoreState;
  /** Which providers currently have a key configured. */
  configured: ProviderId[];
}

// ---- Grounding (D9 / D12) ----

/** A note that contributed an injected excerpt to a grounded answer. */
export interface GroundingSource {
  notePath: string;
  heading?: string;
}

/**
 * Why an answer was NOT grounded. D12: the UI shows a visible "answering
 * without vault context" badge for every one of these — the model still
 * answers, but the user is never fooled into thinking it used their notes.
 */
export type GroundingUnavailableReason =
  | "off" // grounding toggle was off
  | "not-indexed" // grounding on, but the vault hasn't been indexed yet
  | "empty-index" // index exists but holds no chunks
  | "embed-failed" // the query embedding failed
  | "no-matches"; // no chunk cleared the relevance threshold

/**
 * How a grounded answer was retrieved (mirrors the grounding layer's mode).
 * `keyword` = instant lexical/BM25 path used while embeddings backfill;
 * `semantic` = vector cosine; `hybrid` = fusion of both (deferred RRF path);
 * `agentic` = the model searched + opened notes itself via tools (the agentic
 * loop), so the `sources` are the notes it actually read — honest provenance.
 */
export type GroundingMode = "keyword" | "semantic" | "hybrid" | "agentic";

/** What the renderer needs to render the grounding badge on an answer. The
 *  `mode` lets the badge read "keyword match" vs "semantic" so the user knows
 *  whether the fast or the deep index answered. */
export type GroundingMeta =
  | { grounded: true; mode: GroundingMode; sources: GroundingSource[] }
  | { grounded: false; reason: GroundingUnavailableReason };

export interface AiSendOptions {
  /** When true, retrieve vault context and inject it before answering. */
  ground?: boolean;
  /**
   * (Strangler-fig) When true, answer via the AGENTIC loop — the model calls
   * read tools (search_vault / read_note) on demand instead of the one-shot
   * embedding injection. Default false: the embedding path stays the default
   * until agentic is proven, then the default flips.
   */
  agentic?: boolean;
  /** The chat this turn belongs to — backref stored with any proposal. */
  chatId?: string;
  /** The timestamp of the user turn — backref stored with any proposal. */
  turnTs?: number;
  /**
   * Absolute path of the note open in the editor this turn (1B). Validated
   * (isInside + .md) before its name is used to label the injected context.
   * Stateless: the renderer supplies it on every send.
   */
  activeNotePath?: string;
  /**
   * The LIVE editor buffer for the active note (eng-review F3). Sent alongside
   * activeNotePath so the assistant sees what the user is actually typing —
   * including a brand-new or unsaved note — instead of a stale on-disk read.
   */
  activeNoteText?: string;
}

// ---- Assistant bootstrap (Phase 1B) ----

/** The scripted setup form the user fills before the one-shot bootstrap draft. */
export interface AssistantBootstrapForm {
  /** Their role / who they are. */
  role: string;
  /** What they're currently working on. */
  projects: string;
  /** How they want the assistant to help. */
  help: string;
  /** Where they're headed — goals / direction (1C). Optional. */
  goals?: string;
}

/** Persona-file freshness, surfaced so the UI can nudge a stale profile (1C). */
export interface PersonaFileStatus {
  /** True when `_assistant.md` exists at the vault root. */
  exists: boolean;
  /** Whole days since it was last modified (0 when it doesn't exist). */
  ageDays: number;
  /** True when it exists and hasn't been touched in weeks — time for a refresh. */
  stale: boolean;
}

/**
 * Result of the bootstrap turn. On success the model proposed an `_assistant.md`
 * create through the normal approval queue (the user still reviews + approves);
 * `proposal` is absent only if the model declined to propose (rare).
 */
export type AssistantBootstrapResult =
  | { ok: true; proposal?: StoredProposal }
  | { ok: false; error: SafeError };

export type AiSendResult =
  | {
      ok: true;
      response: ChatResponse;
      grounding: GroundingMeta;
      /** Present when the model proposed a vault edit this turn (CQ2-A). */
      proposal?: StoredProposal;
    }
  | { ok: false; error: SafeError };

export type AiSetKeyResult = { ok: true } | { ok: false; error: SafeError };

export interface GroundingStatus {
  /** True once the vault is answerable — EITHER the instant lexical index OR the
   *  vector index holds chunks. Lexical fills almost immediately, so this flips
   *  true long before embedding finishes. */
  ready: boolean;
  /** True once the vector (embedding) index holds chunks — i.e. semantic
   *  retrieval is available, not just keyword. False during a cold backfill. */
  semanticReady: boolean;
  /** A full re-index is currently running. */
  indexing: boolean;
  notes: number;
  chunks: number;
  /** Live progress during a re-index: chunks embedded so far / total to embed. */
  processed: number;
  total: number;
  /** Total notes being indexed (chunks are pieces of these — for a clear label). */
  notesTotal: number;
}

export type AiIndexResult =
  | { ok: true; notes: number; chunks: number }
  | { ok: false; message: string };
