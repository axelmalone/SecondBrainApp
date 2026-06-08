// Shared AI data + IPC contract. Safe for the renderer to import: it carries
// NO provider code and NO secrets — only plain data shapes and the typed error
// variants the UI needs to branch on.

export type ProviderId = "anthropic" | "openai";

export interface ModelSpec {
  provider: ProviderId;
  model: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: ModelSpec;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
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
}

/** The gateway's typed error variants (D4). Mirrored here so the UI can branch. */
export type GatewayErrorVariant =
  | "Timeout"
  | "RateLimited"
  | "BadResponse"
  | "Refusal"
  | "AuthFailed"
  | "QuotaExceeded";

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

/** What the renderer needs to render the grounding badge on an answer. */
export type GroundingMeta =
  | { grounded: true; sources: GroundingSource[] }
  | { grounded: false; reason: GroundingUnavailableReason };

export interface AiSendOptions {
  /** When true, retrieve vault context and inject it before answering. */
  ground?: boolean;
}

export type AiSendResult =
  | { ok: true; response: ChatResponse; grounding: GroundingMeta }
  | { ok: false; error: SafeError };

export type AiSetKeyResult = { ok: true } | { ok: false; error: SafeError };

export interface GroundingStatus {
  /** True once at least one chunk is indexed and ready to query. */
  ready: boolean;
  /** A full re-index is currently running. */
  indexing: boolean;
  notes: number;
  chunks: number;
}

export type AiIndexResult =
  | { ok: true; notes: number; chunks: number }
  | { ok: false; message: string };
