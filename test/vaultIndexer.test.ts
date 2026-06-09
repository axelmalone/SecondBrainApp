import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { GroundingService } from "../src/grounding/vaultIndexer.js";
import { IndexStore } from "../src/grounding/indexStore.js";
import type { Embedder } from "../src/grounding/types.js";

const DIM = 64;

class FakeEmbedder implements Embedder {
  readonly dimension = DIM;
  calls = 0;
  async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    return texts.map((t) => {
      const v = new Array<number>(DIM).fill(0);
      for (const tok of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        let h = 0;
        for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) | 0;
        const b = Math.abs(h) % DIM;
        v[b] = (v[b] ?? 0) + 1;
      }
      return v;
    });
  }
}

let vault: string;
afterEach(async () => {
  if (vault) await fs.rm(vault, { recursive: true, force: true });
});

async function makeVault(notes: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-idx-"));
  for (const [name, body] of Object.entries(notes)) {
    await fs.writeFile(path.join(dir, name), body, "utf8");
  }
  return dir;
}

describe("GroundingService.indexVault", () => {
  it("indexes all markdown and skips dot-dirs", async () => {
    vault = await makeVault({
      "a.md": "alpha apple",
      "b.markdown": "beta banana",
      "notes.txt": "ignored non-markdown",
    });
    await fs.mkdir(path.join(vault, ".obsidian"));
    await fs.writeFile(path.join(vault, ".obsidian", "x.md"), "hidden", "utf8");

    const svc = new GroundingService(new FakeEmbedder());
    const counts = await svc.indexVault(vault);

    expect(counts.notes).toBe(2); // a.md + b.markdown; .obsidian and .txt skipped
    expect(svc.status().ready).toBe(true);
  });

  it("batches embed calls across notes and reports complete progress", async () => {
    const notes: Record<string, string> = {};
    for (let i = 0; i < 40; i++) notes[`n${i}.md`] = `note number ${i} content`;
    vault = await makeVault(notes);

    const embedder = new FakeEmbedder();
    const svc = new GroundingService(embedder);
    const counts = await svc.indexVault(vault);

    expect(counts.notes).toBe(40);
    // 40 single-chunk notes embedded in batches of 32 → 2 calls, not 40.
    expect(embedder.calls).toBeLessThanOrEqual(2);

    // Progress is fully accounted for and matches the indexed chunk count.
    const s = svc.status();
    expect(s.total).toBe(s.chunks);
    expect(s.processed).toBe(s.total);

    // Semantics preserved: retrieval still finds the right note.
    const res = await svc.ground("note number 7 content");
    expect(res.status).toBe("grounded");
  });
});

describe("GroundingService.reconcile — persistence (D16)", () => {
  it("reuses saved vectors for unchanged notes (no re-embedding on relaunch)", async () => {
    vault = await makeVault({ "a.md": "alpha apple", "b.md": "beta banana" });
    const storeFile = path.join(vault, "..", `idx-${Date.now()}.jsonl`);
    const store = new IndexStore(storeFile);
    try {
      const e1 = new FakeEmbedder();
      const svc1 = new GroundingService(e1, {}, store);
      const first = await svc1.reconcile(vault);
      expect(first.notes).toBe(2);
      expect(e1.calls).toBeGreaterThan(0); // first build embeds

      // "Relaunch": brand-new service + embedder, same store, nothing changed.
      const e2 = new FakeEmbedder();
      const svc2 = new GroundingService(e2, {}, store);
      const second = await svc2.reconcile(vault);
      expect(second.notes).toBe(2);
      expect(second.chunks).toBe(first.chunks);
      expect(e2.calls).toBe(0); // ← reused saved vectors, embedded nothing
      expect(svc2.status().ready).toBe(true);
      // Retrieval still works from the reused vectors.
      expect((await svc2.ground("alpha apple")).status).toBe("grounded");
    } finally {
      await fs.rm(storeFile, { force: true });
    }
  });

  it("re-embeds only changed notes and drops deleted ones", async () => {
    vault = await makeVault({ "a.md": "alpha", "b.md": "beta", "c.md": "gamma" });
    const storeFile = path.join(vault, "..", `idx-${Date.now()}-2.jsonl`);
    const store = new IndexStore(storeFile);
    try {
      const e1 = new FakeEmbedder();
      await new GroundingService(e1, {}, store).reconcile(vault);

      // Change a.md, delete c.md, leave b.md untouched.
      await fs.writeFile(path.join(vault, "a.md"), "alpha rewritten", "utf8");
      await fs.rm(path.join(vault, "c.md"));

      const e2 = new FakeEmbedder();
      const svc2 = new GroundingService(e2, {}, store);
      const res = await svc2.reconcile(vault);

      expect(res.notes).toBe(2); // a.md + b.md; c.md dropped
      expect(e2.calls).toBe(1); // only a.md re-embedded (b reused, c gone)
      // c.md is gone from the persisted store too.
      const saved = await store.load();
      expect(saved.has(path.join(vault, "c.md"))).toBe(false);
    } finally {
      await fs.rm(storeFile, { force: true });
    }
  });
});

