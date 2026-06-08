import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../src/main/markdownRender.js";
import type { RenderNode } from "../src/shared/render.js";

/** Flatten all text node values in a render tree. */
function allText(nodes: RenderNode[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.t === "text") out += n.value;
    else if (n.t === "el") out += allText(n.children);
  }
  return out;
}

/** Collect every el node with a given tag. */
function findEls(nodes: RenderNode[], tag: string): Extract<RenderNode, { t: "el" }>[] {
  const out: Extract<RenderNode, { t: "el" }>[] = [];
  const walk = (ns: RenderNode[]): void => {
    for (const n of ns) {
      if (n.t === "el") {
        if (n.tag === tag) out.push(n);
        walk(n.children);
      }
    }
  };
  walk(nodes);
  return out;
}

/** Assert no node anywhere carries an executable/script-y tag or href. */
function assertNoExecutable(nodes: RenderNode[]): void {
  const walk = (ns: RenderNode[]): void => {
    for (const n of ns) {
      if (n.t === "el") {
        expect(["script", "img", "iframe", "svg", "object"]).not.toContain(n.tag);
        if (n.href) expect(n.href.toLowerCase()).toMatch(/^(https?:|mailto:)/);
        walk(n.children);
      }
    }
  };
  walk(nodes);
}

describe("markdownRender — P0 XSS (5A, mandatory)", () => {
  it("a javascript: link is rendered inert (no href, no <a>)", () => {
    const tree = renderMarkdown("[click me](javascript:alert(1))");
    assertNoExecutable(tree);
    // The visible text survives, but there is no anchor with a dangerous href.
    expect(allText(tree)).toContain("click me");
    expect(findEls(tree, "a")).toHaveLength(0);
  });

  it("a raw <script> tag is rendered as literal text, never an element", () => {
    const tree = renderMarkdown("hello <script>alert(1)</script> world");
    assertNoExecutable(tree);
    // The angle brackets survive as text — they were never parsed as markup.
    expect(allText(tree)).toContain("<script>");
    expect(allText(tree)).toContain("alert(1)");
  });

  it("an <img onerror=…> is never emitted as an image element", () => {
    const tree = renderMarkdown('an <img src=x onerror="alert(1)"> here');
    assertNoExecutable(tree);
    expect(findEls(tree, "img" as never)).toHaveLength(0);
    expect(allText(tree)).toContain("onerror");
  });

  it("a markdown image becomes alt text, not an <img>", () => {
    const tree = renderMarkdown("![the alt text](http://evil/x.png)");
    assertNoExecutable(tree);
    expect(allText(tree)).toContain("the alt text");
  });
});

describe("markdownRender — links", () => {
  it("keeps a safe http link with its href", () => {
    const tree = renderMarkdown("[site](https://example.com)");
    const links = findEls(tree, "a");
    expect(links).toHaveLength(1);
    expect(links[0]?.href).toBe("https://example.com");
  });
});

describe("markdownRender — wikilinks", () => {
  it("parses a plain wikilink", () => {
    const tree = renderMarkdown("see [[My Note]] please");
    const links = findEls(tree, "a");
    expect(links[0]?.wikilink).toBe("My Note");
    expect(allText(tree)).toContain("My Note");
  });

  it("parses an aliased wikilink [[target|alias]]", () => {
    const tree = renderMarkdown("[[Real Target|shown text]]");
    const link = findEls(tree, "a")[0];
    expect(link?.wikilink).toBe("Real Target");
    expect(allText([link!])).toBe("shown text");
  });

  it("parses a heading wikilink [[target#heading]]", () => {
    const tree = renderMarkdown("[[Note#Section]]");
    expect(findEls(tree, "a")[0]?.wikilink).toBe("Note#Section");
  });

  it("marks an unresolved wikilink when the target is unknown", () => {
    const known = (t: string): boolean => t === "Exists";
    const resolved = renderMarkdown("[[Exists]]", known);
    const unresolved = renderMarkdown("[[Missing]]", known);
    expect(findEls(resolved, "a")[0]?.unresolved).toBeUndefined();
    expect(findEls(unresolved, "a")[0]?.unresolved).toBe(true);
  });

  it("renders escaped \\[\\[ as literal text, not a wikilink", () => {
    const tree = renderMarkdown("\\[\\[Not A Link]]");
    expect(findEls(tree, "a")).toHaveLength(0);
    expect(allText(tree)).toContain("[[Not A Link]]");
  });

  it("does not crash or link on nested brackets", () => {
    const tree = renderMarkdown("[[a[b]] tail");
    expect(findEls(tree, "a")).toHaveLength(0);
  });
});

describe("markdownRender — structure", () => {
  it("renders headings, emphasis, lists, and code fences as elements", () => {
    const tree = renderMarkdown(
      "# Title\n\n**bold** and *em*\n\n- one\n- two\n\n```\ncode()\n```\n"
    );
    expect(findEls(tree, "h1")).toHaveLength(1);
    expect(findEls(tree, "strong")).toHaveLength(1);
    expect(findEls(tree, "em")).toHaveLength(1);
    expect(findEls(tree, "li")).toHaveLength(2);
    expect(findEls(tree, "pre")).toHaveLength(1);
    expect(allText(findEls(tree, "pre"))).toContain("code()");
  });
});
