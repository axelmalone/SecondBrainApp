import { GatewayError, type SafeError } from "./errors.js";

const REDACTED = "[REDACTED]";

/**
 * Recursively replace any occurrence of a known secret (an API key) inside a
 * value with [REDACTED]. Defence-in-depth for the one place we ever log a raw
 * provider response body: even if a provider were to echo a key, it never
 * reaches a log or an emitted event in the clear.
 */
export function scrub<T>(value: T, secrets: readonly string[]): T {
  const active = secrets.filter((s) => s.length > 0);
  if (active.length === 0) return value;

  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      let out = v;
      for (const secret of active) out = out.split(secret).join(REDACTED);
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const result: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) result[k] = walk(val);
      return result;
    }
    return v;
  };

  return walk(value) as T;
}

/**
 * The single redaction boundary (D6). Anything emitted across IPC or logged
 * must pass through here first: a GatewayError collapses to {variant, status};
 * anything else collapses to a generic BadResponse with no free text, so an
 * unexpected internal error can never leak a stack trace or a key.
 */
export function toSafeError(err: unknown): SafeError {
  if (err instanceof GatewayError) return err.toSafe();
  return { variant: "BadResponse" };
}

export interface Logger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * A logger that scrubs every message and metadata object against the currently
 * active secrets before it reaches the sink. `getSecrets` is a thunk so the set
 * reflects keys added/removed at runtime.
 */
export function createScrubbingLogger(
  getSecrets: () => readonly string[],
  sink: Logger = console
): Logger {
  const emit =
    (level: "warn" | "error") =>
    (message: string, meta?: Record<string, unknown>): void => {
      const secrets = getSecrets();
      sink[level](
        scrub(message, secrets),
        meta ? scrub(meta, secrets) : undefined
      );
    };
  return { warn: emit("warn"), error: emit("error") };
}
