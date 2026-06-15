import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { LinkIndex } from "../src/main/linkIndex.js";
import { SearchIndex } from "../src/main/searchIndex.js";
import { extractWikilinkTargets } from "../src/main/vaultScan.js";
import { makeTempVault, writeNote, cleanup } from "./helpers.js";

let vault: string;
afterEach(async () => {
  if (vault) await cleanup(vault);
});

describe("extractWikilinkTargets", () => {
  it("extracts names, stripping alias and heading", () => {
    expect(
      extractWikilinkTargets("see [[Note A]], [[B|alias]], [[C#Heading]]")
    ).toEqual(["note a", "b", "c"]);
  });
  it("ignores nested brackets", () => {
    expect(extractWikilinkTargets("[[a[b]]")).toEqual([]);
  });
});

describe("LinkIndex — backlinks", () => {
  it("lists notes that link to the target, and stays decoupled from grounding", async () => {
    vault = await makeTempVault();
    const target = await writeNote(vault, "Target.md", "# Target\n");
    await writeNote(vault, "A.md", "links to [[Target]] here");
    await writeNote(vault, "B.md", "also [[target]] (case-insensitive)");
    await writeNote(vault, "C.md", "no link at all");

    const idx = new LinkIndex();
    await idx.build(vault);

    const back = idx.backlinksFor(target).map((b) => b.name).sort();
    expect(back).toEqual(["A", "B"]);
  });

  it("updates incrementally when a note changes or is removed", async () => {
    vault = await makeTempVault();
    const target = await writeNote(vault, "Target.md", "x");
    const a = await writeNote(vault, "A.md", "no links yet");
    const idx = new LinkIndex();
    await idx.build(vault);
    expect(idx.backlinksFor(target)).toHaveLength(0);

    await fs.writeFile(a, "now links [[Target]]", "utf8");
    await idx.reindexNote(a);
    expect(idx.backlinksFor(target).map((b) => b.name)).toEqual(["A"]);

    idx.removeNote(a);
    expect(idx.backlinksFor(target)).toHaveLength(0);
  });

  it("resolves outgoing links to note paths, flagging dangling targets", async () => {
    vault = await makeTempVault();
    const a = await writeNote(vault, "A.md", "see [[Target]] and [[Ghost]]");
    const target = await writeNote(vault, "Target.md", "# Target\n");
    const idx = new LinkIndex();
    await idx.build(vault);

    const out = idx.outgoingFor(a);
    const byName = Object.fromEntries(out.map((t) => [t.name, t.path]));
    expect(byName["target"]).toBe(target); // resolved to the real note
    expect(byName["ghost"]).toBeNull(); // dangling — no such note
    expect(idx.outgoingFor(target)).toEqual([]); // Target links to nothing
  });
});

describe("SearchIndex — full-text", () => {
  it("finds matches in body and name with a snippet, works with no grounding", async () => {
    vault = await makeTempVault();
    await writeNote(vault, "Alpha.md", "The quick brown fox jumps over the lazy dog.");
    await writeNote(vault, "Beta.md", "Nothing relevant here.");
    await writeNote(vault, "fox-facts.md", "Foxes are cunning.");

    const idx = new SearchIndex();
    await idx.build(vault);

    const hits = idx.search("fox");
    const names = hits.map((h) => h.name);
    expect(names).toContain("Alpha");
    expect(names).toContain("fox-facts");
    expect(names).not.toContain("Beta");
    const alpha = hits.find((h) => h.name === "Alpha");
    expect(alpha?.snippet.toLowerCase()).toContain("fox");
  });

  it("ranks a name match above a single body mention", async () => {
    vault = await makeTempVault();
    await writeNote(vault, "Project.md", "mentions project once");
    await writeNote(vault, "notes.md", "project project project everywhere");
    const idx = new SearchIndex();
    await idx.build(vault);
    const hits = idx.search("project");
    // notes.md has 3 body hits (3); Project.md has 1 body + name bonus (1+5=6).
    expect(hits[0]?.name).toBe("Project");
  });

  it("empty query returns nothing; updates incrementally", async () => {
    vault = await makeTempVault();
    const p = await writeNote(vault, "n.md", "alpha content");
    const idx = new SearchIndex();
    await idx.build(vault);
    expect(idx.search("")).toEqual([]);
    expect(idx.search("alpha")).toHaveLength(1);

    await fs.writeFile(p, "beta content", "utf8");
    await idx.reindexNote(p);
    expect(idx.search("alpha")).toHaveLength(0);
    expect(idx.search("beta")).toHaveLength(1);

    idx.removeNote(p);
    expect(idx.search("beta")).toHaveLength(0);
  });
});
