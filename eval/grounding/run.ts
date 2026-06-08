/**
 * D9 grounding eval gate.
 *
 * Indexes a FIXED vault fixture with the REAL local embedder and runs a set of
 * paraphrased queries (cases.ts) through the same GroundingService the app uses.
 * It measures whether the right note is retrieved (recall@1, recall@5, MRR) and
 * whether the expected text actually lands in the injected prompt — the thing
 * that makes grounding the product's differentiator.
 *
 * The fake bag-of-words embedder used in unit tests would reward keyword overlap
 * and tell us nothing about semantic quality, so this gate uses the real model.
 * That makes it heavy (≈90MB model download on first run) and offline-after, so
 * it is a standalone `npm run eval:grounding`, NOT part of the fast `npm test`.
 *
 * Exits non-zero if any threshold is missed, so it can gate CI / a release.
 *
 *   npx tsx eval/grounding/run.ts
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { GroundingService } from "../../src/grounding/vaultIndexer.js";
import { TransformersEmbedder } from "../../src/grounding/embedderTransformers.js";
import { CASES } from "./cases.js";

const K = 5;

// Gate thresholds. recall@5 must be perfect — with ten clearly distinct notes,
// failing to even surface the right one in the top five is a real regression.
const THRESHOLDS = {
  recallAt1: 0.8,
  recallAt5: 1.0,
  contextLanded: 0.9,
};

interface CaseResult {
  query: string;
  expectNote: string;
  rank: number; // 1-based rank of the first chunk from the expected note; Infinity if absent
  topScore: number;
  landed: boolean;
}

function baseName(p: string): string {
  return path.basename(p);
}

async function evaluate(svc: GroundingService): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const c of CASES) {
    const res = await svc.ground(c.query);
    if (res.status !== "grounded") {
      results.push({
        query: c.query,
        expectNote: c.expectNote,
        rank: Infinity,
        topScore: 0,
        landed: false,
      });
      continue;
    }
    let rank = Infinity;
    for (let i = 0; i < res.chunks.length; i++) {
      if (baseName(res.chunks[i]!.notePath) === c.expectNote) {
        rank = i + 1;
        break;
      }
    }
    results.push({
      query: c.query,
      expectNote: c.expectNote,
      rank,
      topScore: res.chunks[0]?.score ?? 0,
      landed: res.injected.includes(c.mustContain),
    });
  }
  return results;
}

function summarize(results: CaseResult[]): {
  recallAt1: number;
  recallAt5: number;
  mrr: number;
  contextLanded: number;
} {
  const n = results.length;
  const recallAt1 = results.filter((r) => r.rank === 1).length / n;
  const recallAt5 = results.filter((r) => r.rank <= K).length / n;
  const mrr =
    results.reduce((s, r) => s + (r.rank === Infinity ? 0 : 1 / r.rank), 0) / n;
  const contextLanded = results.filter((r) => r.landed).length / n;
  return { recallAt1, recallAt5, mrr, contextLanded };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
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

  const results = await evaluate(svc);

  // Per-case table.
  console.log("query".padEnd(62), "expected".padEnd(20), "rank", "score", "landed");
  console.log("-".repeat(102));
  for (const r of results) {
    const rank = r.rank === Infinity ? "—" : String(r.rank);
    console.log(
      r.query.slice(0, 60).padEnd(62),
      r.expectNote.padEnd(20),
      rank.padEnd(4),
      r.topScore.toFixed(2).padEnd(5),
      r.landed ? "yes" : "NO"
    );
  }

  const m = summarize(results);
  console.log("\nMetrics");
  console.log(`  recall@1        ${pct(m.recallAt1)}  (gate ≥ ${pct(THRESHOLDS.recallAt1)})`);
  console.log(`  recall@${K}        ${pct(m.recallAt5)}  (gate ≥ ${pct(THRESHOLDS.recallAt5)})`);
  console.log(`  MRR             ${m.mrr.toFixed(3)}`);
  console.log(`  context landed  ${pct(m.contextLanded)}  (gate ≥ ${pct(THRESHOLDS.contextLanded)})`);

  const failures: string[] = [];
  if (m.recallAt1 < THRESHOLDS.recallAt1) failures.push("recall@1");
  if (m.recallAt5 < THRESHOLDS.recallAt5) failures.push(`recall@${K}`);
  if (m.contextLanded < THRESHOLDS.contextLanded) failures.push("context-landed");

  if (failures.length > 0) {
    console.error(`\nGATE FAILED: ${failures.join(", ")} below threshold.`);
    process.exitCode = 1;
    return;
  }
  console.log("\nGATE PASSED.");
}

main().catch((err) => {
  console.error("eval crashed:", err);
  process.exitCode = 1;
});
