/**
 * Labeled retrieval cases for the D9 grounding eval gate.
 *
 * Each query is deliberately PARAPHRASED — it shares little vocabulary with the
 * note it should retrieve — so the gate measures real semantic recall, not
 * keyword overlap. `expectNote` is the fixture file that must be surfaced;
 * `mustContain` is a verbatim snippet from that note which must actually land
 * in the injected prompt (the differentiator: grounding has to reach the model,
 * not just rank well).
 */
export interface EvalCase {
  query: string;
  expectNote: string;
  mustContain: string;
}

export const CASES: readonly EvalCase[] = [
  {
    query: "how long should I leave my bread dough out before shaping it",
    expectNote: "sourdough.md",
    mustContain: "bulk ferment",
  },
  {
    query: "best way to put money aside for when I stop working",
    expectNote: "retirement.md",
    mustContain: "index fund",
  },
  {
    query: "how should I cut back my mileage in the weeks before a big race",
    expectNote: "marathon.md",
    mustContain: "taper",
  },
  {
    query: "why does the compiler reject using a variable after I assign it elsewhere",
    expectNote: "rust-ownership.md",
    mustContain: "used after move",
  },
  {
    query: "what is the prettiest time to visit Japan for fall colors",
    expectNote: "kyoto-trip.md",
    mustContain: "autumn foliage",
  },
  {
    query: "tips to fall asleep faster and wake up less groggy",
    expectNote: "sleep.md",
    mustContain: "circadian rhythm",
  },
  {
    query: "how do I play a ii V I chord progression",
    expectNote: "jazz-piano.md",
    mustContain: "two-five-one",
  },
  {
    query: "how do I stop my garden plants from getting fungal disease",
    expectNote: "tomatoes.md",
    mustContain: "blight",
  },
  {
    query: "philosophy about only worrying over what you can influence",
    expectNote: "stoicism.md",
    mustContain: "dichotomy of control",
  },
  {
    query: "when is our product going live and who owns the code freeze",
    expectNote: "project-apollo.md",
    mustContain: "Q3 launch",
  },
];