describe("GroundingService incremental re-index (D2)", () => {
  it("reindexNote picks up edited content", async () => {
    vault = await makeVault({ "a.md": "alpha apple", "b.md": "beta banana" });
    const embedder = new FakeEmbedder();
    const svc = new GroundingService(embedder);
    await svc.indexVault(vault);

    const before = await svc.ground("cherry");
    expect(before.status).toBe("unavailable"); // nothing about cherry yet

    await fs.writeFile(path.join(vault, "a.md"), "cherry cherry cherry", "utf8");
    await svc.reindexNote(path.join(vault, "a.md"));

    const after = await svc.ground("cherry");
    expect(after.status).toBe("grounded");
    if (after.status === "grounded") {
      expect(after.chunks[0]?.notePath).toBe(path.join(vault, "a.md"));
    }
    expect(svc.status().notes).toBe(2); // still two notes, a.md swapped not duplicated
  });

  it("reindexNote drops a note whose file was deleted", async () => {
    vault = await makeVault({ "a.md": "alpha apple", "b.md": "beta banana" });
    const svc = new GroundingService(new FakeEmbedder());
    await svc.indexVault(vault);
    expect(svc.status().notes).toBe(2);

    await fs.rm(path.join(vault, "a.md"));
    await svc.reindexNote(path.join(vault, "a.md"));

    expect(svc.status().notes).toBe(1);
    const res = await svc.ground("alpha apple");
    // a.md is gone; only b.md remains, which shouldn't match "alpha apple" well.
    if (res.status === "grounded") {
      expect(res.chunks.every((c) => !c.notePath.endsWith("a.md"))).toBe(true);
    }
  });

  it("removeNote drops a note's chunks", async () => {
    vault = await makeVault({ "a.md": "alpha", "b.md": "beta" });
    const svc = new GroundingService(new FakeEmbedder());
    await svc.indexVault(vault);
    const chunksBefore = svc.status().chunks;

    svc.removeNote(path.join(vault, "a.md"));
    expect(svc.status().notes).toBe(1);
    expect(svc.status().chunks).toBeLessThan(chunksBefore);
  });

  it("reindexNote on an unembeddable note keeps prior chunks (no data loss)", async () => {
    vault = await makeVault({ "a.md": "alpha apple" });
    const embedder = new FakeEmbedder();
    const svc = new GroundingService(embedder);
    await svc.indexVault(vault);
    const notesBefore = svc.status().notes;

    // Make embedding throw on the next call, then re-index.
    embedder.embed = async () => {
      throw new Error("model unavailable");
    };
    await svc.reindexNote(path.join(vault, "a.md"));

    expect(svc.status().notes).toBe(notesBefore); // unchanged, not dropped
  });
});
