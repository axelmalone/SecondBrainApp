import { describe, it, expect } from "vitest";
import { chunkMarkdown } from "../src/grounding/chunk.js";
import { VectorIndex, cosine } from "../src/grounding/vectorIndex.js";
import {
  retrieve,
  retrieveLexical,
  mergeRankings,
  buildContext,
} from "../src/grounding/retrieve.js";
import { LexicalIndex } from "../src/grounding/lexicalIndex.js";
import type { Embedder, IndexedChunk, ScoredChunk } from "../src/grounding/types.js";

const DIM = 64;

/**
 * Deterministic bag-of-words embedder: hash each lowercased token into one of
 * DIM buckets and count. Similar text → similar vectors, with no model/network.
 * Good enough to exercise top-k ranking, the threshold, and the D12 branches.
 */
class FakeEmbedder implements Embedder {
  readonly dimension = DIM;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(DIM).fill(0);
      for (const tok of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        let h = 0;
        for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) | 0;
        const bucket = Math.abs(h) % DIM;
        v[bucket] = (v[bucket] ?? 0) + 1;
      }
      return v;
    });
  }
}

/** A throwing embedder to drive the D12 embed-failed branch. */
class BrokenEmbedder implements Embedder {
  readonly dimension = DIM;
  async embed(): Promise<number[][]> {
    throw new Error("model failed to load");
  }
}

async function indexNotes(
  embedder: Embedder,
  notes: Record<string, string>
): Promise<VectorIndex> {
  const index = new VectorIndex();
  for (const [path, md] of Object.entries(notes)) {
    const chunks = chunkMarkdown(path, md);
    const vectors = await embedder.embed(chunks.map((c) => c.text));
    const indexed: IndexedChunk[] = chunks.map((c, i) => ({
      ...c,
      vector: vectors[i] as number[],
    }));
    index.add(indexed);
  }
  return index;
}

describe("chunkMarkdown", () => {
  it("splits on headings and attaches the nearest heading", () => {
    const md = "# Title\n\nIntro para.\n\n## Section A\n\nBody of A.\n";
    const chunks = chunkMarkdown("n.md", md);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const a = chunks.find((c) => c.text.includes("Body of A"));
    expect(a?.heading).toBe("Section A");
    expect(chunks.every((c) => c.id.startsWith("n.md#"))).toBe(true);
  });

  it("drops empty notes to zero chunks", () => {
    expect(chunkMarkdown("n.md", "\n\n   \n")).toEqual([]);
  });
});

