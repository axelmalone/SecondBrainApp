import { GatewayError } from "./errors.js";
import type { Logger } from "./redaction.js";
import { createScrubbingLogger } from "./redaction.js";
import type { KeyStore } from "./keyStore.js";
import type {
  ChatRequest,
  ChatResponse,
  FetchLike,
  ProviderAdapter,
  ProviderId,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 500;

type Adapters = Partial<Record<ProviderId, ProviderAdapter>>;

export interface ModelGatewayOptions {
  keyStore: KeyStore;
  adapters: Adapters;
  fetchImpl: FetchLike;
  /** Per-attempt timeout (ms). The AbortController fires after this. */
  timeoutMs?: number;
  /** Retries AFTER the first attempt, applied only to retryable errors. */
  maxRetries?: number;
  /** Base for exponential backoff (ms). */
  baseDelayMs?: number;
  logger?: Logger;
  /** Injectable for tests so backoff sleeps are instant/deterministic. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to nondeterministic jitter. */
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The model gateway (D4). It owns provider routing, the per-attempt timeout,
 * and the retry/backoff loop. It NEVER retries anything other than Timeout and
 * RateLimited, and it fails fast — and without ever exposing a key — on
 * AuthFailed, QuotaExceeded, Refusal, and BadResponse.
 *
 * The API key is fetched from the KeyStore per call and handed to the adapter
 * only through ProviderContext; it never lives on the gateway and never reaches
 * the logger except through the scrubbing boundary.
 */
export class ModelGateway {
  private readonly keyStore: KeyStore;
  private readonly adapters: Adapters;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly logger: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(opts: ModelGatewayOptions) {
    this.keyStore = opts.keyStore;
    this.adapters = opts.adapters;
    this.fetchImpl = opts.fetchImpl;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.logger =
      opts.logger ?? createScrubbingLogger(() => this.keyStore.secrets());
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
  }

  /**
   * Send one chat request. Resolves with a normalized ChatResponse or throws a
   * typed GatewayError. The caller's signal (if any) cancels the whole call;
   * the per-attempt timeout cancels just that attempt.
   */
  async call(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const provider = req.model.provider;

    const adapter = this.adapters[provider];
    // A provider with no registered adapter is a programming error, not a
    // transient fault — fail fast, no retry.
    if (!adapter) {
      throw new GatewayError("BadResponse", {
        message: `no adapter registered for provider ${provider}`,
      });
    }

    const apiKey = this.keyStore.getKey(provider);
    // No key (or a locked/tampered store) → AuthFailed, fail fast. The app
    // still ran; this is the contracted "we have no credential" signal.
    if (!apiKey) {
      throw new GatewayError("AuthFailed");
    }

    let attempt = 0;
    for (;;) {
      try {
        return await this.attempt(adapter, req, apiKey, signal);
      } catch (err) {
        const gatewayErr =
          err instanceof GatewayError
            ? err
            : new GatewayError("BadResponse", { cause: err });

        const canRetry = gatewayErr.retryable && attempt < this.maxRetries;
        if (!canRetry) throw gatewayErr;

        attempt += 1;
        const delay = this.backoffMs(attempt);
        this.logger.warn("provider call retrying", {
          provider,
          attempt,
          variant: gatewayErr.variant,
          delayMs: delay,
        });
        await this.sleep(delay);
      }
    }
  }

  /** A single attempt with its own timeout, linked to the caller's signal. */
  private async attempt(
    adapter: ProviderAdapter,
    req: ChatRequest,
    apiKey: string,
    callerSignal?: AbortSignal
  ): Promise<ChatResponse> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();

    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener("abort", onAbort, { once: true });
    }

    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await adapter.send(req, {
        apiKey,
        fetch: this.fetchImpl,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      if (callerSignal) callerSignal.removeEventListener("abort", onAbort);
    }
  }

  /** Exponential backoff with +/-10% jitter. attempt is 1-based. */
  private backoffMs(attempt: number): number {
    const base = this.baseDelayMs * 2 ** (attempt - 1);
    const jitter = base * 0.1 * (this.random() * 2 - 1);
    return Math.max(0, Math.round(base + jitter));
  }
}
