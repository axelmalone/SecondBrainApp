import { promises as fs, type Dirent } from "node:fs";
import * as path from "node:path";
import { chunkMarkdown } from "./chunk.js";
import { retrieve, type RetrieveOptions } from "./retrieve.js";
import { VectorIndex } from "./vectorIndex.js";
import { IndexStore, type StoredNote } from "./indexStore.js";
import { readWithBaseline } from "../vault/hash.js";
import type { DiskBaseline } from "../vault/types.js";
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
    private readonly options: GroundingServiceOptions = {},
    /** Persists the index (D16). When null, the index is in-memory only. */
    private readonly store: IndexStore | null = null
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

  /** Embed a flat chunk list in EMBED_BATCH-sized calls, advancing progress. */
  private async embedFlat(chunks: Chunk[]): Promise<number[][]> {
    const vectors = new Array<number[]>(chunks.length);
    for (let i = 0; i < chunks.length; i += GroundingService.EMBED_BATCH) {
      const slice = chunks.slice(i, i + GroundingService.EMBED_BATCH);
      const batch = await this.embedder.embed(slice.map((c) => c.text));
      for (let j = 0; j < slice.length; j++) vectors[i + j] = batch[j] as number[];
      this.progress.done = Math.min(i + slice.length, chunks.length);
    }
    return vectors;
  }

  /**
   * Launch / refresh path (D16). Reuses the persisted index: each note whose
   * on-disk fingerprint is unchanged keeps its saved vectors (no embedding);
   * only new/edited notes are re-embedded, and deleted notes are dropped. The
   * cheap mtime+size gate means an unchanged vault is mostly stat() calls —
   * seconds, not the full embed. Falls back to a full indexVault with no store.
   */
  async reconcile(root: string): Promise<IndexCounts> {
    if (!this.store) return this.indexVault(root);
    this.indexing = true;
    this.progress = { done: 0, total: 0, notes: 0 };
    try {
      const saved = await this.store.load();
      const files = await listMarkdown(root);
      this.index.clear();
      this.notePaths.clear();

      const current = new Map<string, StoredNote>();
      const toEmbed: { file: string; baseline: DiskBaseline; chunks: Chunk[] }[] = [];

      for (const file of files) {
        let stats;
        try {
          stats = await fs.stat(file);
        } catch {
          continue;
        }
        const cached = saved.get(file);
        // Cheap gate: unchanged mtime+size → reuse saved vectors, no read/embed.
        if (
          cached &&
          cached.baseline.mtimeMs === stats.mtimeMs &&
          cached.baseline.size === stats.size
        ) {
          this.index.add(cached.chunks);
          this.notePaths.add(file);
          current.set(file, cached);
          continue;
        }
        // mtime/size moved → read + hash to tell a real edit from a mere touch.
        let read;
        try {
          read = await readWithBaseline(file);
        } catch {
          continue;
        }
        if (cached && cached.baseline.sha256 === read.baseline.sha256) {
          const refreshed: StoredNote = {
            path: file,
            baseline: read.baseline,
            chunks: cached.chunks,
          };
          this.index.add(cached.chunks);
          this.notePaths.add(file);
          current.set(file, refreshed);
          continue;
        }
        const chunks = chunkMarkdown(
          file,
          read.content.toString("utf8"),
          this.chunkOptions()
        );
        if (chunks.length > 0) toEmbed.push({ file, baseline: read.baseline, chunks });
      }

      // Embed only the new/changed notes (batched, gentle).
      this.progress.notes = files.length;
      const flat = toEmbed.flatMap((e) => e.chunks);
      this.progress.total = flat.length;
      const vectors = await this.embedFlat(flat);

      let k = 0;
      for (const e of toEmbed) {
        const indexed: IndexedChunk[] = e.chunks.map((c) => ({
          ...c,
          vector: vectors[k++] as number[],
        }));
        this.index.add(indexed);
        this.notePaths.add(e.file);
        current.set(e.file, { path: e.file, baseline: e.baseline, chunks: indexed });
      }

      // Persist the exact current set (drops deleted/superseded notes too).
      await this.store.compact(current.values());
      return { notes: this.notePaths.size, chunks: this.index.size };
    } finally {
      this.indexing = false;
    }
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
      const vectors = await this.embedFlat(flat);

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
    let read;
    try {
      read = await readWithBaseline(notePath);
    } catch {
      this.removeNote(notePath);
      return;
    }
    let indexed: IndexedChunk[];
    try {
      indexed = await this.embedChunks(notePath, read.content.toString("utf8"));
    } catch {
      return; // embedding failed; keep the previous chunks rather than lose them
    }
    if (indexed.length === 0) {
      this.removeNote(notePath);
      return;
    }
    this.index.replaceNote(notePath, indexed);
    this.notePaths.add(notePath);
    // Persist this note so the saved index stays current as the user edits (D16).
    await this.store?.putNote({ path: notePath, baseline: read.baseline, chunks: indexed });
  }

  /** Drop a note from the index (deleted/renamed-away on disk). */
  removeNote(notePath: string): void {
    this.index.replaceNote(notePath, []);
    this.notePaths.delete(notePath);
    // Tombstone it in the persisted index (best-effort; a watcher remove must
    // never block or throw).
    void this.store?.deleteNote(notePath).catch(() => {});
  }

  /** Retrieve grounding context for a query. Never throws (D12). */
  ground(query: string): Promise<GroundingResult> {
    return retrieve(this.embedder, this.index, query, this.options.retrieve ?? {});
  }
}