describe("cosine", () => {
  it("is 1 for identical direction and 0 for orthogonal", () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("retrieve (D9 happy path)", () => {
  it("returns the most relevant note's chunk first, with an injection", async () => {
    const embedder = new FakeEmbedder();
    const index = await indexNotes(embedder, {
      "cooking.md": "# Pasta\n\nBoil water and add salt before the pasta.",
      "finance.md": "# Budget\n\nTrack monthly spending in a spreadsheet.",
    });

    const res = await retrieve(embedder, index, "how do I cook pasta in water", {
      k: 3,
      minScore: 0.01,
    });

    expect(res.status).toBe("grounded");
    if (res.status !== "grounded") return;
    expect(res.chunks[0]?.notePath).toBe("cooking.md");
    expect(res.injected).toContain("Boil water");
    expect(res.injected).toContain("VAULT EXCERPTS");
  });
});

describe("retrieve marks the semantic mode", () => {
  it("a vector-grounded answer reports mode: semantic", async () => {
    const embedder = new FakeEmbedder();
    const index = await indexNotes(embedder, { "a.md": "boil water for pasta" });
    const res = await retrieve(embedder, index, "pasta water", { minScore: 0.01 });
    expect(res.status).toBe("grounded");
    if (res.status === "grounded") expect(res.mode).toBe("semantic");
  });
});

describe("retrieveLexical (the instant keyword path)", () => {
  const lex = (notes: Record<string, string>): LexicalIndex => {
    const ix = new LexicalIndex();
    for (const [path, md] of Object.entries(notes)) {
      ix.add(chunkMarkdown(path, md));
    }
    return ix;
  };

  it("grounds in keyword mode with no embedder, carrying chunks for [n] citations", () => {
    const ix = lex({
      "cooking.md": "# Pasta\n\nBoil water and add salt before the pasta.",
      "finance.md": "# Budget\n\nTrack monthly spending in a spreadsheet.",
    });
    const res = retrieveLexical(ix, "how do I boil pasta", { k: 3 });
    expect(res.status).toBe("grounded");
    if (res.status !== "grounded") return;
    expect(res.mode).toBe("keyword");
    expect(res.chunks[0]?.notePath).toBe("cooking.md");
    // The [n] citation contract: each excerpt keeps notePath + text so a keyword
    // answer's inline [1] still resolves to a real source.
    expect(res.injected).toContain("[1] cooking.md");
    expect(res.injected).toContain("Boil water");
  });

  it("empty lexical index → empty-index; off-topic query → no-matches (D12 honesty)", () => {
    expect(retrieveLexical(new LexicalIndex(), "anything")).toEqual({
      status: "unavailable",
      reason: "empty-index",
    });
    const ix = lex({ "a.md": "quantum chromodynamics lattice gauge theory" });
    expect(retrieveLexical(ix, "banana smoothie recipe")).toEqual({
      status: "unavailable",
      reason: "no-matches",
    });
  });
});

describe("mergeRankings (RRF seam for the deferred hybrid path)", () => {
  const sc = (id: string, score: number): ScoredChunk => ({
    id,
    notePath: id,
    text: id,
    score,
  });

  it("fuses two rankings by reciprocal rank, deduping by id", () => {
    const lexical = [sc("a", 9), sc("b", 8), sc("c", 7)];
    const vector = [sc("c", 0.9), sc("a", 0.8), sc("d", 0.7)];
    const merged = mergeRankings([lexical, vector], 3);
    // 'a' (ranks 0 and 1) and 'c' (ranks 2 and 0) appear in both → they rise
    // above 'b' and 'd' which appear once.
    expect(merged.map((c) => c.id).slice(0, 2).sort()).toEqual(["a", "c"]);
    expect(merged.length).toBe(3);
    expect(new Set(merged.map((c) => c.id)).size).toBe(3); // deduped
  });
});

describe("retrieve (D12 visible-fail contract)", () => {
  it("empty index → unavailable: empty-index", async () => {
    const res = await retrieve(new FakeEmbedder(), new VectorIndex(), "anything");
    expect(res).toEqual({ status: "unavailable", reason: "empty-index" });
  });

  it("a throwing embedder → unavailable: embed-failed (never throws)", async () => {
    // Index built with the working embedder so it is non-empty…
    const index = await indexNotes(new FakeEmbedder(), { "a.md": "hello world" });
    // …but the query embedding fails.
    const res = await retrieve(new BrokenEmbedder(), index, "hello");
    expect(res).toEqual({ status: "unavailable", reason: "embed-failed" });
  });

  it("all matches below threshold → unavailable: no-matches", async () => {
    const embedder = new FakeEmbedder();
    const index = await indexNotes(embedder, {
      "a.md": "quantum chromodynamics lattice gauge theory",
    });
    const res = await retrieve(embedder, index, "banana smoothie recipe", {
      minScore: 0.5,
    });
    expect(res).toEqual({ status: "unavailable", reason: "no-matches" });
  });
});

describe("VectorIndex.replaceNote", () => {
  it("swaps a note's chunks without touching others", async () => {
    const embedder = new FakeEmbedder();
    const index = await indexNotes(embedder, {
      "a.md": "alpha content here",
      "b.md": "beta content here",
    });
    const sizeBefore = index.size;

    const newChunks = chunkMarkdown("a.md", "alpha rewritten entirely new text");
    const vectors = await embedder.embed(newChunks.map((c) => c.text));
    index.replaceNote(
      "a.md",
      newChunks.map((c, i) => ({ ...c, vector: vectors[i] as number[] }))
    );

    expect(index.size).toBe(sizeBefore - 1 + newChunks.length);
    const res = await retrieve(embedder, index, "beta content", { minScore: 0.01 });
    expect(res.status).toBe("grounded");
  });
});

describe("buildContext", () => {
  it("labels chunks with path and heading", () => {
    const out = buildContext([
      { id: "n#0", notePath: "n.md", heading: "Goals", text: "ship M1", score: 0.9 },
    ]);
    expect(out).toContain("n.md › Goals");
    expect(out).toContain("ship M1");
  });

  it("numbers excerpts [1]..[n] so the model can cite them by index", () => {
    const out = buildContext([
      { id: "a#0", notePath: "a.md", text: "first", score: 0.9 },
      { id: "b#0", notePath: "b.md", text: "second", score: 0.8 },
    ]);
    // Each excerpt is prefixed with its 1-based citation number; the renderer
    // maps an inline [n] back to sources[n-1], so this alignment is a contract.
    expect(out).toContain("[1] a.md");
    expect(out).toContain("[2] b.md");
    // And the model is told to cite inline.
    expect(out.toLowerCase()).toContain("cite it inline");
  });
});
