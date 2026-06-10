import type {
  Embedder,
  GroundingResult,
  LexicalSearch,
  ScoredChunk,
} from "./types.js";
import type { VectorIndex } from "./vectorIndex.js";

export interface RetrieveOptions {
  /** How many chunks to inject. */
  k?: number;
  /** Minimum cosine similarity for a chunk to count as "usable". Below this,
   *  retrieval reports `no-matches` rather than injecting irrelevant text. */
  minScore?: number;
}

const DEFAULT_K = 5;
const DEFAULT_MIN_SCORE = 0.2;

/**
 * Format usable chunks into a system-message preamble. The instruction is
 * explicit so the model leans on the notes when relevant but is told to say so
 * when they don't contain the answer — reinforcing the D12 honesty contract at
 * the prompt level, not just the UI.
 */
export function buildContext(chunks: readonly ScoredChunk[]): string {
  // Each excerpt is numbered [1]..[n] so the model can cite the exact source it
  // leaned on. The renderer turns those [n] markers into clickable sidenotes
  // that open the note — provenance the user can verify.
  const blocks = chunks.map((c, i) => {
    const label = c.heading ? `${c.notePath} › ${c.heading}` : c.notePath;
    return `[${i + 1}] ${label}\n${c.text}`;
  });
  return [
    "You are answering using excerpts from the user's personal notes (their vault).",
    "Use the excerpts below when they are relevant. If they do not contain the answer,",
    "say so plainly rather than inventing one.",
    "",
    "When a statement draws on an excerpt, cite it inline with its bracketed number",
    "right after the statement, e.g. [1] or [2][3]. Only cite excerpts you actually",
    "used, and use the exact numbers shown below.",
    "",
    "--- BEGIN VAULT EXCERPTS ---",
    blocks.join("\n\n"),
    "--- END VAULT EXCERPTS ---",
  ].join("\n");
}

/**
 * Retrieve vault context for a query (D9). Returns a discriminated result:
 *  - `grounded`   → usable chunks + an injectable preamble.
 *  - `unavailable`→ a typed reason (empty index / embedding failed / no matches).
 *
 * D12: this NEVER throws and NEVER silently fabricates grounding. The caller
 * answers either way, showing the "answering without vault context" badge on
 * every `unavailable` branch so the user is never fooled.
 */
export async function retrieve(
  embedder: Embedder,
  index: VectorIndex,
  query: string,
  options: RetrieveOptions = {}
): Promise<GroundingResult> {
  const k = options.k ?? DEFAULT_K;
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;

  if (index.size === 0) return { status: "unavailable", reason: "empty-index" };

  let queryVector: number[] | undefined;
  try {
    const vectors = await embedder.embed([query]);
    queryVector = vectors[0];
  } catch {
    return { status: "unavailable", reason: "embed-failed" };
  }
  if (!queryVector) return { status: "unavailable", reason: "embed-failed" };

  const scored = index.search(queryVector, k);
  const usable = scored.filter((c) => c.score >= minScore);
  if (usable.length === 0) return { status: "unavailable", reason: "no-matches" };

  return {
    status: "grounded",
    mode: "semantic",
    chunks: usable,
    injected: buildContext(usable),
  };
}

/**
 * The INSTANT retrieval path: BM25 lexical search, no model. Used while the
 * embeddings backfill (and as the fallback if the vector index is empty). The
 * lexical index applies its OWN relevance gate (score > 0 = real term overlap),
 * so this never injects noise — an off-topic query yields no candidates and we
 * honestly report `no-matches`, preserving the D12 contract for keyword answers.
 * Synchronous (no embedding), but returns the same shape as the vector path so
 * the caller is mode-agnostic.
 */
export function retrieveLexical(
  lexical: LexicalSearch,
  query: string,
  options: RetrieveOptions = {}
): GroundingResult {
  const k = options.k ?? DEFAULT_K;
  if (lexical.size === 0) return { status: "unavailable", reason: "empty-index" };
  const scored = lexical.search(query, k);
  if (scored.length === 0) return { status: "unavailable", reason: "no-matches" };
  return {
    status: "grounded",
    mode: "keyword",
    chunks: scored,
    injected: buildContext(scored),
  };
}

/**
 * Reciprocal Rank Fusion (RRF) over several ranked chunk lists — the merge SEAM
 * for the deferred hybrid path (5A). Not wired into the live retrieval flow yet
 * (steady state stays pure-vector); it ships now, unit-tested in isolation, so
 * turning on lexical+vector fusion later is a wiring change, not a rewrite.
 *
 * RRF score = Σ 1 / (rrfK + rank) across the lists a chunk appears in. Chunks
 * are deduped by id; rank is 0-based within each input list. rrfK (default 60,
 * the canonical value) damps the contribution of low-ranked items.
 */
export function mergeRankings(
  rankings: readonly ScoredChunk[][],
  k: number,
  rrfK = 60
): ScoredChunk[] {
  const byId = new Map<string, { chunk: ScoredChunk; score: number }>();
  for (const list of rankings) {
    list.forEach((chunk, rank) => {
      const contribution = 1 / (rrfK + rank);
      const existing = byId.get(chunk.id);
      if (existing) existing.score += contribution;
      else byId.set(chunk.id, { chunk, score: contribution });
    });
  }
  return [...byId.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((e) => ({ ...e.chunk, score: e.score }));
}
