import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { safeStorage } from "electron";
import { KEY_LENGTH } from "../gateway/crypto.js";
import type { KeychainAdapter } from "../gateway/keychain.js";

/**
 * The real keychain adapter (D5). Electron's safeStorage encrypts our AES master
 * key with an OS-backed key (Keychain on macOS, libsecret/DPAPI elsewhere). We
 * store the resulting ciphertext on disk; only the OS can decrypt it, so the
 * master key never sits in plaintext anywhere.
 *
 * If safeStorage is unavailable (headless CI, no desktop keyring), isAvailable()
 * returns false and the KeyStore opens "locked" — the app still launches, AI
 * calls just AuthFail until a keychain is present.
 */
export class ElectronKeychain implements KeychainAdapter {
  constructor(private readonly blobPath: string) {}

  isAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  async getMasterKey(): Promise<Buffer | null> {
    let encrypted: Buffer;
    try {
      encrypted = await fs.readFile(this.blobPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const key = safeStorage.decryptString(encrypted);
    return Buffer.from(key, "base64");
  }

  async setMasterKey(key: Buffer): Promise<void> {
    const encrypted = safeStorage.encryptString(key.toString("base64"));
    const tmp = path.join(
      path.dirname(this.blobPath),
      `.${path.basename(this.blobPath)}.${randomBytes(6).toString("hex")}.tmp`
    );
    const fh = await fs.open(tmp, "wx");
    try {
      await fh.writeFile(encrypted);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, this.blobPath);
  }
}

/** Guard so a malformed env can't hand the KeyStore a wrong-length key. */
export function isValidMasterKey(key: Buffer): boolean {
  return key.length === KEY_LENGTH;
}
