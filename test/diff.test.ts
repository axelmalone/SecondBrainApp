import { describe, it, expect } from "vitest";
import { diffBlocks, composeBlocks, allSelected } from "../src/shared/diff.js";

const allIds = (blocks: ReturnType<typeof diffBlocks>): Set<number> =>
  new Set(blocks.filter((b) => b.type === "change").map((b) => (b as { id: number }).id));

describe("diffBlocks", () => {
  it("represents a pure addition (create) as one all-add change block", () => {
    const blocks = diffBlocks("", "line1\nline2\n");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "change", del: [], add: ["line1", "line2"] });
  });

  it("represents an append as a trailing change block after context", () => {
    const blocks = diffBlocks("# Log\n", "# Log\n- new entry\n");
    expect(blocks[0]).toMatchObject({ type: "context", lines: ["# Log"] });
    const change = blocks.find((b) => b.type === "change");
    expect(change).toMatchObject({ add: ["- new entry"] });
  });

  it("captures a mid-file replacement as a change with del + add", () => {
    const blocks = diffBlocks("a\nOLD\nc\n", "a\nNEW\nc\n");
    const change = blocks.find((b) => b.type === "change");
    expect(change).toMatchObject({ del: ["OLD"], add: ["NEW"] });
  });

  it("produces multiple independent hunks for separate edits", () => {
    const base = "a\nb\nc\nd\ne\n";
    const next = "a\nB\nc\nd\nE\n";
    const blocks = diffBlocks(base, next);
    const changes = blocks.filter((b) => b.type === "change");
    expect(changes).toHaveLength(2);
  });
});

describe("composeBlocks — hunk-vs-whole approval", () => {
  it("approving all hunks reproduces the full proposed text", () => {
    const base = "a\nb\nc\nd\ne\n";
    const next = "a\nB\nc\nd\nE\n";
    const blocks = diffBlocks(base, next);
    expect(composeBlocks(blocks, allIds(blocks))).toBe(next);
    expect(allSelected(blocks, allIds(blocks))).toBe(true);
  });

  it("approving no hunks reproduces the original base text", () => {
    const base = "a\nB\nc\n";
    const next = "a\nX\nc\n";
    const blocks = diffBlocks(base, next);
    expect(composeBlocks(blocks, new Set())).toBe(base);
    expect(allSelected(blocks, new Set())).toBe(false);
  });

  it("approving one of two hunks applies only that change", () => {
    const base = "a\nb\nc\nd\ne\n";
    const next = "a\nB\nc\nd\nE\n";
    const blocks = diffBlocks(base, next);
    const changes = blocks.filter((b) => b.type === "change") as { id: number }[];
    const firstOnly = new Set([changes[0]!.id]);
    expect(composeBlocks(blocks, firstOnly)).toBe("a\nB\nc\nd\ne\n");
  });
});
