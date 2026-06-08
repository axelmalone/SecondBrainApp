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

/** A chunk plus its cosine similarity to the query (1 = identical direction). */
export interface ScoredChunk extends Chunk {
  score: number;
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

/** Result of a retrieval attempt. Discriminated on `status`. */
export type GroundingResult =
  | { status: "grounded"; chunks: ScoredChunk[]; injected: string }
  | { status: "unavailable"; reason: GroundingUnavailableReason };
