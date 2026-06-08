import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import { loadNote } from "../src/vault/loadNote.js";
import { serialize } from "../src/vault/automerge.js";
import { NoteNotFoundError } from "../src/vault/errors.js";
import { makeTempVault, writeNote, cleanup } from "./helpers.js";

let vault: string;
afterEach(async () => {
  if (vault) await cleanup(vault);
});

describe("loadNote", () => {
  it("hydrates markdown (wikilinks + tags preserved) into a doc", async () => {
    vault = await makeTempVault();
    const md = "# Idea\n\nSee [[Other Note]] #tag\n";
    const p = await writeNote(vault, "idea.md", md);

    const loaded = await loadNote(p);

    expect(serialize(loaded.doc)).toBe(md);
    expect(loaded.path).toBe(p);
    expect(loaded.baseline.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.baseline.ino).toBeGreaterThan(0);
  });

  it("loads an empty file as an empty doc, no crash", async () => {
    vault = await makeTempVault();
    const p = await writeNote(vault, "empty.md", "");

    const loaded = await loadNote(p);

    expect(serialize(loaded.doc)).toBe("");
    expect(loaded.baseline.size).toBe(0);
  });

  it("throws typed NoteNotFoundError for a missing file (no partial doc)", async () => {
    vault = await makeTempVault();
    const missing = path.join(vault, "nope.md");

    await expect(loadNote(missing)).rejects.toBeInstanceOf(NoteNotFoundError);
  });
});
