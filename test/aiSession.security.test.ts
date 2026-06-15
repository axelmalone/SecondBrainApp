import { describe, it, expect, vi } from "vitest";

// aiSession's import chain reaches `electron` (utilityProcess via utilityEmbedder,
// safeStorage via keychainElectron). Stub it so the boundary can be exercised
// headlessly; the real keychain is replaced per-test with an in-memory one.
vi.mock("electron", () => ({
  utilityProcess: {
    fork: () => ({ on: () => {}, postMessage: () => {}, kill: () => {}, pid: 1 }),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8"),
  },
  app: { getPath: () => "/tmp", getName: () => "test", setName: () => {} },
}));

import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { initAi, aiStatus, aiSetKey } from "../src/main/aiSession.js";
import { InMemoryKeychain } from "../src/gateway/keychain.js";

async function tmpDirs(): Promise<{
  keysPath: string;
  keychainBlobPath: string;
  groundingDir: string;
  personaDir: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-ai-sec-"));
  return {
    keysPath: path.join(dir, "keys.enc"),
    keychainBlobPath: path.join(dir, "master.key.enc"),
    groundingDir: path.join(dir, "grounding"),
    personaDir: path.join(dir, "persona"),
  };
}

/**
 * D13 gate — the aiSession IPC boundary. initAi must NEVER throw (a broken/locked
 * keychain or a tampered keys.enc still lets the editor open), and the key
 * surfaces (aiStatus / aiSetKey) must return typed results, never leak, never
 * crash. The crypto/keystore units are in keyStore.test.ts; this is the
 * end-to-end contract through the functions the renderer actually calls.
 */
describe("D13 gate — aiSession auth boundary", () => {
  it("keychain unavailable → initAi never throws; status 'locked'; setKey returns a safe error", async () => {
    const d = await tmpDirs();
    await expect(
      initAi({ ...d, keychain: new InMemoryKeychain(false) })
    ).resolves.toBeUndefined(); // app still opens
    expect(aiStatus().keyStoreState).toBe("locked");

    const res = await aiSetKey("anthropic", "sk-should-not-persist");
    expect(res.ok).toBe(false);
    // Typed error only — no free text / no leaked key.
    if (!res.ok) {
      expect(typeof res.error.variant).toBe("string");
      expect(JSON.stringify(res.error)).not.toContain("sk-should-not-persist");
    }
  });

  it("tampered keys.enc → fail closed ('tampered'), app still opens", async () => {
    const d = await tmpDirs();
    const keychain = new InMemoryKeychain(true); // same instance keeps the master key

    await initAi({ ...d, keychain });
    expect(aiStatus().keyStoreState).toBe("ready");
    expect(await aiSetKey("anthropic", "sk-abc")).toEqual({ ok: true });

    // Corrupt the on-disk encrypted store.
    const blob = await fs.readFile(d.keysPath);
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 0xff;
    await fs.writeFile(d.keysPath, blob);

    // Reopen → fail closed, but the app still comes up.
    await expect(initAi({ ...d, keychain })).resolves.toBeUndefined();
    expect(aiStatus().keyStoreState).toBe("tampered");
  });

  it("ready keychain → setKey succeeds and is reflected in status", async () => {
    const d = await tmpDirs();
    await initAi({ ...d, keychain: new InMemoryKeychain(true) });
    expect(aiStatus().keyStoreState).toBe("ready");
    expect(await aiSetKey("anthropic", "sk-abc")).toEqual({ ok: true });
    expect(aiStatus().configured).toContain("anthropic");
  });
});
