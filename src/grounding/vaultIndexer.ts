import { promises as fs, type Dirent } from "node:fs";
import * as path from "node:path";
import { chunkMarkdown } from "./chunk.js";
import { retrieve, type RetrieveOptions } from "./retrieve.js";
import { VectorIndex } from "./vectorIndex.js";
import type { Embedder, GroundingResult, IndexedChunk } from "./types.js";

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
  private readonly index = new VectorIndex();
  /** Distinct note paths currently in the index (so counts survive replaceNote). */
  private readonly notePaths = new Set<string>();
  private indexing = false;

  constructor(
    private readonly embedder: Embedder,
    private readonly options: GroundingServiceOptions = {}
  ) {}

  status(): { ready: boolean; indexing: boolean; notes: number; chunks: number } {
    return {
      ready: this.index.size > 0,
      indexing: this.indexing,
      notes: this.notePaths.size,
      chunks: this.index.size,
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

  /** Full re-index of the vault at `root`. Replaces the entire index. */
  async indexVault(root: string): Promise<IndexCounts> {
    this.indexing = true;
    try {
      this.index.clear();
      this.notePaths.clear();
      const files = await listMarkdown(root);
      for (const file of files) {
        let md: string;
        try {
          md = await fs.readFile(file, "utf8");
        } catch {
          continue;
        }
        const indexed = await this.embedChunks(file, md);
        if (indexed.length === 0) continue;
        this.index.add(indexed);
        this.notePaths.add(file);
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
