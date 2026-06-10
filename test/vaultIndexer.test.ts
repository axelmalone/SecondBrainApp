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

/**
 * An embedder whose embed() blocks until `release()` is called, and exposes a
 * `started` promise that resolves once embedding begins. Lets a test observe the
 * mid-backfill window (lexical ready, vectors not) deterministically.
 */
class GatedEmbedder implements Embedder {
  readonly dimension = DIM;
  calls = 0;
  started: Promise<void>;
  private signalStarted!: () => void;
  private gate: Promise<void>;
  release!: () => void;
  constructor() {
    this.started = new Promise((r) => (this.signalStarted = r));
    this.gate = new Promise((r) => (this.release = r));
  }
  async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    this.signalStarted();
    await this.gate;
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

/**
 * An embedder that gates only the FIRST `gateUpTo` calls (each blocks until
 * released individually); later calls resolve immediately. Lets a test inject
 * edits at the two interesting points (the bulk embed, and the first drain
 * embed) without having to predict how many drain rounds convergence takes.
 */
class SteppedEmbedder implements Embedder {
  readonly dimension = DIM;
  calls = 0;
  gateUpTo = 0;
  private releases: Array<() => void> = [];
  async embed(texts: string[]): Promise<number[][]> {
    const n = ++this.calls;
    if (n <= this.gateUpTo) await new Promise<void>((r) => (this.releases[n] = r));
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
  async waitForCall(n: number): Promise<void> {
    while (this.calls < n) await new Promise((r) => setTimeout(r, 1));
  }
  release(n: number): void {
    this.releases[n]?.();
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

  it("indexVault makes the vault answerable in keyword mode with 0 vectors (2A)", async () => {
    vault = await makeVault({ "a.md": "alpha apple orchard", "b.md": "beta banana bunch" });
    const embedder = new GatedEmbedder();
    const svc = new GroundingService(embedder);
    const p = svc.indexVault(vault);
    await embedder.started; // chunk pass done, lexical filled, blocked on embed

    const mid = svc.status();
    expect(mid.indexing).toBe(true);
    expect(mid.ready).toBe(true); // lexical answers immediately…
    expect(mid.semanticReady).toBe(false); // …before any vector exists

    // 3A: mid-backfill queries take the keyword path (no vector embed of the query).
    const kw = await svc.ground("apple orchard");
    expect(kw.status).toBe("grounded");
    if (kw.status === "grounded") expect(kw.mode).toBe("keyword");

    embedder.release();
    await p;

    const done = svc.status();
    expect(done.semanticReady).toBe(true);
    const sem = await svc.ground("apple orchard");
    if (sem.status === "grounded") expect(sem.mode).toBe("semantic"); // upgraded
  }, 15000);

  it("an edit during backfill updates keyword search WITHOUT embedding (9A regression)", async () => {
    vault = await makeVault({ "a.md": "alpha apple", "b.md": "beta banana" });
    const embedder = new GatedEmbedder();
    const svc = new GroundingService(embedder);
    const p = svc.indexVault(vault);
    await embedder.started;
    expect(embedder.calls).toBe(1); // the single backfill batch, now blocked

    await fs.writeFile(path.join(vault, "a.md"), "cherry cherry cherry", "utf8");
    await svc.reindexNote(path.join(vault, "a.md"));

    // 9A: the edit must NOT fire a synchronous one-note embed mid-backfill…
    expect(embedder.calls).toBe(1);
    // …yet the new content is already keyword-searchable (lexical stayed in step).
    const res = await svc.ground("cherry");
    expect(res.status).toBe("grounded");
    if (res.status === "grounded") {
      expect(res.mode).toBe("keyword");
      expect(res.chunks[0]?.notePath).toBe(path.join(vault, "a.md"));
    }

    embedder.release();
    await p;

    // AFTERMATH (no lost update): once the backfill settles, SEMANTIC search must
    // find the NEW content — the stale pre-edit "alpha apple" vector must never
    // have been written. drainDirty re-embedded a.md from current disk.
    expect(svc.status().semanticReady).toBe(true);
    const after = await svc.ground("cherry");
    expect(after.status).toBe("grounded");
    if (after.status === "grounded") {
      expect(after.mode).toBe("semantic");
      expect(after.chunks.some((c) => c.notePath === path.join(vault, "a.md"))).toBe(true);
    }
  }, 15000);

  it("removeNote during backfill drops the note from keyword results too", async () => {
    vault = await makeVault({ "a.md": "alpha apple", "b.md": "beta banana" });
    const embedder = new GatedEmbedder();
    const svc = new GroundingService(embedder);
    const p = svc.indexVault(vault);
    await embedder.started;

    svc.removeNote(path.join(vault, "a.md"));
    const res = await svc.ground("alpha apple");
    if (res.status === "grounded") {
      expect(res.chunks.every((c) => !c.notePath.endsWith("a.md"))).toBe(true);
    }

    embedder.release();
    await p;

    // AFTERMATH (no resurrection): after backfill, a.md stays gone from BOTH the
    // note set and semantic results — the attach loop must not re-add its snapshot.
    expect(svc.status().notes).toBe(1);
    const after = await svc.ground("alpha apple");
    if (after.status === "grounded") {
      expect(after.chunks.every((c) => !c.notePath.endsWith("a.md"))).toBe(true);
    }
  }, 15000);

  it("re-drains a note edited DURING drainDirty's own embed (final content wins)", async () => {
    const a = () => path.join(vault, "a.md");
    vault = await makeVault({ "a.md": "alpha version one", "b.md": "beta banana" });
    const embedder = new SteppedEmbedder();
    embedder.gateUpTo = 2; // gate the bulk (call 1) and the first drain (call 2)
    const svc = new GroundingService(embedder);
    const p = svc.indexVault(vault);

    await embedder.waitForCall(1); // bulk batch entered (a v1 + b), blocked
    await fs.writeFile(a(), "cherry version two", "utf8");
    await svc.reindexNote(a()); // dirtied mid-backfill
    embedder.release(1); // bulk done → attach skips a → drainDirty embeds a (call 2)

    await embedder.waitForCall(2); // drainDirty's embed of a-v2, blocked
    await fs.writeFile(a(), "mango version three", "utf8");
    await svc.reindexNote(a()); // edited AGAIN during drainDirty's await → re-dirtied
    embedder.release(2); // loop sees dirty again → re-drains from current disk (auto-resolves)

    await p;

    // The loop re-drained until quiescent, so the FINAL on-disk content (mango)
    // is what semantic search returns — no stale "cherry"/"alpha" vector survived.
    expect(svc.status().semanticReady).toBe(true);
    const res = await svc.ground("mango version three");
    expect(res.status).toBe("grounded");
    if (res.status === "grounded") {
      expect(res.mode).toBe("semantic");
      expect(res.chunks.some((c) => c.notePath === a())).toBe(true);
    }
    // The stale earlier content must NOT be the top semantic hit for a.md.
    const stale = await svc.ground("alpha version one");
    if (stale.status === "grounded") {
      const top = stale.chunks[0];
      if (top?.notePath === a()) expect(top.text).toContain("mango");
    }
  }, 15000);

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
