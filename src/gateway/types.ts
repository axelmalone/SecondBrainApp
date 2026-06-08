import type {
  ChatRequest,
  ChatResponse,
  ProviderId,
} from "../shared/ai.js";

export type {
  ProviderId,
  ModelSpec,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  TokenUsage,
} from "../shared/ai.js";

/** The subset of fetch the adapters use; injectable so tests need no network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** What the gateway hands an adapter for a single attempt. */
export interface ProviderContext {
  apiKey: string;
  fetch: FetchLike;
  /** Aborted when the gateway's per-attempt timeout fires or the caller cancels. */
  signal: AbortSignal;
}

/**
 * A provider adapter is the ONLY code that knows a given provider's HTTP shape.
 * It returns a normalized ChatResponse or throws a typed GatewayError — it must
 * never throw a raw network/parse error past its own boundary.
 */
export interface ProviderAdapter {
  readonly id: ProviderId;
  send(req: ChatRequest, ctx: ProviderContext): Promise<ChatResponse>;
}
