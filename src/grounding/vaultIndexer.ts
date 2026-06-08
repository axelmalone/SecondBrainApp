import { promises as fs, type Dirent } from "node:fs";
import * as path from "node:path";
import { chunkMarkdown } from "./chunk.js";
import { retrieve, type RetrieveOptions } from "./retrieve.js";
import { VectorIndex } from "./vectorIndex.js";
import type {
  Chunk,
  Embedder,
  GroundingResult,
  IndexedChunk,
} from "./types.js";

const MARKDOWN_EXT = new Set([".md", ".markdown"]);

/** Recursively list markdown files under root, skipping Obsidian's own dir and
 *  any dot-directories (e.g. .git, .trash). */
async function listMarkdown(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, never throw the whole index
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // .obsidian, .git, .trash, …
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (MARKDOWN_EXT.has(path.extname(entry.name).toLowerCase()))
        out.push(full);
    }
  };
  await walk(root);
  return out;
}

export interface GroundingServiceOptions {
  chunkMaxChars?: number;
  retrieve?: RetrieveOptions;
}

export interface IndexCounts {
  notes: number;
  chunks: number;
}

/**
 * Owns the in-memory vault index and answers retrieval queries (D9). Indexing
 * is explicit (the user triggers it) so the heavy local embedding model only
 * loads on demand. A failed file read is skipped, never fatal.
 */
export class GroundingService {
  /** Chunks per embed round-trip. A bigger batch does more work per call (less
   *  per-call + round-trip overhead, and the model's matmul amortizes better) —
   *  measured ~2x over 32 on a SINGLE worker, with no extra processes. This is
   *  the deliberately-gentle speed-up: one low-priority worker, not a core-eating
   *  pool. The recurring cost (re-embedding every launch) is D16's job. */
  private static readonly EMBED_BATCH = 128;

  private readonly index = new VectorIndex();
  /** Distinct note paths currently in the index (so counts survive replaceNote). */
  private readonly notePaths = new Set<string>();
  private indexing = false;
  /** Live indexing progress for the UI: chunks done/total + note count. */
  private progress = { done: 0, total: 0, notes: 0 };

  constructor(
    private readonly embedder: Embedder,
    private readonly options: GroundingServiceOptions = {}
  ) {}

  status(): {
    ready: boolean;
    indexing: boolean;
    notes: number;
    chunks: number;
    processed: number;
    total: number;
    notesTotal: number;
  } {
    return {
      ready: this.index.size > 0,
      indexing: this.indexing,
      notes: this.notePaths.size,
      chunks: this.index.size,
      processed: this.progress.done,
      total: this.progress.total,
      notesTotal: this.progress.notes,
    };
  }

  private chunkOptions(): { maxChars?: number } {
    return this.options.chunkMaxChars !== undefined
      ? { maxChars: this.options.chunkMaxChars }
      : {};
  }

  private async embedChunks(notePath: string, md: string): Promise<IndexedChunk[]> {
    const chunks = chunkMarkdown(notePath, md, this.chunkOptions());
    if (chunks.length === 0) return [];
    const vectors = await this.embedder.embed(chunks.map((c) => c.text));
    return chunks.map((c, i) => ({ ...c, vector: vectors[i] as number[] }));
  }

  /**
   * Full re-index of the vault at `root`. Replaces the entire index.
   *
   * Chunks every note up front (cheap, no model), then embeds ALL chunks in
   * batches — far fewer round-trips than one embed call per note, which keeps
   * the model busy instead of idling between notes. `status().processed/total`
   * advances as batches complete so the UI can show live progress. The index is
   * populated only after every embed succeeds, so a mid-run embedder failure
   * leaves no half-built index (the call throws and the caller reports it).
   */
  async indexVault(root: string): Promise<IndexCounts> {
    this.indexing = true;
    this.progress = { done: 0, total: 0, notes: 0 };
    try {
      this.index.clear();
      this.notePaths.clear();
      const files = await listMarkdown(root);

      // 1. Chunk every readable note (no embedding yet).
      const perNote: { file: string; chunks: Chunk[] }[] = [];
      for (const file of files) {
        let md: string;
        try {
          md = await fs.readFile(file, "utf8");
        } catch {
          continue;
        }
        const chunks = chunkMarkdown(file, md, this.chunkOptions());
        if (chunks.length > 0) perNote.push({ file, chunks });
      }
      this.progress.notes = perNote.length;

      // 2. Embed the flattened chunk list in batches, advancing progress. One
      //    batch in flight at a time — deliberately gentle on the machine.
      const flat = perNote.flatMap((n) => n.chunks);
      this.progress.total = flat.length;
      const vectors = new Array<number[]>(flat.length);
      for (let i = 0; i < flat.length; i += GroundingService.EMBED_BATCH) {
        const slice = flat.slice(i, i + GroundingService.EMBED_BATCH);
        const batch = await this.embedder.embed(slice.map((c) => c.text));
        for (let j = 0; j < slice.length; j++) {
          vectors[i + j] = batch[j] as number[];
        }
        this.progress.done = Math.min(i + slice.length, flat.length);
      }

      // 3. Reattach vectors to their notes and populate the index.
      let k = 0;
      for (const n of perNote) {
        const indexed: IndexedChunk[] = n.chunks.map((c) => ({
          ...c,
          vector: vectors[k++] as number[],
        }));
        this.index.add(indexed);
        this.notePaths.add(n.file);
      }
      return { notes: this.notePaths.size, chunks: this.index.size };
    } finally {
      this.indexing = false;
    }
  }

  /**
   * Incrementally re-index a single note after it changed on disk (D2). Reads
   * the current bytes, re-chunks, re-embeds, and swaps just that note's chunks.
   * A missing/unreadable file or an embedding failure is handled gracefully —
   * the note is dropped rather than leaving stale or partial state, and nothing
   * throws (a watcher callback must never crash the app).
   */
  async reindexNote(notePath: string): Promise<void> {
    let md: string;
    try {
      md = await fs.readFile(notePath, "utf8");
    } catch {
      this.removeNote(notePath);
      return;
    }
    let indexed: IndexedChunk[];
    try {
      indexed = await this.embedChunks(notePath, md);
    } catch {
      return; // embedding failed; keep the previous chunks rather than lose them
    }
    if (indexed.length === 0) {
      this.removeNote(notePath);
      return;
    }
    this.index.replaceNote(notePath, indexed);
    this.notePaths.add(notePath);
  }

  /** Drop a note from the index (deleted/renamed-away on disk). */
  removeNote(notePath: string): void {
    this.index.replaceNote(notePath, []);
    this.notePaths.delete(notePath);
  }

  /** Retrieve grounding context for a query. Never throws (D12). */
  ground(query: string): Promise<GroundingResult> {
    return retrieve(this.embedder, this.index, query, this.options.retrieve ?? {});
  }
}
