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
  role: "system" | "user" | "assistant";
  content: string;
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

/** What the renderer needs to render the grounding badge on an answer. */
export type GroundingMeta =
  | { grounded: true; sources: GroundingSource[] }
  | { grounded: false; reason: GroundingUnavailableReason };

export interface AiSendOptions {
  /** When true, retrieve vault context and inject it before answering. */
  ground?: boolean;
  /** The chat this turn belongs to — backref stored with any proposal. */
  chatId?: string;
  /** The timestamp of the user turn — backref stored with any proposal. */
  turnTs?: number;
}

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
  /** True once at least one chunk is indexed and ready to query. */
  ready: boolean;
  /** A full re-index is currently running. */
  indexing: boolean;
  notes: number;
  chunks: number;
  /** Live progress during a re-index: chunks embedded so far / total to embed. */
  processed: number;
  total: number;
}

export type AiIndexResult =
  | { ok: true; notes: number; chunks: number }
  | { ok: false; message: string };
