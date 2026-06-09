import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { RecentNotesCache } from "../src/main/recentNotesCache.js";

let dir: string;
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = "";
});

async function tmp(): Promise<string> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-recent-"));
  return dir;
}

/** Write a markdown file with an explicit mtime (days ago). */
async function aged(root: string, name: string, daysAgo: number): Promise<string> {
  const p = path.join(root, name);
  await fs.writeFile(p, "x", "utf8");
  const t = new Date(Date.now() - daysAgo * 86_400_000);
  await fs.utimes(p, t, t);
  return p;
}

describe("RecentNotesCache", () => {
  it("is unseeded until seed() runs", async () => {
    const c = new RecentNotesCache();
    expect(c.isSeeded).toBe(false);
    await c.seed(await tmp());
    expect(c.isSeeded).toBe(true);
  });

  it("seeds from a walk and returns newest-first, capped", async () => {
    const root = await tmp();
    await aged(root, "old.md", 30);
    await aged(root, "mid.md", 10);
    await aged(root, "new.md", 1);
    const c = new RecentNotesCache();
    await c.seed(root);
    const recent = await c.recent(2);
    expect(recent.map((p) => path.basename(p))).toEqual(["new.md", "mid.md"]);
  });

  it("note() promotes a newly-touched file to the front", async () => {
    const root = await tmp();
    await aged(root, "a.md", 30);
    await aged(root, "b.md", 20);
    const c = new RecentNotesCache();
    await c.seed(root);
    // Touch a.md to "now" so it becomes the most recent.
    const a = path.join(root, "a.md");
    const now = new Date();
    await fs.utimes(a, now, now);
    await c.note(a);
    const recent = await c.recent(2);
    expect(path.basename(recent[0]!)).toBe("a.md");
  });

  it("self-heals: a cached entry deleted on disk never surfaces", async () => {
    const root = await tmp();
    const gone = await aged(root, "gone.md", 5);
    await aged(root, "stay.md", 10);
    const c = new RecentNotesCache();
    await c.seed(root);
    // Delete on disk WITHOUT notifying the cache (simulates a lossy watcher event).
    await fs.rm(gone);
    const recent = await c.recent(5);
    expect(recent.map((p) => path.basename(p))).toEqual(["stay.md"]);
  });

  it("remove() drops a note from the cache", async () => {
    const root = await tmp();
    const a = await aged(root, "a.md", 1);
    await aged(root, "b.md", 2);
    const c = new RecentNotesCache();
    await c.seed(root);
    c.remove(a);
    const recent = await c.recent(5);
    expect(recent.map((p) => path.basename(p))).toEqual(["b.md"]);
  });

  it("re-seeding a different vault clears prior state", async () => {
    const rootA = await tmp();
    await aged(rootA, "a.md", 1);
    const c = new RecentNotesCache();
    await c.seed(rootA);
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "sb-recent2-"));
    try {
      await aged(rootB, "b.md", 1);
      await c.seed(rootB);
      const recent = await c.recent(5);
      expect(recent.map((p) => path.basename(p))).toEqual(["b.md"]);
    } finally {
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });

  it("seed(null) leaves it empty and unseeded", async () => {
    const c = new RecentNotesCache();
    await c.seed(null);
    expect(c.isSeeded).toBe(false);
    expect(await c.recent(5)).toEqual([]);
  });
});
