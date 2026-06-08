/**
 * The OS keychain holds the single AES master key (D5). This interface is the
 * seam between the pure-Node key crypto (unit-testable) and the Electron
 * safeStorage adapter (src/main/keychainElectron.ts). Tests inject the
 * in-memory implementation; the real app injects the safeStorage one.
 */
export interface KeychainAdapter {
  /** False when the OS keychain cannot be used (e.g. unsupported/locked). */
  isAvailable(): boolean;
  /** The stored master key, or null if none has been stored yet. */
  getMasterKey(): Promise<Buffer | null>;
  /** Persist the master key. */
  setMasterKey(key: Buffer): Promise<void>;
}

/** In-memory keychain for tests. `available` models keychain availability. */
export class InMemoryKeychain implements KeychainAdapter {
  private key: Buffer | null;

  constructor(
    private readonly available = true,
    initial: Buffer | null = null
  ) {
    this.key = initial;
  }

  isAvailable(): boolean {
    return this.available;
  }

  async getMasterKey(): Promise<Buffer | null> {
    return this.key;
  }

  async setMasterKey(key: Buffer): Promise<void> {
    this.key = Buffer.from(key);
  }
}
