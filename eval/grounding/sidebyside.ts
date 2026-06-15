/**
 * Side-by-side retrieval eval: keyword (search_vault) vs semantic (deep_search).
 *
 * The agentic loop chooses between two retrieval engines — fast BM25 keyword
 * search, and embedding-based semantic search. This eval runs the SAME fixture
 * vault and the SAME deliberately-paraphrased cases (cases.ts) through BOTH
 * engines and reports recall@1 / recall@5 / MRR / context-landed for each,
 * head to head. It answers the open question from the embeddings-vs-agentic
 * fork: does deep_search catch what keyword search misses on real, paraphrased
 * questions — i.e. do embeddings earn their keep, or can they be deleted?
 *
 * Uses the REAL local embedder (≈90MB download on first run, offline after), so
 * it is a standalone script, NOT part of `npm test`.
 *
 *   npx tsx eval/grounding/sidebyside.ts
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { GroundingService } from "../../src/grounding/vaultIndexer.js";
import { TransformersEmbedder } from "../../src/grounding/embedderTransformers.js";
import { CASES } from "./cases.js";
import type { ScoredChunk } from "../../src/grounding/types.js";

const K = 5;

function baseName(p: string): string {
  return path.basename(p);
}

interface EngineResult {
  rank: number; // 1-based rank of the first chunk from the expected note; Infinity if absent
  landed: boolean; // the verbatim mustContain snippet appears in the returned chunks
}

/** Rank of the expected note + whether the must-contain snippet landed, for one
 *  engine's ranked chunk list. A null list (semantic not usable) → a clean miss. */
function score(
  chunks: ScoredChunk[] | null,
  expectNote: string,
  mustContain: string
): EngineResult {
  if (chunks === null) return { rank: Infinity, landed: false };
  let rank = Infinity;
  for (let i = 0; i < chunks.length; i++) {
    if (baseName(chunks[i]!.notePath) === expectNote) {
      rank = i + 1;
      break;
    }
  }
  const landed = chunks.some((c) => c.text.includes(mustContain));
  return { rank, landed };
}

interface Metrics {
  recallAt1: number;
  recallAt5: number;
  mrr: number;
  landed: number;
}

function summarize(results: EngineResult[]): Metrics {
  const n = results.length;
  return {
    recallAt1: results.filter((r) => r.rank === 1).length / n,
    recallAt5: results.filter((r) => r.rank <= K).length / n,
    mrr: results.reduce((s, r) => s + (r.rank === Infinity ? 0 : 1 / r.rank), 0) / n,
    landed: results.filter((r) => r.landed).length / n,
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function rankStr(r: number): string {
  return r === Infinity ? "—" : String(r);
}

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const vaultDir = path.join(here, "vault");

  console.log("Indexing fixture vault with the real local embedder…");
  const svc = new GroundingService(new TransformersEmbedder(), {
    retrieve: { k: K, minScore: 0.2 },
  });
  const counts = await svc.indexVault(vaultDir);
  console.log(`Indexed ${counts.notes} notes, ${counts.chunks} chunks.\n`);

  const keyword: EngineResult[] = [];
  const semantic: EngineResult[] = [];

  console.log(
    "query".padEnd(58),
    "expected".padEnd(18),
    "kw".padEnd(4),
    "sem".padEnd(4),
    "kw·land",
    "sem·land"
  );
  console.log("-".repeat(100));

  for (const c of CASES) {
    const kw = score(svc.searchLexical(c.query, K), c.expectNote, c.mustContain);
    const sem = score(await svc.searchSemantic(c.query, K), c.expectNote, c.mustContain);
    keyword.push(kw);
    semantic.push(sem);
    console.log(
      c.query.slice(0, 56).padEnd(58),
      c.expectNote.padEnd(18),
      rankStr(kw.rank).padEnd(4),
      rankStr(sem.rank).padEnd(4),
      (kw.landed ? "yes" : "NO").padEnd(7),
      sem.landed ? "yes" : "NO"
    );
  }

  const kwM = summarize(keyword);
  const semM = summarize(semantic);

  const row = (label: string, k: number, s: number) =>
    console.log(`  ${label.padEnd(16)} keyword ${pct(k).padStart(4)}   semantic ${pct(s).padStart(4)}`);
  console.log("\nMetrics (keyword = search_vault, semantic = deep_search)");
  row("recall@1", kwM.recallAt1, semM.recallAt1);
  row(`recall@${K}`, kwM.recallAt5, semM.recallAt5);
  row("context landed", kwM.landed, semM.landed);
  console.log(
    `  ${"MRR".padEnd(16)} keyword ${kwM.mrr.toFixed(2)}   semantic ${semM.mrr.toFixed(2)}`
  );

  // The decision signal: cases keyword MISSES (right note not in top-K, or the
  // snippet never landed) that semantic RESCUES. These are exactly the questions
  // that justify keeping embeddings as the deep_search escalation tool.
  const rescued = CASES.filter((_, i) => {
    const kwMiss = keyword[i]!.rank > K || !keyword[i]!.landed;
    const semHit = semantic[i]!.rank <= K && semantic[i]!.landed;
    return kwMiss && semHit;
  });
  const semOnlyLost = CASES.filter((_, i) => {
    const semMiss = semantic[i]!.rank > K || !semantic[i]!.landed;
    const kwHit = keyword[i]!.rank <= K && keyword[i]!.landed;
    return semMiss && kwHit;
  });

  console.log(`\nDeep_search rescued ${rescued.length}/${CASES.length} cases keyword missed:`);
  for (const c of rescued) console.log(`  + ${c.query}`);
  if (semOnlyLost.length > 0) {
    console.log(`\nKeyword-only wins (semantic missed) — ${semOnlyLost.length}:`);
    for (const c of semOnlyLost) console.log(`  - ${c.query}`);
  }

  console.log(
    rescued.length > 0
      ? "\nVERDICT: deep_search earns its keep — it recovers questions keyword search cannot."
      : "\nVERDICT: keyword alone covered every case — embeddings add no recall on this set."
  );
}

main().catch((err) => {
  console.error("eval crashed:", err);
  process.exitCode = 1;
});
