import { GatewayError } from "../errors.js";
import type { ProviderContext } from "../types.js";

export interface RawHttpResult {
  status: number;
  ok: boolean;
  text: string;
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "AbortError"
  );
}

/**
 * POST JSON and return the raw status + body text. Transport-level failures
 * (abort/timeout, DNS, connection reset) are all classified as Timeout — they
 * are transient and retryable. HTTP status classification is left to the
 * caller, which knows the provider's error shape.
 */
export async function postJson(
  ctx: ProviderContext,
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<RawHttpResult> {
  let res: Response;
  try {
    res = await ctx.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw new GatewayError("Timeout", { cause: err });
    }
    throw new GatewayError("Timeout", {
      message: "transport failure",
      cause: err,
    });
  }

  let text = "";
  try {
    text = await res.text();
  } catch {
    text = "";
  }
  return { status: res.status, ok: res.ok, text };
}

/** Parse a JSON body or throw BadResponse — never leak the parse error text. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new GatewayError("BadResponse", {
      message: "unparseable provider response",
      cause: err,
    });
  }
}
