import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { loadNote } from "../src/vault/loadNote.js";
import { saveNote } from "../src/vault/saveNote.js";
import { setText } from "../src/vault/automerge.js";
import { ConflictError } from "../src/vault/errors.js";
import { makeTempVault, writeNote, readFile, cleanup } from "./helpers.js";

let vault: string;
afterEach(async () => {
  if (vault) await cleanup(vault);
});

describe("saveNote", () => {
  it("writes edited doc back as plain markdown, advancing the baseline", async () => {
    vault = await makeTempVault();
    const p = await writeNote(vault, "n.md", "before #tag\n");
    const loaded = await loadNote(p);

    const edited = setText(loaded.doc, "after [[Link]] #tag\n");
    const saved = await saveNote(loaded, edited);

    expect(await readFile(p)).toBe("after [[Link]] #tag\n");
    // Baseline advanced; a second save with no further edit must not conflict.
    await expect(saveNote(saved)).resolves.toBeDefined();
  });

  it("refuses to clobber an external edit, surfacing ConflictError", async () => {
    vault = await makeTempVault();
    const p = await writeNote(vault, "n.md", "v1");
    const loaded = await loadNote(p);
    const edited = setText(loaded.doc, "my version");

    // Obsidian writes the file behind our back.
    await fs.writeFile(p, "their version", "utf8");

    await expect(saveNote(loaded, edited)).rejects.toBeInstanceOf(ConflictError);
    expect(await readFile(p)).toBe("their version");
  });
});
