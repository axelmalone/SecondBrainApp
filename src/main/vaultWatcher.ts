import { watch, type FSWatcher, promises as fs } from "node:fs";
import * as path from "node:path";

const MARKDOWN_EXT = new Set([".md", ".markdown"]);

export interface VaultWatcherOptions {
  root: string;
  /** Fired (debounced) when a markdown note appears or changes on disk. */
  onChanged: (absPath: string) => void;
  /** Fired (debounced) when a markdown note is deleted / renamed away. */
  onRemoved: (absPath: string) => void;
  /** Quiet period before reacting to a path's events. */
  debounceMs?: number;
  /** How long a self-write suppresses the watcher event it will produce. */
  selfWriteWindowMs?: number;
}

/**
 * Vault-wide file watcher (D6): marks ANY externally-changed note dirty so the
 * grounding index can incrementally re-index it. Two safeguards:
 *  - per-path debounce, since one save can emit several fs events;
 *  - self-write dedupe — the app's own atomic writes call markSelfWrite() and
 *    re-index directly, so the watcher event they produce is swallowed instead
 *    of triggering a redundant disk re-read + re-embed.
 *
 * Uses recursive fs.watch (supported on macOS/Windows). If watching is
 * unavailable, it degrades silently: grounding simply won't auto-update until
 * the next manual re-index.
 */
export class VaultWatcher {
  private watcher: FSWatcher | null = null;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly selfWrites = new Map<string, number>();
  private readonly debounceMs: number;
  private readonly selfWriteWindowMs: number;

  constructor(private readonly options: VaultWatcherOptions) {
    this.debounceMs = options.debounceMs ?? 500;
    this.selfWriteWindowMs = options.selfWriteWindowMs ?? 2000;
  }

  start(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(
        this.options.root,
        { recursive: true },
        (_event, filename) => {
          if (!filename) return;
          const rel = filename.toString();
          if (!this.isRelevant(rel)) return;
          this.schedule(path.join(this.options.root, rel));
        }
      );
    } catch {
      this.watcher = null;
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Record that the app just wrote this path, so its watcher event is ignored. */
  markSelfWrite(absPath: string): void {
    this.selfWrites.set(absPath, Date.now());
  }

  /** True for vault markdown files; excludes dot-dirs/files (.obsidian, temp, .bak). */
  private isRelevant(rel: string): boolean {
    if (rel.split(path.sep).some((seg) => seg.startsWith("."))) return false;
    return MARKDOWN_EXT.has(path.extname(rel).toLowerCase());
  }

  private schedule(absPath: string): void {
    const existing = this.timers.get(absPath);
    if (existing) clearTimeout(existing);
    this.timers.set(
      absPath,
      setTimeout(() => {
        this.timers.delete(absPath);
        void this.handle(absPath);
      }, this.debounceMs)
    );
  }

  private async handle(absPath: string): Promise<void> {
    const writtenAt = this.selfWrites.get(absPath);
    if (writtenAt !== undefined) {
      // Whether fresh or stale, this self-write record has served its purpose;
      // drop it so a dropped/coalesced fs.watch event can't leak entries.
      this.selfWrites.delete(absPath);
      if (Date.now() - writtenAt <= this.selfWriteWindowMs) {
        return; // our own write — already re-indexed by the save path
      }
    }
    try {
      await fs.stat(absPath);
      this.options.onChanged(absPath);
    } catch {
      this.options.onRemoved(absPath);
    }
  }
}
