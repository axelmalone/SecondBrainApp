// Watcher-maintained recency index (eng-review decision 6). The chat path needs
// the few most-recently-edited notes every turn; without this it walked + stat'd
// the WHOLE vault on every message. This keeps an in-memory mtime map that the
// VaultWatcher updates incrementally, seeded by one walk per vault switch.
//
// Correctness over the watcher's known-lossy delete/rename coverage: reads
// SELF-HEAL — each candidate is stat'd before it's returned, and any that
// vanished is dropped from the map. So a missed rename/delete event can never
// surface a note that no longer exists into the prompt. Paths are normalized
// (path.resolve) on every write + read so the active-note exclusion and the
// watcher's path shape can't drift apart.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { listMarkdownFiles } from "./vaultScan.js";

export class RecentNotesCache {
  /** Normalized abs path → mtimeMs. */
  private mtimes = new Map<string, number>();
  private seeded = false;

  /** True once a vault has been walked. Until then, callers fall back to a
   *  direct walk so the very first turn after launch still has recent activity. */
  get isSeeded(): boolean {
    return this.seeded;
  }

  /**
   * (Re)seed for a vault root with one full walk + stat, replacing prior state.
   * Called on launch and every vault switch — the one place the full walk is
   * acceptable. Never throws; a partial walk still yields a usable cache.
   */
  async seed(root: string | null): Promise<void> {
    this.mtimes.clear();
    this.seeded = false;
    if (!root) return;
    try {
      const files = await listMarkdownFiles(root);
      for (const f of files) {
        try {
          this.mtimes.set(path.resolve(f), (await fs.stat(f)).mtimeMs);
        } catch {
          // A file that vanished between walk and stat — just skip it.
        }
      }
      this.seeded = true;
    } catch {
      // Unreadable root: leave unseeded so callers fall back to a direct walk.
    }
  }

  /** Watcher hook: a note was created or modified. Re-stats for its new mtime. */
  async note(absPath: string): Promise<void> {
    try {
      this.mtimes.set(path.resolve(absPath), (await fs.stat(absPath)).mtimeMs);
    } catch {
      // Couldn't stat (already gone): drop any stale entry.
      this.mtimes.delete(path.resolve(absPath));
    }
  }

  /** Watcher hook: a note was deleted or renamed away. */
  remove(absPath: string): void {
    this.mtimes.delete(path.resolve(absPath));
  }

  /**
   * The `limit` most-recently-modified note abs paths, newest first. Self-heals:
   * stats each candidate and drops any that no longer exist before returning, so
   * a stale entry (from a missed watcher rename/delete) never reaches a caller.
   */
  async recent(limit: number): Promise<string[]> {
    const sorted = [...this.mtimes.entries()].sort((a, b) => b[1] - a[1]);
    const out: string[] = [];
    for (const [p] of sorted) {
      if (out.length >= limit) break;
      try {
        await fs.stat(p);
        out.push(p);
      } catch {
        this.mtimes.delete(p); // self-heal: prune the vanished note
      }
    }
    return out;
  }
}
