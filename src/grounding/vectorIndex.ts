import type { IndexedChunk, ScoredChunk } from "./types.js";

function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

function norm(a: readonly number[]): number {
  return Math.sqrt(dot(a, a));
}

/** Cosine similarity; 0 when either vector is zero-length. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  const denom = norm(a) * norm(b);
  return denom === 0 ? 0 : dot(a, b) / denom;
}

interface Entry {
  chunk: IndexedChunk;
  norm: number;
}

/**
 * A flat in-memory vector index. M1 vaults are small enough that a linear scan
 * is fine; this can be swapped for an ANN index later without changing callers.
 * Per-note replace keeps the index in step with incremental re-indexing.
 */
export class VectorIndex {
  private entries: Entry[] = [];

  get size(): number {
    return this.entries.length;
  }

  /** Drop everything (e.g. before a full re-index). */
  clear(): void {
    this.entries = [];
  }

  /** Add chunks. Vectors are stored as-is; norms are precomputed for search. */
  add(chunks: readonly IndexedChunk[]): void {
    for (const chunk of chunks) {
      this.entries.push({ chunk, norm: norm(chunk.vector) });
    }
  }

  /** Replace every chunk belonging to one note (incremental re-index). */
  replaceNote(notePath: string, chunks: readonly IndexedChunk[]): void {
    this.entries = this.entries.filter((e) => e.chunk.notePath !== notePath);
    this.add(chunks);
  }

  /** Top-k chunks by cosine similarity to the query vector, highest first. */
  search(query: readonly number[], k: number): ScoredChunk[] {
    const qNorm = norm(query);
    if (qNorm === 0 || this.entries.length === 0) return [];

    const scored = this.entries.map((e) => {
      const denom = e.norm * qNorm;
      const score = denom === 0 ? 0 : dot(e.chunk.vector, query) / denom;
      const { vector, ...rest } = e.chunk;
      void vector;
      return { ...rest, score } satisfies ScoredChunk;
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }
}
