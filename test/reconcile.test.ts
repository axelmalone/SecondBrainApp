import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { loadNote } from "../src/vault/loadNote.js";
import {
  reconcile,
  resolveConflict,
  hasUnsavedEdits,
} from "../src/vault/reconcile.js";
import { serialize, setText } from "../src/vault/automerge.js";
import {
  makeTempVault,
  writeNote,
  readFile,
  exists,
  cleanup,
} from "./helpers.js";

let vault: string;
afterEach(async () => {
  if (vault) await cleanup(vault);
});

/** Force a different mtime so the cheap gate can't false-negative on fast writes. */
async function externalWrite(p: string, content: string): Promise<void> {
  await fs.writeFile(p, content, "utf8");
  const future = new Date(Date.now() + 5_000);
  await fs.utimes(p, future, future);
}

describe("reconcile", () => {
  it("reports unchanged when disk matches the baseline", async () => {
    vault = await makeTempVault();
    const p = await writeNote(vault, "n.md", "stable");
    const loaded = await loadNote(p);

    expect(await reconcile(loaded)).toEqual({ kind: "unchanged" });
  });

  it("silently reloads on external write when there are no unsaved edits", async () => {
    vault = await makeTempVault();
    const p = await writeNote(vault, "n.md", "v1");
    const loaded = await loadNote(p);

    await externalWrite(p, "v2 from Obsidian");

    const result = await reconcile(loaded);
    expect(result.kind).toBe("reloaded");
    if (result.kind === "reloaded") {
      expect(serialize(result.loaded.doc)).toBe("v2 from Obsidian");
      expect(hasUnsavedEdits(result.loaded)).toBe(false);
    }
  });

  it("reports conflict on external write when local edits are unsaved", async () => {
    vault = await makeTempVault();
    const p = await writeNote(vault, "n.md", "v1");
    const loaded = await loadNote(p);
    loaded.doc = setText(loaded.doc, "my unsaved edit");

    await externalWrite(p, "their external edit");

    const result = await reconcile(loaded);
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") {
      expect(result.diskText).toBe("their external edit");
    }
  });

  it("reports deleted when the file is gone", async () => {
    vault = await makeTempVault();
    const p = await writeNote(vault, "n.md", "v1");
    const loaded = await loadNote(p);
    await fs.rm(p);

    expect(await reconcile(loaded)).toEqual({ kind: "deleted" });
  });

  it("reports renamed when the inode changed at the path", async () => {
    vault = await makeTempVault();
    const p = await writeNote(vault, "n.md", "v1");
    const loaded = await loadNote(p);
    await fs.rm(p);
    await externalWrite(p, "different file, same name");

    expect(await reconcile(loaded)).toEqual({ kind: "renamed" });
  });

  describe("resolveConflict", () => {
    it("keep-both preserves BOTH sides on disk (exit criterion)", async () => {
      vault = await makeTempVault();
      const p = await writeNote(vault, "idea.md", "v1");
      const loaded = await loadNote(p);
      loaded.doc = setText(loaded.doc, "MY version with [[Link]]");

      await externalWrite(p, "THEIR version with #tag");
      const conflict = await reconcile(loaded);
      expect(conflict.kind).toBe("conflict");
      if (conflict.kind !== "conflict") return;

      const now = new Date(2026, 5, 7); // 2026-06-07 (month is 0-indexed)
      const res = await resolveConflict(loaded, conflict, "keep-both", now);
      expect(res.kind).toBe("keep-both");
      if (res.kind !== "keep-both") return;

      // Original path now holds THEIR version.
      expect(await readFile(p)).toBe("THEIR version with #tag");
      expect(serialize(res.theirs.doc)).toBe("THEIR version with #tag");

      // A sibling conflict file holds MY version — both sides survive.
      const sibling = path.join(vault, "idea (conflict 2026-06-07).md");
      expect(await exists(sibling)).toBe(true);
      expect(await readFile(sibling)).toBe("MY version with [[Link]]");
      expect(res.mine.path).toBe(sibling);
      expect(serialize(res.mine.doc)).toBe("MY version with [[Link]]");
    });

    it("keep-mine overwrites disk with my version", async () => {
      vault = await makeTempVault();
      const p = await writeNote(vault, "n.md", "v1");
      const loaded = await loadNote(p);
      loaded.doc = setText(loaded.doc, "mine wins");

      await externalWrite(p, "theirs");
      const conflict = await reconcile(loaded);
      if (conflict.kind !== "conflict") throw new Error("expected conflict");

      const res = await resolveConflict(loaded, conflict, "keep-mine");
      expect(res.kind).toBe("keep-mine");
      expect(await readFile(p)).toBe("mine wins");
    });

    it("take-theirs discards my edits and reloads disk", async () => {
      vault = await makeTempVault();
      const p = await writeNote(vault, "n.md", "v1");
      const loaded = await loadNote(p);
      loaded.doc = setText(loaded.doc, "mine, to be discarded");

      await externalWrite(p, "theirs wins");
      const conflict = await reconcile(loaded);
      if (conflict.kind !== "conflict") throw new Error("expected conflict");

      const res = await resolveConflict(loaded, conflict, "take-theirs");
      expect(res.kind).toBe("take-theirs");
      if (res.kind !== "take-theirs") return;
      expect(serialize(res.note.doc)).toBe("theirs wins");
      expect(await readFile(p)).toBe("theirs wins");
    });

    it("keep-both disambiguates a second same-day conflict with a counter", async () => {
      vault = await makeTempVault();
      const p = await writeNote(vault, "idea.md", "v1");
      const now = new Date(2026, 5, 7);

      // Pre-seed the day-1 conflict file so the next must take a counter.
      await writeNote(vault, "idea (conflict 2026-06-07).md", "earlier");

      const loaded = await loadNote(p);
      loaded.doc = setText(loaded.doc, "second conflict mine");
      await externalWrite(p, "theirs");
      const conflict = await reconcile(loaded);
      if (conflict.kind !== "conflict") throw new Error("expected conflict");

      const res = await resolveConflict(loaded, conflict, "keep-both", now);
      if (res.kind !== "keep-both") throw new Error("expected keep-both");
      expect(res.mine.path).toBe(
        path.join(vault, "idea (conflict 2026-06-07 2).md")
      );
      // The pre-existing file is untouched.
      expect(
        await readFile(path.join(vault, "idea (conflict 2026-06-07).md"))
      ).toBe("earlier");
    });
  });
});
