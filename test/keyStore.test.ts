import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { KeyStore } from "../src/gateway/keyStore.js";
import { InMemoryKeychain } from "../src/gateway/keychain.js";
import { scrub, toSafeError, createScrubbingLogger } from "../src/gateway/redaction.js";
import { GatewayError } from "../src/gateway/errors.js";
import {
  encryptVault,
  decryptVault,
  generateMasterKey,
  VaultCryptoError,
} from "../src/gateway/crypto.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "sb-ks-"));
}

describe("crypto round-trip + tamper", () => {
  it("encrypt then decrypt recovers the plaintext", () => {
    const key = generateMasterKey();
    const blob = encryptVault(Buffer.from("hello vault"), key);
    expect(decryptVault(blob, key).toString()).toBe("hello vault");
  });

  it("a flipped byte fails authentication (Tampered)", () => {
    const key = generateMasterKey();
    const blob = encryptVault(Buffer.from("hello vault"), key);
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 0xff;
    expect(() => decryptVault(blob, key)).toThrow(VaultCryptoError);
  });

  it("a wrong key fails authentication", () => {
    const blob = encryptVault(Buffer.from("x"), generateMasterKey());
    expect(() => decryptVault(blob, generateMasterKey())).toThrow(VaultCryptoError);
  });
});

describe("KeyStore states (D5)", () => {
  it("opens ready when keychain available and no keys.enc yet", async () => {
    const dir = await tmpDir();
    const ks = await KeyStore.open({
      path: path.join(dir, "keys.enc"),
      keychain: new InMemoryKeychain(true),
    });
    expect(ks.state).toBe("ready");
    expect(ks.configuredProviders()).toEqual([]);
  });

  it("opens locked (no throw) when keychain unavailable", async () => {
    const dir = await tmpDir();
    const ks = await KeyStore.open({
      path: path.join(dir, "keys.enc"),
      keychain: new InMemoryKeychain(false),
    });
    expect(ks.state).toBe("locked");
    expect(ks.getKey("anthropic")).toBeUndefined();
  });

  it("persists a key across reopen with the same keychain", async () => {
    const dir = await tmpDir();
    const keychain = new InMemoryKeychain(true);
    const p = path.join(dir, "keys.enc");
    const ks1 = await KeyStore.open({ path: p, keychain });
    await ks1.setKey("anthropic", "sk-abc");
    const ks2 = await KeyStore.open({ path: p, keychain });
    expect(ks2.state).toBe("ready");
    expect(ks2.getKey("anthropic")).toBe("sk-abc");
  });

  it("fails closed as tampered when keys.enc is corrupt, without clobbering it", async () => {
    const dir = await tmpDir();
    const keychain = new InMemoryKeychain(true);
    const p = path.join(dir, "keys.enc");
    const ks1 = await KeyStore.open({ path: p, keychain });
    await ks1.setKey("anthropic", "sk-abc");

    const blob = await fs.readFile(p);
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 0xff;
    await fs.writeFile(p, blob);

    const ks2 = await KeyStore.open({ path: p, keychain });
    expect(ks2.state).toBe("tampered");
    expect(ks2.getKey("anthropic")).toBeUndefined();
    // The bad file is preserved for the user to inspect/re-key.
    expect(await fs.readFile(p)).toEqual(blob);
  });

  it("a locked store throws when asked to setKey", async () => {
    const dir = await tmpDir();
    const ks = await KeyStore.open({
      path: path.join(dir, "keys.enc"),
      keychain: new InMemoryKeychain(false),
    });
    await expect(ks.setKey("anthropic", "x")).rejects.toThrow();
  });
});

describe("redaction boundary (D6)", () => {
  it("scrub replaces secrets anywhere in a nested structure", () => {
    const out = scrub(
      { msg: "key is sk-XYZ here", arr: ["sk-XYZ"], n: 1 },
      ["sk-XYZ"]
    );
    expect(out).toEqual({ msg: "key is [REDACTED] here", arr: ["[REDACTED]"], n: 1 });
  });

  it("toSafeError collapses a GatewayError to variant+status only", () => {
    const safe = toSafeError(new GatewayError("RateLimited", { status: 429 }));
    expect(safe).toEqual({ variant: "RateLimited", status: 429 });
  });

  it("toSafeError collapses an unknown error to BadResponse with no free text", () => {
    const safe = toSafeError(new Error("secret stack trace with sk-XYZ"));
    expect(safe).toEqual({ variant: "BadResponse" });
  });

  it("the scrubbing logger never lets a live key reach the sink", () => {
    const lines: string[] = [];
    const sink = {
      warn: (m: string, meta?: Record<string, unknown>) =>
        lines.push(m + " " + JSON.stringify(meta ?? {})),
      error: (m: string, meta?: Record<string, unknown>) =>
        lines.push(m + " " + JSON.stringify(meta ?? {})),
    };
    const logger = createScrubbingLogger(() => ["sk-LIVE-KEY"], sink);
    logger.warn("calling with sk-LIVE-KEY", { auth: "Bearer sk-LIVE-KEY" });
    const joined = lines.join("\n");
    expect(joined).not.toContain("sk-LIVE-KEY");
    expect(joined).toContain("[REDACTED]");
  });
});
