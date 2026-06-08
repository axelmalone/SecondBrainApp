/**
 * Proposal-quality eval gate (8A).
 *
 * Runs the fixed cases (cases.ts) through the SAME runProposalTurn the app uses,
 * with the SAME proposalPolicyMessage prompt, against a real model, and checks
 * that each turn produces the expected proposal TYPE + rough TARGET (or no
 * proposal for the Q&A cases). It regression-guards the propose tool and the
 * grounding × tool-use prompt design as they change.
 *
 * Like the grounding eval, it needs the real model, so it is a STANDALONE
 * `npm run eval:proposals`, NOT part of the fast `npm test`. It reads the key
 * from ANTHROPIC_API_KEY (or OPENAI_API_KEY) and SKIPS cleanly (exit 0) when no
 * key is present, so CI without a key is green.
 *
 *   ANTHROPIC_API_KEY=sk-... npx tsx eval/proposals/run.ts
 */
import { ModelGateway } from "../../src/gateway/gateway.js";
import { KeyStore } from "../../src/gateway/keyStore.js";
import { InMemoryKeychain } from "../../src/gateway/keychain.js";
import { anthropicAdapter } from "../../src/gateway/providers/anthropic.js";
import { openaiAdapter } from "../../src/gateway/providers/openai.js";
import { runProposalTurn } from "../../src/gateway/propose.js";
import { proposalPolicyMessage } from "../../src/gateway/proposalPrompt.js";
import type { ModelSpec } from "../../src/shared/ai.js";
import { CASES } from "./cases.js";

const PASS_THRESHOLD = 0.8; // ≥80% of cases must match TYPE + rough target.

async function main(): Promise<void> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!anthropicKey && !openaiKey) {
    console.log("eval:proposals SKIPPED — set ANTHROPIC_API_KEY or OPENAI_API_KEY to run.");
    return;
  }

  const provider = anthropicKey ? "anthropic" : "openai";
  const model: ModelSpec = anthropicKey
    ? { provider: "anthropic", model: "claude-sonnet-4-6" }
    : { provider: "openai", model: "gpt-4o" };

  const ks = await KeyStore.open({
    path: `/tmp/sb-eval-keys-${Date.now()}.enc`,
    keychain: new InMemoryKeychain(true),
  });
  await ks.setKey(provider, (anthropicKey ?? openaiKey)!);

  const gateway = new ModelGateway({
    keyStore: ks,
    adapters: { anthropic: anthropicAdapter, openai: openaiAdapter },
    fetchImpl: (url, init) => fetch(url, init),
  });

  let passed = 0;
  for (const c of CASES) {
    let ok = false;
    let detail = "";
    try {
      const { parsed } = await runProposalTurn(gateway, {
        model,
        messages: [proposalPolicyMessage(), { role: "user", content: c.prompt }],
      });
      const kind = parsed.proposal?.kind ?? null;
      const target = parsed.proposal?.targetPath?.toLowerCase() ?? "";
      const kindOk = kind === c.expectKind;
      const targetOk =
        c.expectKind === null ||
        !c.expectTargetIncludes ||
        target.includes(c.expectTargetIncludes);
      ok = kindOk && targetOk;
      detail = `kind=${kind} target=${target || "—"}`;
    } catch (err) {
      detail = `threw ${String(err)}`;
    }
    if (ok) passed++;
    console.log(`${ok ? "✓" : "✗"} [${c.expectKind ?? "no-proposal"}] ${c.prompt.slice(0, 60)}… → ${detail}`);
  }

  const rate = passed / CASES.length;
  console.log(`\nproposal quality: ${passed}/${CASES.length} (${Math.round(rate * 100)}%)`);
  if (rate < PASS_THRESHOLD) {
    console.error(`FAIL — below ${Math.round(PASS_THRESHOLD * 100)}% threshold.`);
    process.exit(1);
  }
  console.log("PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
