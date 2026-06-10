// Vault grounding (D9): local embeddings over note text + top-k chunk injection.
// The Embedder is injected so the pure retrieval logic is unit-testable with a
// deterministic fake — the real local model (transformers.js) is one adapter.

/** Produces a fixed-length embedding per input string. Documents and queries
 *  MUST use the same embedder so their vectors share a space. */
export interface Embedder {
  /** Embedding dimensionality (e.g. 384 for all-MiniLM-L6-v2). */
  readonly dimension: number;
  /** Embed a batch; result[i] corresponds to texts[i]. */
  embed(texts: string[]): Promise<number[][]>;
}

/** A piece of a note, the unit of retrieval. */
export interface Chunk {
  /** Stable id: `${notePath}#${ordinal}`. */
  id: string;
  notePath: string;
  /** Nearest enclosing markdown heading, if any — used for display. */
  heading?: string;
  text: string;
}

/** A chunk plus its document embedding, held in the in-memory index. */
export interface IndexedChunk extends Chunk {
  vector: number[];
}

/** A chunk plus its relevance to the query. For the vector path this is cosine
 *  similarity (1 = identical direction); for the lexical path it's a BM25 score
 *  (unbounded, only comparable within a single query). */
export interface ScoredChunk extends Chunk {
  score: number;
}

/**
 * How a grounded answer was retrieved. `keyword` = lexical/BM25 (the instant
 * path, used while embeddings are still backfilling); `semantic` = vector
 * cosine; `hybrid` = a fusion of both (reserved for the deferred RRF path).
 * Surfaced to the user so the per-answer badge tells the truth about which
 * index actually answered.
 */
export type GroundingMode = "keyword" | "semantic" | "hybrid";

/**
 * A read-only lexical retriever. Injected into retrieval the same way `Embedder`
 * is, so the fusion/fallback logic in retrieve.ts stays unit-testable with a
 * deterministic stub and src/grounding never reaches into a concrete index.
 */
export interface LexicalSearch {
  /** Number of indexed chunks (0 = nothing to search). */
  readonly size: number;
  /** Top-k chunks for a query, already gated to real term overlap. */
  search(query: string, k: number): ScoredChunk[];
}

/**
 * Why grounding produced no usable context. D12: each of these is surfaced to
 * the user as a visible "answering without vault context" badge — the model
 * still answers, but never silently as if it were grounded.
 */
export type GroundingUnavailableReason =
  | "empty-index" // nothing indexed yet
  | "embed-failed" // the query embedding threw
  | "no-matches"; // top-k all below the relevance threshold

/** Result of a retrieval attempt. Discriminated on `status`. A grounded result
 *  carries the `mode` so the caller can report whether keyword or semantic
 *  retrieval produced the excerpts. */
export type GroundingResult =
  | { status: "grounded"; mode: GroundingMode; chunks: ScoredChunk[]; injected: string }
  | { status: "unavailable"; reason: GroundingUnavailableReason };
