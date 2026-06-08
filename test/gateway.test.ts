import { describe, it, expect } from "vitest";
import { ModelGateway } from "../src/gateway/gateway.js";
import { GatewayError } from "../src/gateway/errors.js";
import { KeyStore } from "../src/gateway/keyStore.js";
import { InMemoryKeychain } from "../src/gateway/keychain.js";
import { anthropicAdapter } from "../src/gateway/providers/anthropic.js";
import { openaiAdapter } from "../src/gateway/providers/openai.js";
import type { FetchLike, ProviderAdapter } from "../src/gateway/types.js";
import type { ChatRequest } from "../src/shared/ai.js";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const noSleep = async (): Promise<void> => {};

async function tmpKeysPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-keys-"));
  return path.join(dir, "keys.enc");
}

/** A KeyStore with a single anthropic key, backed by an in-memory keychain. */
async function readyKeyStore(
  provider: "anthropic" | "openai" = "anthropic"
): Promise<KeyStore> {
  const ks = await KeyStore.open({
    path: await tmpKeysPath(),
    keychain: new InMemoryKeychain(true),
  });
  await ks.setKey(provider, "sk-secret-key-123");
  return ks;
}

/** Build a fetch that returns a fixed status + body. */
function fixedFetch(status: number, body: string): FetchLike {
  return async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } });
}

const anthropicOk = JSON.stringify({
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 3, output_tokens: 1 },
});

const req: ChatRequest = {
  model: { provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
  messages: [{ role: "user", content: "hi" }],
};

describe("ModelGateway routing + auth", () => {
  it("returns a normalized response on success", async () => {
    const gw = new ModelGateway({
      keyStore: await readyKeyStore(),
      adapters: { anthropic: anthropicAdapter },
      fetchImpl: fixedFetch(200, anthropicOk),
      sleep: noSleep,
    });
    const res = await gw.call(req);
    expect(res.text).toBe("hello");
    expect(res.provider).toBe("anthropic");
    expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 1 });
  });

  it("AuthFails (no retry) when no key is configured", async () => {
    const ks = await KeyStore.open({
      path: await tmpKeysPath(),
      keychain: new InMemoryKeychain(true),
    });
    let calls = 0;
    const gw = new ModelGateway({
      keyStore: ks,
      adapters: { anthropic: anthropicAdapter },
      fetchImpl: async () => {
        calls += 1;
        return new Response("", { status: 200 });
      },
      sleep: noSleep,
    });
    await expect(gw.call(req)).rejects.toMatchObject({ variant: "AuthFailed" });
    expect(calls).toBe(0); // never even hit the network
  });

  it("BadResponse when the provider has no registered adapter", async () => {
    const gw = new ModelGateway({
      keyStore: await readyKeyStore("openai"),
      adapters: {}, // openai not registered
      fetchImpl: fixedFetch(200, anthropicOk),
      sleep: noSleep,
    });
    await expect(
      gw.call({ ...req, model: { provider: "openai", model: "gpt-4o" } })
    ).rejects.toMatchObject({ variant: "BadResponse" });
  });
});

describe("ModelGateway retry policy (D4)", () => {
  function flakeyAdapter(
    failVariant: GatewayError,
    successAfter: number
  ): { adapter: ProviderAdapter; attempts: () => number } {
    let attempts = 0;
    const adapter: ProviderAdapter = {
      id: "anthropic",
      async send() {
        attempts += 1;
        if (attempts <= successAfter) throw failVariant;
        return { provider: "anthropic", model: "m", text: "ok" };
      },
    };
    return { adapter, attempts: () => attempts };
  }

  it("retries Timeout up to maxRetries then succeeds", async () => {
    const { adapter, attempts } = flakeyAdapter(
      new GatewayError("Timeout"),
      2
    );
    const gw = new ModelGateway({
      keyStore: await readyKeyStore(),
      adapters: { anthropic: adapter },
      fetchImpl: fixedFetch(200, anthropicOk),
      maxRetries: 2,
      sleep: noSleep,
    });
    const res = await gw.call(req);
    expect(res.text).toBe("ok");
    expect(attempts()).toBe(3); // 1 + 2 retries
  });

  it("retries RateLimited", async () => {
    const { adapter, attempts } = flakeyAdapter(
      new GatewayError("RateLimited", { status: 429 }),
      1
    );
    const gw = new ModelGateway({
      keyStore: await readyKeyStore(),
      adapters: { anthropic: adapter },
      fetchImpl: fixedFetch(200, anthropicOk),
      maxRetries: 2,
      sleep: noSleep,
    });
    await expect(gw.call(req)).resolves.toMatchObject({ text: "ok" });
    expect(attempts()).toBe(2);
  });

  it("gives up after maxRetries on persistent Timeout", async () => {
    const { adapter, attempts } = flakeyAdapter(
      new GatewayError("Timeout"),
      99
    );
    const gw = new ModelGateway({
      keyStore: await readyKeyStore(),
      adapters: { anthropic: adapter },
      fetchImpl: fixedFetch(200, anthropicOk),
      maxRetries: 2,
      sleep: noSleep,
    });
    await expect(gw.call(req)).rejects.toMatchObject({ variant: "Timeout" });
    expect(attempts()).toBe(3);
  });

  it("does NOT retry AuthFailed / QuotaExceeded / Refusal / BadResponse", async () => {
    for (const variant of [
      "AuthFailed",
      "QuotaExceeded",
      "Refusal",
      "BadResponse",
    ] as const) {
      const { adapter, attempts } = flakeyAdapter(
        new GatewayError(variant),
        99
      );
      const gw = new ModelGateway({
        keyStore: await readyKeyStore(),
        adapters: { anthropic: adapter },
        fetchImpl: fixedFetch(200, anthropicOk),
        maxRetries: 2,
        sleep: noSleep,
      });
      await expect(gw.call(req)).rejects.toMatchObject({ variant });
      expect(attempts()).toBe(1); // fail fast
    }
  });
});

