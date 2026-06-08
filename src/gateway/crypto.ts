import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
export const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12; // GCM standard nonce
const TAG_LENGTH = 16;

/** keys.enc was unreadable: corrupt, truncated, or the auth tag did not verify. */
export class VaultCryptoError extends Error {
  readonly code: "Malformed" | "Tampered";
  constructor(code: "Malformed" | "Tampered", options?: { cause?: unknown }) {
    super(
      code === "Malformed" ? "key vault blob is malformed" : "key vault failed authentication (tampered or wrong key)",
      options as ErrorOptions
    );
    this.name = "VaultCryptoError";
    this.code = code;
  }
}

/** Generate a fresh 32-byte AES-256 master key. */
export function generateMasterKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}

/**
 * Encrypt the key-vault plaintext with AES-256-GCM.
 * Layout on disk: [iv(12) | authTag(16) | ciphertext].
 */
export function encryptVault(plaintext: Buffer, masterKey: Buffer): Buffer {
  if (masterKey.length !== KEY_LENGTH) {
    throw new VaultCryptoError("Malformed");
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

/**
 * Decrypt a key-vault blob. GCM's auth tag means ANY tampering (or a wrong key)
 * fails verification and throws VaultCryptoError — we fail closed, never return
 * partially-decrypted or attacker-influenced bytes.
 */
export function decryptVault(blob: Buffer, masterKey: Buffer): Buffer {
  if (masterKey.length !== KEY_LENGTH) {
    throw new VaultCryptoError("Malformed");
  }
  if (blob.length < IV_LENGTH + TAG_LENGTH) {
    throw new VaultCryptoError("Malformed");
  }
  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, masterKey, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new VaultCryptoError("Tampered", { cause: err });
  }
}
