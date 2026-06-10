import { describe, it, expect } from "vitest";
import { LexicalIndex, stem, tokenize } from "../src/grounding/lexicalIndex.js";
import type { Chunk } from "../src/grounding/types.js";

const chunk = (id: string, notePath: string, text: string, heading?: string): Chunk =>
  heading !== undefined ? { id, notePath, text, heading } : { id, notePath, text };

describe("tokenize", () => {
  it("lowercases, splits on non-word, drops stopwords and single chars", () => {
    expect(tokenize("The Quick, BROWN fox! a")).toEqual(["quick", "brown", "fox"]);
  });

  it("stems an inflectional family to a shared root so query variants match (recall)", () => {
    // Porter is a stemmer, not a lemmatizer: it collapses inflections (plural,
    // -ed, -ing) but NOT derivational pairs like decided/decision. The recall win
    // is real on the families it does merge.
    const ship = tokenize("ship shipped shipping ships");
    expect(new Set(ship)).toEqual(new Set(["ship"]));
    expect(tokenize("decided")[0]).toBe(tokenize("deciding")[0]);
  });

  it("passes numbers through unstemmed", () => {
    expect(tokenize("budget 2026 q3")).toContain("2026");
  });
});

describe("stem — pinned to the published Porter test vocabulary", () => {
  // A representative slice of Porter's canonical voc.txt → output.txt pairs,
  // covering each step of the algorithm. A subtly-wrong stemmer fails here.
  const cases: [string, string][] = [
    ["caresses", "caress"],
    ["ponies", "poni"],
    ["ties", "ti"],
    ["caress", "caress"],
    ["cats", "cat"],
    ["feed", "feed"],
    ["agreed", "agre"],
    ["plastered", "plaster"],
    ["motoring", "motor"],
    ["sing", "sing"],
    ["conflated", "conflat"],
    ["troubled", "troubl"],
    ["sized", "size"],
    ["happy", "happi"],
    ["relational", "relat"],
    ["conditional", "condit"],
    ["rational", "ration"],
    ["valenci", "valenc"],
    ["digitizer", "digit"],
    ["conformabli", "conform"],
    ["radicalli", "radic"],
    ["vietnamization", "vietnam"],
    ["predication", "predic"],
    ["operator", "oper"],
    ["feudalism", "feudal"],
    ["decisiveness", "decis"],
    ["hopefulness", "hope"],
    ["callousness", "callous"],
    ["triplicate", "triplic"],
    ["formative", "form"],
    ["formalize", "formal"],
    ["electriciti", "electr"],
    ["electrical", "electr"],
    ["hopeful", "hope"],
    ["goodness", "good"],
    ["revival", "reviv"],
    ["allowance", "allow"],
    ["inference", "infer"],
    ["airliner", "airlin"],
    ["adjustable", "adjust"],
    ["defensible", "defens"],
    ["irritant", "irrit"],
    ["replacement", "replac"],
    ["adjustment", "adjust"],
    ["dependent", "depend"],
    ["communism", "commun"],
    ["activate", "activ"],
    ["effective", "effect"],
    ["bowdlerize", "bowdler"],
    ["probate", "probat"],
    ["rate", "rate"],
    ["cease", "ceas"],
    ["controll", "control"],
    ["roll", "roll"],
  ];
  it.each(cases)("stem(%s) → %s", (input, expected) => {
    expect(stem(input)).toBe(expected);
  });
});

describe("LexicalIndex — BM25", () => {
  const build = (): LexicalIndex => {
    const ix = new LexicalIndex();
    ix.add([
      chunk("a#0", "a.md", "We decided to ship the pricing change next week.", "Decisions"),
      chunk("b#0", "b.md", "The garden needs watering and the tomatoes are ripe."),
      chunk("c#0", "c.md", "Pricing experiments and the decision to raise the tier."),
    ]);
    return ix;
  };

  it("ranks the most term-relevant chunk first and matches a stemmed variant", () => {
    const ix = build();
    // "decision" should match "decided" / "decided to" via stemming.
    const hits = ix.search("what was the pricing decision", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(["a.md", "c.md"]).toContain(hits[0]?.notePath);
    expect(hits.map((h) => h.notePath)).not.toContain("b.md");
  });

  it("folds the heading into the searchable text", () => {
    const ix = build();
    const hits = ix.search("decisions", 5);
    expect(hits.map((h) => h.notePath)).toContain("a.md");
  });

  it("its OWN relevance gate (7A): off-topic query → no matches, not noise", () => {
    const ix = build();
    expect(ix.search("submarine periscope helium", 5)).toEqual([]);
  });

  it("empty / stopword-only / punctuation queries return nothing", () => {
    const ix = build();
    expect(ix.search("", 5)).toEqual([]);
    expect(ix.search("the and to of", 5)).toEqual([]);
    expect(ix.search("!!! ,. ?", 5)).toEqual([]);
  });

  it("removeNote drops a note's chunks; replaceNote swaps without dupes", () => {
    const ix = build();
    expect(ix.size).toBe(3);
    ix.removeNote("a.md");
    expect(ix.size).toBe(2);
    expect(ix.search("decided pricing", 5).map((h) => h.notePath)).not.toContain("a.md");

    ix.replaceNote("c.md", [chunk("c#0", "c.md", "Completely different content about hiking trails.")]);
    expect(ix.size).toBe(2);
    const hits = ix.search("hiking trails", 5);
    expect(hits.map((h) => h.notePath)).toEqual(["c.md"]);
  });

  it("empty index returns nothing", () => {
    expect(new LexicalIndex().search("anything", 5)).toEqual([]);
  });
});
