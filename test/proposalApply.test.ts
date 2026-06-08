import { describe, it, expect } from "vitest";
import {
  applyAnchoredAppend,
  normalizeForCompare,
  triviallyEqual,
} from "../src/main/proposalApply.js";

describe("applyAnchoredAppend", () => {
  it("appends at the end when there is no anchor", () => {
    expect(applyAnchoredAppend("a\nb\n", undefined, "- new")).toBe("a\nb\n- new\n");
  });

  it("adds a trailing newline to a file that lacks one before appending", () => {
    expect(applyAnchoredAppend("a\nb", undefined, "- new")).toBe("a\nb\n- new\n");
  });

  it("creates content from empty", () => {
    expect(applyAnchoredAppend("", undefined, "first")).toBe("first\n");
  });

  it("inserts after the line containing the anchor heading", () => {
    const content = "# Title\n\n## Log\nold entry\n\n## Other\nx\n";
    const out = applyAnchoredAppend(content, "## Log", "- new entry");
    expect(out).toBe("# Title\n\n## Log\n- new entry\nold entry\n\n## Other\nx\n");
  });

  it("returns null when the anchor is not found", () => {
    expect(applyAnchoredAppend("a\nb\n", "## Missing", "x")).toBeNull();
  });

  it("appends after an anchor on the final line without a trailing newline", () => {
    expect(applyAnchoredAppend("intro\n## Log", "## Log", "- x")).toBe(
      "intro\n## Log\n- x\n"
    );
  });
});

describe("trivial-diff normalization (4C)", () => {
  it("treats a trailing-newline difference as equal", () => {
    expect(triviallyEqual("body", "body\n")).toBe(true);
    expect(triviallyEqual("body\n", "body\n\n")).toBe(true);
  });
  it("treats CRLF vs LF as equal", () => {
    expect(triviallyEqual("a\r\nb", "a\nb")).toBe(true);
  });
  it("treats trailing-whitespace-per-line as equal", () => {
    expect(triviallyEqual("a   \nb", "a\nb")).toBe(true);
  });
  it("still detects a real content change", () => {
    expect(triviallyEqual("a\nb", "a\nc")).toBe(false);
  });
  it("normalizeForCompare strips trailing whitespace", () => {
    expect(normalizeForCompare("x\n\n  ")).toBe("x");
  });
});
