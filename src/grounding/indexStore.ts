import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { DiskBaseline } from "../vault/types.js";
import type { IndexedChunk } from "./types.js";

/** One note's persisted index entry: its on-disk fingerprint + embedded chunks. */
export interface StoredNote {
  path: string;
  baseline: DiskBaseline;
  chunks: IndexedChunk[];
}

type IndexRecord =
  | { path: string; baseline: DiskBaseline; chunks: IndexedChunk[] }
  | { path: string; deleted: true };

/**
 * Persists the grounding vector index to an app-private, per-vault JSONL file
 * OUTSIDE the vault (D16). One appended line per note (or a tombstone); reading
 * folds to the latest line per path. Append-only ⇒ a crash mid-write only tears
 * the last line (tolerated), and writing one note at a time means the watcher's
 * incremental re-index never rewrites the whole file. Compaction-on-launch
 * rewrites out superseded/tombstoned lines.
 *
 * This is what turns the (slow) embed into a ONE-TIME cost: on the next launch
 * the saved vectors are reused for every unchanged note, so only edited notes
 * are re-embedded. Same proven shape as chatStore / proposalStore.
 */
export class IndexStore {
  constructor(private readonly file: string) {}

  /** True if a persisted index file exists (→ launch can auto-reconcile). */
  async exists(): Promise<boolean> {
    try {
      await fs.access(this.file);
      return true;
    } catch {
      return false;
    }
  }

  /** Fold the log to the latest entry per note path (tombstones removed). */
  async load(): Promise<Map<string, StoredNote>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch {
      return new Map();
    }
    const byPath = new Map<string, StoredNote>();
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let rec: IndexRecord;
      try {
        rec = JSON.parse(line) as IndexRecord;
      } catch {
        continue; // torn final line (crash mid-append) or garbage — skip it
      }
      if (!rec || typeof rec.path !== "string") continue;
      if ("deleted" in rec && rec.deleted) byPath.delete(rec.path);
      else if ("chunks" in rec && Array.isArray(rec.chunks)) {
        byPath.set(rec.path, {
          path: rec.path,
          baseline: rec.baseline,
          chunks: rec.chunks,
        });
      }
    }
    return byPath;
  }

  /** Append one note's index entry. Append-only: never rewrites earlier lines. */
  async putNote(note: StoredNote): Promise<void> {
    await this.ensureDir();
    await fs.appendFile(this.file, JSON.stringify(note) + "\n");
  }

  /** Append a tombstone so a deleted/renamed note drops out on the next fold. */
  async deleteNote(path: string): Promise<void> {
    await this.ensureDir();
    await fs.appendFile(this.file, JSON.stringify({ path, deleted: true }) + "\n");
  }

  /**
   * Rewrite the log to exactly `notes` (one line each), atomically
   * (temp → fsync → rename). Drops superseded/tombstoned lines so the file
   * doesn't grow unbounded. Called on launch after reconcile settles.
   */
  async compact(notes: Iterable<StoredNote>): Promise<void> {
    await this.ensureDir();
    const body = [...notes].map((n) => JSON.stringify(n)).join("\n");
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    const fh = await fs.open(tmp, "wx");
    try {
      await fh.writeFile(body.length > 0 ? body + "\n" : "");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, this.file);
  }

  /** Delete the whole index file (e.g. a forced full rebuild). */
  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true });
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
  }
}