describe("provider error mapping — anthropic", () => {
  const cases: Array<[number, string, string]> = [
    [401, "{}", "AuthFailed"],
    [429, "{}", "RateLimited"],
    [529, "{}", "Timeout"],
    [503, "{}", "Timeout"],
    [400, '{"error":{"message":"credit balance too low"}}', "QuotaExceeded"],
    [403, '{"type":"billing_error"}', "QuotaExceeded"],
    [400, "{}", "BadResponse"],
  ];
  for (const [status, body, variant] of cases) {
    it(`maps ${status} → ${variant}`, async () => {
      const gw = new ModelGateway({
        keyStore: await readyKeyStore(),
        adapters: { anthropic: anthropicAdapter },
        fetchImpl: fixedFetch(status, body),
        sleep: noSleep,
        maxRetries: 0,
      });
      await expect(gw.call(req)).rejects.toMatchObject({ variant });
    });
  }

  it("maps stop_reason refusal → Refusal", async () => {
    const gw = new ModelGateway({
      keyStore: await readyKeyStore(),
      adapters: { anthropic: anthropicAdapter },
      fetchImpl: fixedFetch(
        200,
        JSON.stringify({ content: [{ type: "text", text: "" }], stop_reason: "refusal" })
      ),
      sleep: noSleep,
    });
    await expect(gw.call(req)).rejects.toMatchObject({ variant: "Refusal" });
  });
});

describe("provider error mapping — openai", () => {
  const oReq: ChatRequest = {
    model: { provider: "openai", model: "gpt-4o" },
    messages: [{ role: "user", content: "hi" }],
  };
  const cases: Array<[number, string, string]> = [
    [401, "{}", "AuthFailed"],
    [429, '{"error":{"code":"rate_limit_exceeded"}}', "RateLimited"],
    [429, '{"error":{"code":"insufficient_quota"}}', "QuotaExceeded"],
    [500, "{}", "Timeout"],
    [400, "{}", "BadResponse"],
  ];
  for (const [status, body, variant] of cases) {
    it(`maps ${status} → ${variant}`, async () => {
      const gw = new ModelGateway({
        keyStore: await readyKeyStore("openai"),
        adapters: { openai: openaiAdapter },
        fetchImpl: fixedFetch(status, body),
        sleep: noSleep,
        maxRetries: 0,
      });
      await expect(gw.call(oReq)).rejects.toMatchObject({ variant });
    });
  }

  it("maps finish_reason content_filter → Refusal", async () => {
    const gw = new ModelGateway({
      keyStore: await readyKeyStore("openai"),
      adapters: { openai: openaiAdapter },
      fetchImpl: fixedFetch(
        200,
        JSON.stringify({
          choices: [{ message: { content: "" }, finish_reason: "content_filter" }],
        })
      ),
      sleep: noSleep,
    });
    await expect(gw.call(oReq)).rejects.toMatchObject({ variant: "Refusal" });
  });

  it("returns text + usage on success", async () => {
    const gw = new ModelGateway({
      keyStore: await readyKeyStore("openai"),
      adapters: { openai: openaiAdapter },
      fetchImpl: fixedFetch(
        200,
        JSON.stringify({
          choices: [{ message: { content: "hey" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        })
      ),
      sleep: noSleep,
    });
    const res = await gw.call(oReq);
    expect(res.text).toBe("hey");
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
  });
});

describe("transport failures classify as Timeout", () => {
  it("a thrown fetch becomes a (retryable) Timeout", async () => {
    let attempts = 0;
    const gw = new ModelGateway({
      keyStore: await readyKeyStore(),
      adapters: { anthropic: anthropicAdapter },
      fetchImpl: async () => {
        attempts += 1;
        throw new TypeError("network down");
      },
      maxRetries: 1,
      sleep: noSleep,
    });
    await expect(gw.call(req)).rejects.toMatchObject({ variant: "Timeout" });
    expect(attempts).toBe(2);
  });
});
