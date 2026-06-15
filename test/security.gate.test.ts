import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ModelGateway } from "../src/gateway/gateway.js";
import { KeyStore } from "../src/gateway/keyStore.js";
import { InMemoryKeychain } from "../src/gateway/keychain.js";
import { anthropicAdapter } from "../src/gateway/providers/anthropic.js";
import { GatewayError } from "../src/gateway/errors.js";
import {
  scrub,
  toSafeError,
  createScrubbingLogger,
  type Logger,
} from "../src/gateway/redaction.js";
import type { FetchLike } from "../src/gateway/types.js";
import type { ChatRequest } from "../src/shared/ai.js";

/**
 * The D13 security/auth hardening gate — the BYO-key trust boundary. The
 * crypto/keystore/redaction UNITS are covered in keyStore.test.ts (D5 states,
 * fail-closed-no-clobber, tamper, scrub/toSafeError/scrubbing-logger); this file
 * locks the END-TO-END contract: a raw API key NEVER reaches a log, an emitted
 * event, or a returned error — even when a provider echoes it back to us.
 */
const LIVE_KEY = "sk-LIVE-SECRET-key-abc123";

async function keyStoreWithKey(): Promise<KeyStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-sec-"));
  const ks = await KeyStore.open({
    path: path.join(dir, "keys.enc"),
    keychain: new InMemoryKeychain(true),
  });
  await ks.setKey("anthropic", LIVE_KEY);
  return ks;
}

const req: ChatRequest = {
  model: { provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
  messages: [{ role: "user", content: "hi" }],
};

function fixedFetch(status: number, body: string): FetchLike {
  return async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } });
}

/** A logger sink that records every line + meta as flat strings. */
function recordingLogger(secrets: () => readonly string[]): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (m: string, meta?: Record<string, unknown>): void => {
    lines.push(m + " " + JSON.stringify(meta ?? {}));
  };
  const sink: Logger = { warn: push, error: push };
  return { logger: createScrubbingLogger(secrets, sink), lines };
}

describe("D13 gate — no raw key in any log/event/error (gateway)", () => {
  it("a provider 5xx that ECHOES the key never leaks it (logs or thrown error)", async () => {
    const ks = await keyStoreWithKey();
    const { logger, lines } = recordingLogger(() => ks.secrets());
    // Provider 500 whose body echoes the caller's key back at us.
    const gw = new ModelGateway({
      keyStore: ks,
      adapters: { anthropic: anthropicAdapter },
      fetchImpl: fixedFetch(500, JSON.stringify({ error: `bad key ${LIVE_KEY}` })),
      logger,
      sleep: async () => {},
      maxRetries: 1,
    });

    let thrown: unknown;
    try {
      await gw.call(req);
    } catch (err) {
      thrown = err;
    }

    // (1) the retry log must not carry the key.
    const logged = lines.join("\n");
    expect(logged).not.toContain(LIVE_KEY);
    // (2) the thrown error is typed; its safe form is {variant, status?} only.
    expect(thrown).toBeInstanceOf(GatewayError);
    const safe = toSafeError(thrown);
    expect(JSON.stringify(safe)).not.toContain(LIVE_KEY);
    // The safe error carries ONLY variant (+ optional status) — no body/free text.
    expect(Object.keys(safe).every((k) => k === "variant" || k === "status")).toBe(true);
    expect(safe.variant).toBe("Timeout"); // 5xx classifies as retryable Timeout
  });

  it("the retry log meta is exactly the safe fields (no request, body, or key)", async () => {
    const ks = await keyStoreWithKey();
    const { logger, lines } = recordingLogger(() => ks.secrets());
    const gw = new ModelGateway({
      keyStore: ks,
      adapters: { anthropic: anthropicAdapter },
      fetchImpl: fixedFetch(529, "overloaded"),
      logger,
      sleep: async () => {},
      maxRetries: 1,
    });
    await gw.call(req).catch(() => {});
    const retry = lines.find((l) => l.startsWith("provider call retrying"));
    expect(retry).toBeDefined();
    // Only these keys are ever logged — adding the request/response here would
    // be the leak this test guards against.
    const meta = JSON.parse(retry!.slice("provider call retrying ".length));
    expect(Object.keys(meta).sort()).toEqual(["attempt", "delayMs", "provider", "variant"]);
  });

  it("a non-retryable provider error (401) returns a typed error, never retries, never logs", async () => {
    const ks = await keyStoreWithKey();
    const { logger, lines } = recordingLogger(() => ks.secrets());
    const gw = new ModelGateway({
      keyStore: ks,
      adapters: { anthropic: anthropicAdapter },
      fetchImpl: fixedFetch(401, JSON.stringify({ error: { message: `invalid ${LIVE_KEY}` } })),
      logger,
      sleep: async () => {},
      maxRetries: 2,
    });
    const safe = await gw.call(req).then(() => null, (e) => toSafeError(e));
    expect(safe).toEqual({ variant: "AuthFailed", status: 401 });
    expect(lines).toHaveLength(0); // no retry log for a non-retryable error
  });
});

describe("D13 gate — redaction boundary edge cases (D6)", () => {
  it("scrub is a no-op (and never crashes) with empty / whitespace secrets", () => {
    expect(scrub({ a: "sk-x" }, [])).toEqual({ a: "sk-x" });
    expect(scrub("plain", [""])).toBe("plain"); // empty secret filtered out
  });

  it("scrub removes every distinct secret across nested structures", () => {
    const out = scrub(
      { headers: { auth: "Bearer sk-A" }, list: ["sk-B", { deep: "sk-A and sk-B" }] },
      ["sk-A", "sk-B"]
    );
    expect(JSON.stringify(out)).not.toContain("sk-A");
    expect(JSON.stringify(out)).not.toContain("sk-B");
  });

  it("toSafeError NEVER carries free text, for every error shape", () => {
    expect(toSafeError(new Error(`stack with ${LIVE_KEY}`))).toEqual({ variant: "BadResponse" });
    expect(toSafeError(`raw string ${LIVE_KEY}`)).toEqual({ variant: "BadResponse" });
    expect(toSafeError({ message: LIVE_KEY })).toEqual({ variant: "BadResponse" });
    expect(toSafeError(null)).toEqual({ variant: "BadResponse" });
    expect(toSafeError(new GatewayError("QuotaExceeded", { status: 402 }))).toEqual({
      variant: "QuotaExceeded",
      status: 402,
    });
  });
});
