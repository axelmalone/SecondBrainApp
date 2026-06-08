import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { listTree, isInside } from "../src/main/vaultFiles.js";
import { makeTempVault, writeNote, cleanup } from "./helpers.js";
import type { FileNode } from "../src/shared/ipc.js";

let vault = "";
afterEach(async () => {
  if (vault) await cleanup(vault);
  vault = "";
});

const names = (nodes: FileNode[]): string[] => nodes.map((n) => n.name);

describe("listTree", () => {
  it("includes .md/.markdown, skips dot-dirs and non-markdown files", async () => {
    vault = await makeTempVault();
    await writeNote(vault, "alpha.md", "# a");
    await writeNote(vault, "beta.markdown", "# b");
    await writeNote(vault, "notes.txt", "ignore me");
    await writeNote(vault, "image.png", "ignore me");
    await fs.mkdir(path.join(vault, ".obsidian"), { recursive: true });
    await writeNote(vault, ".obsidian/config.md", "hidden tool dir");
    await fs.mkdir(path.join(vault, ".git"), { recursive: true });
    await writeNote(vault, ".git/HEAD.md", "hidden vcs dir");

    const tree = await listTree(vault);
    expect(names(tree)).toEqual(["alpha.md", "beta.markdown"]);
    // dot-directories never appear, even though they contain .md files
    expect(names(tree)).not.toContain(".obsidian");
    expect(names(tree)).not.toContain(".git");
  });

  it("recurses into subfolders, listing dirs before files (each alpha)", async () => {
    vault = await makeTempVault();
    await fs.mkdir(path.join(vault, "Projects"), { recursive: true });
    await writeNote(vault, "Projects/zeta.md", "# z");
    await writeNote(vault, "Projects/aardvark.md", "# a");
    await writeNote(vault, "Projects/skip.txt", "ignore");
    await writeNote(vault, "top.md", "# t");

    const tree = await listTree(vault);
    // dir sorts before the top-level file
    expect(names(tree)).toEqual(["Projects", "top.md"]);
    const projects = tree[0]!;
    expect(projects.type).toBe("dir");
    expect(names(projects.children ?? [])).toEqual(["aardvark.md", "zeta.md"]);
  });

  it("returns an empty tree for an empty vault", async () => {
    vault = await makeTempVault();
    expect(await listTree(vault)).toEqual([]);
  });
});

describe("isInside", () => {
  it("accepts a descendant path inside the vault", () => {
    expect(isInside("/vault", "/vault/note.md")).toBe(true);
    expect(isInside("/vault", "/vault/sub/deep/note.md")).toBe(true);
  });

  it("rejects paths that escape the vault", () => {
    expect(isInside("/vault", "/etc/passwd")).toBe(false);
    expect(isInside("/vault", "/vault/../secret.md")).toBe(false);
    expect(isInside("/vault", "/vaultsibling/note.md")).toBe(false);
  });

  it("rejects the vault root itself (must be a contained path)", () => {
    expect(isInside("/vault", "/vault")).toBe(false);
  });
});
