import { promises as fs, type Dirent } from "node:fs";
import * as path from "node:path";
import { chunkMarkdown } from "./chunk.js";
import { retrieve, retrieveLexical, type RetrieveOptions } from "./retrieve.js";
import { VectorIndex } from "./vectorIndex.js";
import { LexicalIndex } from "./lexicalIndex.js";
import { IndexStore, type StoredNote } from "./indexStore.js";
import { readWithBaseline } from "../vault/hash.js";
import type { DiskBaseline } from "../vault/types.js";
import type {
  Chunk,
  Embedder,
  GroundingResult,
  IndexedChunk,
  ScoredChunk,
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
  /** The INSTANT lexical (BM25) index — populated from the same chunk pass as
   *  the embedder, so grounding can answer the moment indexing starts while the
   *  vectors backfill (the "feel instant" path). */
  private readonly lexical = new LexicalIndex();
  /** Distinct note paths currently in the index (so counts survive replaceNote). */
  private readonly notePaths = new Set<string>();
  private indexing = false;
  /** Notes the watcher edited or removed WHILE a backfill embed was in flight.
   *  The bulk run snapshotted their chunks before the long embed, so writing the
   *  snapshot's vectors back would be a lost update (edited) or a resurrected
   *  delete (removed). The attach loop skips these and the run reconciles them
   *  afterward (drainDirty). Only meaningful while `indexing` is true. */
  private readonly dirtyDuringIndex = new Set<string>();
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
    semanticReady: boolean;
    indexing: boolean;
    notes: number;
    chunks: number;
    processed: number;
    total: number;
    notesTotal: number;
  } {
    // ready = answerable NOW (lexical OR vector). semanticReady = vectors exist.
    // During a cold backfill, ready is true (lexical filled) while semanticReady
    // is still false — that gap is exactly the "feel instant" window.
    return {
      ready: this.index.size > 0 || this.lexical.size > 0,
      semanticReady: this.index.size > 0,
      indexing: this.indexing,
      notes: this.notePaths.size,
      chunks: this.index.size > 0 ? this.index.size : this.lexical.size,
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
   * Reconcile notes the watcher touched during the bulk embed (see
   * `dirtyDuringIndex`). For each still-present edited note, re-read + re-embed
   * from CURRENT disk content so its vectors match its lexical chunks (no stale
   * snapshot). Removed notes are simply left out. Returns the freshly embedded
   * notes so a persisting caller (reconcile) can fold them into the saved index.
   * Runs at the tail of a backfill — bounded to the handful of notes edited in
   * the embed window, so it does NOT reintroduce the per-edit jank 9A removed.
   */
  private async drainDirty(): Promise<StoredNote[]> {
    // Keyed by path so re-processing the same note across rounds keeps only the
    // latest result (and a later removal deletes it).
    const updated = new Map<string, StoredNote>();
    // LOOP until quiescent: a note re-edited during our OWN read/embed await is
    // re-added to dirtyDuringIndex (reindexNote parks it because indexing is still
    // true), so a single pass would leave stale vectors. Bounded so a pathological
    // edit-storm can't spin forever — any residue self-heals on the next
    // fingerprint reconcile (changed baseline → re-embed).
    for (let round = 0; round < 50 && this.dirtyDuringIndex.size > 0; round++) {
      const paths = [...this.dirtyDuringIndex];
      this.dirtyDuringIndex.clear();
      for (const p of paths) {
        if (!this.notePaths.has(p)) {
          updated.delete(p); // removed during backfill → stays out
          continue;
        }
        let read;
        try {
          read = await readWithBaseline(p);
        } catch {
          this.removeNote(p);
          updated.delete(p);
          continue;
        }
        const chunks = chunkMarkdown(p, read.content.toString("utf8"), this.chunkOptions());
        if (chunks.length === 0) {
          this.removeNote(p);
          updated.delete(p);
          continue;
        }
        this.lexical.replaceNote(p, chunks);
        try {
          const vectors = await this.embedder.embed(chunks.map((c) => c.text));
          const indexed: IndexedChunk[] = chunks.map((c, i) => ({
            ...c,
            vector: vectors[i] as number[],
          }));
          this.index.replaceNote(p, indexed);
          updated.set(p, { path: p, baseline: read.baseline, chunks: indexed });
        } catch {
          // Embedding failed; the note stays keyword-searchable (lexical) and will
          // be re-embedded on the next reconcile. No stale vector is written.
          updated.delete(p);
        }
      }
    }
    return [...updated.values()];
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
      this.lexical.clear();
      this.notePaths.clear();
      this.dirtyDuringIndex.clear();

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
          this.lexical.add(cached.chunks);
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
          this.lexical.add(cached.chunks);
          this.notePaths.add(file);
          current.set(file, refreshed);
          continue;
        }
        const chunks = chunkMarkdown(
          file,
          read.content.toString("utf8"),
          this.chunkOptions()
        );
        if (chunks.length > 0) {
          // Lexical is ready up front (no model), so a changed note is keyword-
          // searchable immediately while its new vectors backfill below.
          this.lexical.add(chunks);
          this.notePaths.add(file);
          toEmbed.push({ file, baseline: read.baseline, chunks });
        }
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
        // Skip a note the watcher edited/removed mid-embed — its snapshot vectors
        // are stale (don't write them, don't resurrect a delete). drainDirty
        // reconciles it from current disk just below.
        if (this.dirtyDuringIndex.has(e.file) || !this.notePaths.has(e.file)) {
          current.delete(e.file);
          continue;
        }
        this.index.add(indexed);
        this.notePaths.add(e.file);
        current.set(e.file, { path: e.file, baseline: e.baseline, chunks: indexed });
      }

      // Re-embed notes touched during the embed window from current disk content.
      for (const note of await this.drainDirty()) current.set(note.path, note);
      // A note removed during the window must not survive in the persisted set.
      for (const p of [...current.keys()]) {
        if (!this.notePaths.has(p)) current.delete(p);
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
      this.lexical.clear();
      this.notePaths.clear();
      this.dirtyDuringIndex.clear();
      const files = await listMarkdown(root);

      // 1. Chunk every readable note (no embedding yet) and populate the lexical
      //    index + note paths in the SAME pass. After this loop grounding is
      //    already answerable in keyword mode — the vectors below just upgrade it
      //    to semantic. One chunking pass feeds both indexes (chunk ids align).
      const perNote: { file: string; chunks: Chunk[] }[] = [];
      for (const file of files) {
        let md: string;
        try {
          md = await fs.readFile(file, "utf8");
        } catch {
          continue;
        }
        const chunks = chunkMarkdown(file, md, this.chunkOptions());
        if (chunks.length > 0) {
          perNote.push({ file, chunks });
          this.lexical.add(chunks);
          this.notePaths.add(file);
        }
      }
      this.progress.notes = perNote.length;

      // 2. Embed the flattened chunk list in batches, advancing progress. One
      //    batch in flight at a time — deliberately gentle on the machine.
      const flat = perNote.flatMap((n) => n.chunks);
      this.progress.total = flat.length;
      const vectors = await this.embedFlat(flat);

      // 3. Reattach vectors to their notes and populate the index. Skip any note
      //    the watcher edited/removed during the embed — its snapshot vectors are
      //    stale; drainDirty re-embeds edited ones from current disk and leaves
      //    removed ones out, so the vector index can't go stale or resurrect a delete.
      let k = 0;
      for (const n of perNote) {
        const indexed: IndexedChunk[] = n.chunks.map((c) => ({
          ...c,
          vector: vectors[k++] as number[],
        }));
        if (this.dirtyDuringIndex.has(n.file) || !this.notePaths.has(n.file)) continue;
        this.index.add(indexed);
        this.notePaths.add(n.file);
      }
      await this.drainDirty();
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
    const chunks = chunkMarkdown(
      notePath,
      read.content.toString("utf8"),
      this.chunkOptions()
    );
    if (chunks.length === 0) {
      this.removeNote(notePath);
      return;
    }
    // ALWAYS refresh the lexical index — it's cheap (no model) and keeps keyword
    // grounding consistent with disk on every edit, including mid-backfill.
    this.lexical.replaceNote(notePath, chunks);
    this.notePaths.add(notePath);

    // 9A: only EMBED when the vector index already exists AND no backfill is in
    // flight. Embedding here gates on `semanticReady`, NOT on `ready` — otherwise
    // an edit during the cold backfill (when lexical is ready but vectors aren't)
    // would fire a synchronous one-note embed, the exact lag this design removes.
    // While backfilling, the edit lands in lexical now and the running pass
    // re-embeds it from current disk at its tail (drainDirty); in steady state we
    // re-embed the one changed note here (D2).
    if (this.index.size === 0 || this.indexing) {
      if (this.indexing) this.dirtyDuringIndex.add(notePath);
      return;
    }
    let indexed: IndexedChunk[];
    try {
      const vectors = await this.embedder.embed(chunks.map((c) => c.text));
      indexed = chunks.map((c, i) => ({ ...c, vector: vectors[i] as number[] }));
    } catch {
      return; // embedding failed; keep the refreshed lexical chunks (no data loss)
    }
    this.index.replaceNote(notePath, indexed);
    // Persist this note so the saved index stays current as the user edits (D16).
    await this.store?.putNote({ path: notePath, baseline: read.baseline, chunks: indexed });
  }

  /** Drop a note from BOTH indexes (deleted/renamed-away on disk). Lexical and
   *  vector must move together or keyword grounding drifts from semantic. */
  removeNote(notePath: string): void {
    this.index.replaceNote(notePath, []);
    this.lexical.removeNote(notePath);
    this.notePaths.delete(notePath);
    // If a backfill is in flight, mark it so the attach loop won't resurrect this
    // note from its pre-delete snapshot vectors.
    if (this.indexing) this.dirtyDuringIndex.add(notePath);
    // Tombstone it in the persisted index (best-effort; a watcher remove must
    // never block or throw).
    void this.store?.deleteNote(notePath).catch(() => {});
  }

  /**
   * Retrieve grounding context for a query. Never throws (D12).
   *
   * 3A: while a backfill is running (or before any vectors exist) the query
   * takes the keyword path ONLY — a 1-item query embed must never queue behind a
   * 128-chunk backfill batch on the single worker. Once the vectors are in and
   * the index is idle, retrieval is semantic (5A: pure-vector in steady state;
   * the lexical index stays as the during-backfill instant path and the merge
   * seam for the deferred hybrid mode).
   */
  ground(query: string): Promise<GroundingResult> {
    const opts = this.options.retrieve ?? {};
    if (this.indexing || this.index.size === 0) {
      return Promise.resolve(retrieveLexical(this.lexical, query, opts));
    }
    return retrieve(this.embedder, this.index, query, opts);
  }

  /** Raw BM25 search over the vault — the `search_vault` tool engine for the
   *  agentic path. No model, always works once the lexical index is built. */
  searchLexical(query: string, k: number): ScoredChunk[] {
    return this.lexical.search(query, k);
  }

  /**
   * Semantic (embedding) search over the vault — the `deep_search` tool engine.
   * Returns `null` when the vector index isn't usable yet (no vectors / still
   * cold-backfilling / the query embed failed), so the agentic tool can tell the
   * model to fall back to keyword search; `[]` means it ran and matched nothing.
   * Reuses the D9 `retrieve` path (and its minScore honesty gate); embedding the
   * one query is cheap and queues behind any in-flight backfill on the shared
   * worker. Never throws.
   */
  async searchSemantic(query: string, k: number): Promise<ScoredChunk[] | null> {
    if (this.index.size === 0) return null; // no vectors yet → caller falls back
    const result = await retrieve(this.embedder, this.index, query, { k });
    if (result.status === "grounded") return result.chunks;
    // no-matches → ran cleanly, nothing relevant ([]); empty-index/embed-failed
    // → semantic not usable (null) so the model uses keyword search instead.
    return result.reason === "no-matches" ? [] : null;
  }

  /**
   * Build ONLY the lexical (BM25) index if it isn't already populated — the
   * agentic path needs keyword search but NOT embeddings, so this is the cheap,
   * no-model, no-embed build (chunk every note, add to the lexical index). A
   * no-op once the lexical index has content (e.g. after a normal indexVault).
   */
  async ensureLexical(root: string): Promise<void> {
    if (this.lexical.size > 0) return;
    const files = await listMarkdown(root);
    for (const file of files) {
      let md: string;
      try {
        md = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }
      const chunks = chunkMarkdown(file, md, this.chunkOptions());
      if (chunks.length > 0) {
        this.lexical.add(chunks);
        this.notePaths.add(file);
      }
    }
  }
}
