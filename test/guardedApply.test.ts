import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { guardedApply } from "../src/vault/guardedApply.js";
import { readWithBaseline } from "../src/vault/hash.js";
import { makeTempVault, writeNote, readFile, cleanup } from "./helpers.js";

let vault: string;
afterEach(async () => {
  if (vault) await cleanup(vault);
});

describe("guardedApply (text-level choke point)", () => {
  it("saves and returns a baseline matching the new bytes", async () => {
    vault = await makeTempVault();
    const p = await writeNote(vault, "n.md", "old");
    const { baseline } = await readWithBaseline(p);

    const res = await guardedApply(p, baseline, "new text");

    expect(res.status).toBe("saved");
    if (res.status === "saved") {
      expect(res.baseline.size).toBe(Buffer.byteLength("new text"));
    }
    expect(await readFile(p)).toBe("new text");
  });

  it("fresh-creates when baseline is undefined and no file exists", async () => {
    vault = await makeTempVault();
    const p = path.join(vault, "fresh.md");

    const res = await guardedApply(p, undefined, "hello");

    expect(res.status).toBe("saved");
    expect(await readFile(p)).toBe("hello");
  });

  it("reports conflict (not clobber) when disk drifted, surfacing disk text", async () => {
    vault = await makeTempVault();
    const p = await writeNote(vault, "n.md", "v1");
    const { baseline } = await readWithBaseline(p);
    await fs.writeFile(p, "EXTERNAL EDIT", "utf8");

    const res = await guardedApply(p, baseline, "my write");

    expect(res.status).toBe("conflict");
    if (res.status === "conflict") {
      expect(res.diskText).toBe("EXTERNAL EDIT");
      expect(res.disk.sha256).not.toBe(baseline.sha256);
    }
    // The external edit must survive untouched.
    expect(await readFile(p)).toBe("EXTERNAL EDIT");
  });

  it("reports conflict on a fresh create when the file already exists", async () => {
    vault = await makeTempVault();
    const p = await writeNote(vault, "n.md", "already here");

    const res = await guardedApply(p, undefined, "new");

    expect(res.status).toBe("conflict");
    if (res.status === "conflict") expect(res.diskText).toBe("already here");
    expect(await readFile(p)).toBe("already here");
  });

  it("reports deleted when the target vanished before the write", async () => {
    vault = await makeTempVault();
    const p = await writeNote(vault, "n.md", "v1");
    const { baseline } = await readWithBaseline(p);
    await fs.rm(p);

    const res = await guardedApply(p, baseline, "my write");
    expect(res.status).toBe("deleted");
  });

  it("reports renamed when the inode changed since baseline", async () => {
    vault = await makeTempVault();
    const p = await writeNote(vault, "n.md", "v1");
    const { baseline } = await readWithBaseline(p);
    await fs.rm(p);
    await fs.writeFile(p, "v1", "utf8"); // same bytes, new inode

    const res = await guardedApply(p, baseline, "my write");
    expect(res.status).toBe("renamed");
  });
});
