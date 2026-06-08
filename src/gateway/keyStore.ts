import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import {
  decryptVault,
  encryptVault,
  generateMasterKey,
} from "./crypto.js";
import type { KeychainAdapter } from "./keychain.js";
import type { KeyStoreState, ProviderId } from "../shared/ai.js";

type ProviderKeys = Partial<Record<ProviderId, string>>;

export interface KeyStoreOptions {
  /** Path to keys.enc. */
  path: string;
  keychain: KeychainAdapter;
}

/**
 * Holds the BYO provider keys, decrypted in memory. The AES master key lives in
 * the OS keychain; keys.enc is the AES-256-GCM ciphertext on disk.
 *
 * D5 failure behaviour — the app must ALWAYS open:
 *  - keychain unavailable / master key unobtainable → state "locked": no keys,
 *    every AI call will AuthFail, but open() does not throw.
 *  - keys.enc tampered (auth tag fails) → state "tampered": fail closed (no keys
 *    loaded), open() does not throw, and the bad file is NOT overwritten until
 *    the user deliberately re-keys.
 */
export class KeyStore {
  private constructor(
    private readonly filePath: string,
    private readonly keychain: KeychainAdapter,
    private readonly masterKey: Buffer | null,
    private keys: ProviderKeys,
    private stateValue: KeyStoreState
  ) {}

  get state(): KeyStoreState {
    return this.stateValue;
  }

  static async open(options: KeyStoreOptions): Promise<KeyStore> {
    const { path: filePath, keychain } = options;

    if (!keychain.isAvailable()) {
      return new KeyStore(filePath, keychain, null, {}, "locked");
    }

    // Obtain (or first-run create) the master key. Any keychain failure → locked.
    let masterKey: Buffer | null;
    try {
      masterKey = await keychain.getMasterKey();
      if (!masterKey) {
        masterKey = generateMasterKey();
        await keychain.setMasterKey(masterKey);
      }
    } catch {
      return new KeyStore(filePath, keychain, null, {}, "locked");
    }

    // Load existing keys.enc, if any.
    let blob: Buffer;
    try {
      blob = await fs.readFile(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return new KeyStore(filePath, keychain, masterKey, {}, "ready");
      }
      // Unreadable for some other reason — fail closed but stay open.
      return new KeyStore(filePath, keychain, masterKey, {}, "tampered");
    }

    try {
      const plain = decryptVault(blob, masterKey);
      const keys = JSON.parse(plain.toString("utf8")) as ProviderKeys;
      return new KeyStore(filePath, keychain, masterKey, keys, "ready");
    } catch {
      // Tamper / corruption / wrong key → fail closed, do NOT clobber the file.
      return new KeyStore(filePath, keychain, masterKey, {}, "tampered");
    }
  }

  getKey(provider: ProviderId): string | undefined {
    return this.keys[provider];
  }

  configuredProviders(): ProviderId[] {
    return (Object.keys(this.keys) as ProviderId[]).filter(
      (p) => (this.keys[p]?.length ?? 0) > 0
    );
  }

  /** All currently-held secret strings — fed to the redaction logger. */
  secrets(): string[] {
    return Object.values(this.keys).filter((v): v is string => !!v);
  }

  /**
   * Set (or replace) a provider key and persist keys.enc atomically. Re-keying
   * after a tamper deliberately replaces the bad file and returns to "ready".
   */
  async setKey(provider: ProviderId, key: string): Promise<void> {
    if (!this.masterKey) {
      throw new Error("key store is locked: OS keychain unavailable");
    }
    this.keys[provider] = key;
    await this.persist();
    this.stateValue = "ready";
  }

  async removeKey(provider: ProviderId): Promise<void> {
    if (!this.masterKey) {
      throw new Error("key store is locked: OS keychain unavailable");
    }
    delete this.keys[provider];
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (!this.masterKey) return;
    const blob = encryptVault(
      Buffer.from(JSON.stringify(this.keys), "utf8"),
      this.masterKey
    );
    // Atomic write-temp-then-rename so a crash mid-write can't corrupt keys.enc.
    const tmp = path.join(
      path.dirname(this.filePath),
      `.${path.basename(this.filePath)}.${randomBytes(6).toString("hex")}.tmp`
    );
    try {
      const fh = await fs.open(tmp, "wx");
      try {
        await fh.writeFile(blob);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.rename(tmp, this.filePath);
    } catch (err) {
      // Never leave an orphan temp behind on a failed write.
      await fs.rm(tmp, { force: true });
      throw err;
    }
    try {
      const dir = await fs.open(path.dirname(this.filePath), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch {
      // Directory fsync is best-effort; not all platforms permit it.
    }
  }
}
