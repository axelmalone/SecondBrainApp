import type { Embedder, GroundingResult, ScoredChunk } from "./types.js";
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
  const blocks = chunks.map((c) => {
    const label = c.heading ? `${c.notePath} › ${c.heading}` : c.notePath;
    return `[${label}]\n${c.text}`;
  });
  return [
    "You are answering using excerpts from the user's personal notes (their vault).",
    "Use the excerpts below when they are relevant. If they do not contain the answer,",
    "say so plainly rather than inventing one.",
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

  return { status: "grounded", chunks: usable, injected: buildContext(usable) };
}
