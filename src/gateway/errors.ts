// The gateway's typed error contract (D4). Every provider failure maps to
// exactly one of these variants — never a catch-all. Retry/backoff happens
// ONLY on Timeout and RateLimited; all others fail fast.
//
// A GatewayError NEVER carries an API key, a request body, or an Authorization
// header. Messages are constructed by us from fixed strings; the redaction
// boundary (redaction.ts) is the second line of defence.

import type { GatewayErrorVariant, SafeError } from "../shared/ai.js";
export type { GatewayErrorVariant, SafeError } from "../shared/ai.js";

export interface GatewayErrorOptions {
  status?: number;
  message?: string;
  cause?: unknown;
}

export class GatewayError extends Error {
  readonly variant: GatewayErrorVariant;
  readonly status?: number;

  constructor(variant: GatewayErrorVariant, options: GatewayErrorOptions = {}) {
    super(
      options.message ?? variant,
      options.cause !== undefined ? { cause: options.cause } : undefined
    );
    this.name = "GatewayError";
    this.variant = variant;
    if (options.status !== undefined) this.status = options.status;
  }

  /** Only Timeout and RateLimited are retryable (D4). */
  get retryable(): boolean {
    return this.variant === "Timeout" || this.variant === "RateLimited";
  }

  /** The redacted, IPC-safe projection: variant (+status) only. */
  toSafe(): SafeError {
    return this.status !== undefined
      ? { variant: this.variant, status: this.status }
      : { variant: this.variant };
  }
}
