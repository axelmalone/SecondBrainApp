import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IndexStore, type StoredNote } from "../src/grounding/indexStore.js";
import type { DiskBaseline } from "../src/vault/types.js";

let dir: string;
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

async function tmpFile(): Promise<string> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-idx-store-"));
  return path.join(dir, "grounding", "vault.jsonl");
}

const baseline = (sha: string): DiskBaseline => ({
  mtimeMs: 1000,
  size: 10,
  ino: 1,
  sha256: sha,
});

const note = (p: string, sha: string): StoredNote => ({
  path: p,
  baseline: baseline(sha),
  chunks: [{ id: `${p}#0`, notePath: p, text: "t", vector: [0.1, 0.2] }],
});

describe("IndexStore", () => {
  it("folds to the latest entry per note path", async () => {
    const store = new IndexStore(await tmpFile());
    await store.putNote(note("a.md", "v1"));
    await store.putNote(note("b.md", "x"));
    await store.putNote(note("a.md", "v2")); // supersedes the first a.md

    const loaded = await store.load();
    expect(loaded.size).toBe(2);
    expect(loaded.get("a.md")?.baseline.sha256).toBe("v2");
  });

  it("tombstones a deleted note out of the fold", async () => {
    const store = new IndexStore(await tmpFile());
    await store.putNote(note("a.md", "v1"));
    await store.deleteNote("a.md");
    const loaded = await store.load();
    expect(loaded.has("a.md")).toBe(false);
  });

  it("tolerates a torn final line (crash mid-append)", async () => {
    const file = await tmpFile();
    const store = new IndexStore(file);
    await store.putNote(note("a.md", "v1"));
    await fs.appendFile(file, '{"path":"b.md","baseline":{"mtimeMs":1');
    const loaded = await store.load();
    expect(loaded.get("a.md")?.baseline.sha256).toBe("v1"); // earlier line intact
    expect(loaded.has("b.md")).toBe(false); // torn line skipped
  });

  it("compacts to exactly the given set (drops superseded/tombstoned lines)", async () => {
    const file = await tmpFile();
    const store = new IndexStore(file);
    await store.putNote(note("a.md", "v1"));
    await store.putNote(note("a.md", "v2"));
    await store.putNote(note("gone.md", "g"));
    await store.compact([note("a.md", "v2")]);

    const raw = await fs.readFile(file, "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1); // only one line now
    const loaded = await store.load();
    expect([...loaded.keys()]).toEqual(["a.md"]);
  });

  it("exists() reflects whether the file is present", async () => {
    const file = await tmpFile();
    const store = new IndexStore(file);
    expect(await store.exists()).toBe(false);
    await store.putNote(note("a.md", "v1"));
    expect(await store.exists()).toBe(true);
  });
});
