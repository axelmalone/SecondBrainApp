import { describe, it, expect } from "vitest";
import {
  groundingAnnouncement,
  uniqueNoteNames,
  UNGROUNDED_REASON,
} from "../src/renderer/groundingText.js";
import type { GroundingMeta, GroundingSource } from "../src/shared/ai.js";

const src = (notePath: string): GroundingSource => ({ notePath } as GroundingSource);

describe("groundingAnnouncement (D12 aria-live wording)", () => {
  it("names the cited notes (deduped, .md stripped) when grounded", () => {
    const g: GroundingMeta = {
      grounded: true,
      mode: "semantic",
      sources: [src("Projects/Helsinki.md"), src("Projects/Helsinki.md"), src("Pricing.md")],
    };
    expect(groundingAnnouncement(g)).toBe(
      "Answer grounded in 2 notes: Helsinki, Pricing."
    );
  });

  it("uses the singular 'note' for exactly one source", () => {
    const g: GroundingMeta = { grounded: true, mode: "semantic", sources: [src("Daily.md")] };
    expect(groundingAnnouncement(g)).toBe("Answer grounded in 1 note: Daily.");
  });

  it("falls back to a generic grounded phrase when grounded but no named sources", () => {
    const g: GroundingMeta = { grounded: true, mode: "semantic", sources: [] };
    expect(groundingAnnouncement(g)).toBe("Answer grounded in your vault.");
  });

  it("speaks keyword mode distinctly so the deep index isn't implied", () => {
    const named: GroundingMeta = {
      grounded: true,
      mode: "keyword",
      sources: [src("Daily.md")],
    };
    expect(groundingAnnouncement(named)).toBe(
      "Answer drawn from a keyword match in 1 note: Daily."
    );
    const unnamed: GroundingMeta = { grounded: true, mode: "keyword", sources: [] };
    expect(groundingAnnouncement(unnamed)).toBe(
      "Answer drawn from a keyword match in your vault."
    );
  });

  it("speaks every ungrounded reason — the trust signal a blind user must hear", () => {
    for (const reason of Object.keys(UNGROUNDED_REASON) as (keyof typeof UNGROUNDED_REASON)[]) {
      const g = { grounded: false, reason } as GroundingMeta;
      expect(groundingAnnouncement(g)).toBe(
        `Answering without vault context: ${UNGROUNDED_REASON[reason]}.`
      );
    }
  });
});

describe("uniqueNoteNames", () => {
  it("preserves first-seen order and dedupes by path", () => {
    expect(
      uniqueNoteNames([src("a/One.md"), src("b/Two.md"), src("a/One.md")])
    ).toEqual(["One", "Two"]);
  });
});
