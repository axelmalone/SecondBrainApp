/**
 * Labeled proposal-quality cases for the write-back eval gate (8A).
 *
 * Each case is a user message paired with the proposal we expect the model to
 * emit. We assert the proposal's TYPE and a rough TARGET — never the exact text,
 * which a model will phrase differently every run. The Q&A cases assert that NO
 * proposal is produced (the common, non-error path): a question is just a
 * question. This gate regression-guards the propose tool + the grounding ×
 * tool-use prompt design (proposalPrompt.ts) as those evolve.
 */
export interface ProposalEvalCase {
  prompt: string;
  /** Expected proposal kind, or null when the turn should be a plain answer. */
  expectKind: "create" | "append" | "update" | null;
  /** A lowercased substring the targetPath should contain (rough target check). */
  expectTargetIncludes?: string;
}

export const CASES: readonly ProposalEvalCase[] = [
  {
    prompt:
      "Log to my daily note for today that I shipped the write-back loop and felt good about it.",
    expectKind: "append",
    expectTargetIncludes: "daily",
  },
  {
    prompt:
      "Make a brand-new note called 'Spline Animations' capturing that splines interpolate smoothly between keyframes.",
    expectKind: "create",
    expectTargetIncludes: "spline",
  },
  {
    prompt:
      "My note 'sourdough' says bulk ferment 4 hours — update it to say 5 hours at room temperature.",
    expectKind: "update",
    expectTargetIncludes: "sourdough",
  },
  {
    prompt: "What temperature should I proof sourdough at? Just tell me, don't change anything.",
    expectKind: null,
  },
  {
    prompt: "Summarize the key idea of stoicism in two sentences.",
    expectKind: null,
  },
];
