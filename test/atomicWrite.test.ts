import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { atomicWrite } from "../src/vault/atomicWrite.js";
import { readWithBaseline } from "../src/vault/hash.js";
import {
  ConflictError,
  NoteDeletedError,
  NoteRenamedError,
} from "../src/vault/errors.js";
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

describe("atomicWrite", () => {
  it("replaces content and returns a baseline matching the new bytes", async () => {
    vault = await makeTempVault();
    const p = await writeNote(vault, "n.md", "old");
    const { baseline } = await readWithBaseline(p);

    const next = await atomicWrite(p, "new content", { baseline });

    expect(await readFile(p)).toBe("new content");
    expect(next.size).toBe(Buffer.byteLength("new content"));
  });

  it("creates a restorable .bak of the prior content", async () => {
    vault = await makeTempVault();
    const p = await writeNote(vault, "n.md", "original");
    const { baseline } = await readWithBaseline(p);

    await atomicWrite(p, "updated", { baseline });

    expect(await readFile(`${p}.bak`)).toBe("original");
  });

  it("leaves no temp file behind on success", async () => {
    vault = await makeTempVault();
    const p = await writeNote(vault, "n.md", "x");
    const { baseline } = await readWithBaseline(p);

    await atomicWrite(p, "y", { baseline });

    const entries = await fs.readdir(vault);
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  it("ABORTS with ConflictError when disk changed since baseline (no clobber)", async () => {
    vault = await makeTempVault();
    const p = await writeNote(vault, "n.md", "v1");
    const { baseline } = await readWithBaseline(p);

    // External writer changes the file after baseline capture.
    await fs.writeFile(p, "EXTERNAL EDIT", "utf8");

    await expect(
      atomicWrite(p, "my write", { baseline })
    ).rejects.toBeInstanceOf(ConflictError);
    // The external edit must survive untouched.
    expect(await readFile(p)).toBe("EXTERNAL EDIT");
    // And no temp is leaked on the aborted write.
    const entries = await fs.readdir(vault);
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  it("throws NoteDeletedError if the file vanished before rename", async () => {
    vault = await makeTempVault();
    const p = await writeNote(vault, "n.md", "v1");
    const { baseline } = await readWithBaseline(p);
    await fs.rm(p);

    await expect(
      atomicWrite(p, "my write", { baseline })
    ).rejects.toBeInstanceOf(NoteDeletedError);
  });

  it("throws NoteRenamedError if the inode changed (replaced) since baseline", async () => {
    vault = await makeTempVault();
    const p = await writeNote(vault, "n.md", "v1");
    const { baseline } = await readWithBaseline(p);

    // Replace with a different inode: remove + recreate.
    await fs.rm(p);
    await fs.writeFile(p, "v1", "utf8"); // same bytes, different inode

    await expect(
      atomicWrite(p, "my write", { baseline })
    ).rejects.toBeInstanceOf(NoteRenamedError);
  });

  it("refuses to clobber an existing file on a fresh create (no baseline)", async () => {
    vault = await makeTempVault();
    const p = await writeNote(vault, "n.md", "already here");

    await expect(atomicWrite(p, "new", {})).rejects.toBeInstanceOf(
      ConflictError
    );
    expect(await readFile(p)).toBe("already here");
  });

  it("creates a brand-new file when none exists (no baseline)", async () => {
    vault = await makeTempVault();
    const p = path.join(vault, "fresh.md");

    await atomicWrite(p, "hello", {});

    expect(await readFile(p)).toBe("hello");
    expect(await exists(`${p}.bak`)).toBe(false);
  });
});
