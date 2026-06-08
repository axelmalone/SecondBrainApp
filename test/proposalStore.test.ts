import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProposalStore } from "../src/main/proposalStore.js";
import type { ProposalDraft } from "../src/shared/proposal.js";

let dir: string;
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

async function tmpStoreDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "sb-prop-"));
}

const draft = (over: Partial<ProposalDraft> = {}): ProposalDraft => ({
  kind: "append",
  targetPath: "Daily/today.md",
  content: "- did a thing",
  ...over,
});

const backref = { chatId: "c1", turnTs: 1000 };

describe("ProposalStore — fold + lifecycle", () => {
  it("proposes and reads back a pending proposal", async () => {
    dir = await tmpStoreDir();
    const store = new ProposalStore(dir);
    const p = await store.propose(draft(), backref, "old body");
    expect(p.state).toBe("pending");
    expect(p.draft.kind).toBe("append");
    expect(p.baseText).toBe("old body");
    expect(p.chatId).toBe("c1");
    const got = await store.get(p.id);
    expect(got?.state).toBe("pending");
  });

  it("folds edit → pending, reject → rejected, applying → applied", async () => {
    dir = await tmpStoreDir();
    const store = new ProposalStore(dir);

    const a = await store.propose(draft(), backref);
    await store.edit(a.id, draft({ content: "- edited" }));
    const aEdited = await store.get(a.id);
    expect(aEdited?.state).toBe("pending");
    expect(aEdited?.draft.content).toBe("- edited");

    const b = await store.propose(draft(), backref);
    await store.reject(b.id);
    expect((await store.get(b.id))?.state).toBe("rejected");

    const c = await store.propose(draft({ kind: "create", targetPath: "n.md" }), backref);
    await store.markApplying(c.id, "n.md");
    expect((await store.get(c.id))?.state).toBe("applying");
    await store.markApplied(c.id, "n.md");
    const cApplied = await store.get(c.id);
    expect(cApplied?.state).toBe("applied");
    expect(cApplied?.appliedPath).toBe("n.md");
  });

  it("marks stale and recomputes baseText/draft", async () => {
    dir = await tmpStoreDir();
    const store = new ProposalStore(dir);
    const p = await store.propose(draft({ kind: "update", content: "v1" }), backref, "base1");
    await store.markStale(p.id, { baseText: "base2", note: "target changed on disk" });
    const stale = await store.get(p.id);
    expect(stale?.state).toBe("stale");
    expect(stale?.baseText).toBe("base2");
    expect(stale?.note).toContain("changed");
  });

  it("recoverInFlight returns proposals stuck in applying", async () => {
    dir = await tmpStoreDir();
    const store = new ProposalStore(dir);
    const p = await store.propose(draft(), backref);
    await store.markApplying(p.id, "Daily/today.md");
    const inflight = await store.recoverInFlight();
    expect(inflight.map((x) => x.id)).toContain(p.id);
  });

  it("tolerates a torn final line (crash mid-append)", async () => {
    dir = await tmpStoreDir();
    const store = new ProposalStore(dir);
    const p = await store.propose(draft(), backref);
    // Simulate a crash that left a half-written final line.
    await fs.appendFile(
      path.join(dir, "proposals.jsonl"),
      '{"t":"applied","id":"' + p.id + '","ts":'
    );
    const got = await store.get(p.id);
    expect(got?.state).toBe("pending"); // torn line ignored, earlier state intact
  });

  it("rejects an invalid (non-UUID) id across the boundary", async () => {
    dir = await tmpStoreDir();
    const store = new ProposalStore(dir);
    expect(await store.get("../../etc/passwd")).toBeNull();
    await expect(store.reject("not-a-uuid")).rejects.toThrow();
  });
});

describe("ProposalStore — compaction (1A)", () => {
  it("archives resolved proposals and keeps active ones, losslessly", async () => {
    dir = await tmpStoreDir();
    const store = new ProposalStore(dir);

    const applied = await store.propose(draft({ kind: "create", targetPath: "a.md" }), backref);
    await store.markApplying(applied.id, "a.md");
    await store.markApplied(applied.id, "a.md");

    const rejected = await store.propose(draft({ targetPath: "b.md" }), backref);
    await store.reject(rejected.id);

    const pending = await store.propose(draft({ targetPath: "c.md" }), backref);

    await store.compactOnLaunch();

    // Active log now holds only the pending proposal.
    const active = await store.list();
    expect(active.map((p) => p.id)).toEqual([pending.id]);
    expect(active[0]?.state).toBe("pending");

    // The full history still has all three with correct terminal states.
    const hist = await store.history();
    const byId = new Map(hist.map((p) => [p.id, p.state]));
    expect(byId.get(applied.id)).toBe("applied");
    expect(byId.get(rejected.id)).toBe("rejected");
    expect(byId.get(pending.id)).toBe("pending");
  });
});

// ---- kill-9 mid-compaction durability sim (1A) ----

const TSX = path.join(process.cwd(), "node_modules", ".bin", "tsx");
const COMPACTOR = path.join(process.cwd(), "scripts", "kill9-compactor.ts");

function spawnAndKill(storeDir: string, delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(TSX, [COMPACTOR, storeDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timer: NodeJS.Timeout | undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("compacting") && timer === undefined) {
        timer = setTimeout(() => child.kill("SIGKILL"), delayMs);
      }
    });
    const done = (): void => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    child.on("exit", done);
    child.on("error", done);
  });
}

describe("ProposalStore durability (kill -9 mid-compaction)", () => {
  it(
    "no proposal is lost across many killed compactions",
    async () => {
      let landedCompacted = 0;
      const delays = [0, 0, 0, 1, 1, 2, 3, 5, 10, 25, 60, 200];

      for (const delayMs of delays) {
        const d = await fs.mkdtemp(path.join(os.tmpdir(), "sb-prop-k9-"));
        try {
          const store = new ProposalStore(d);
          // Seed many resolved (applied) + a few active (pending), so the
          // archive write is wide enough to be interruptible.
          const appliedIds: string[] = [];
          for (let i = 0; i < 40; i++) {
            const p = await store.propose(
              draft({ kind: "create", targetPath: `note-${i}.md`, content: "X".repeat(4000) }),
              backref
            );
            await store.markApplying(p.id, `note-${i}.md`);
            await store.markApplied(p.id, `note-${i}.md`);
            appliedIds.push(p.id);
          }
          const pendingIds: string[] = [];
          for (let i = 0; i < 5; i++) {
            const p = await store.propose(draft({ targetPath: `pending-${i}.md` }), backref);
            pendingIds.push(p.id);
          }

          await spawnAndKill(d, delayMs);

          // Re-open and assert losslessness.
          const reopened = new ProposalStore(d);
          const active = await reopened.list(); // must always fold without throwing
          const hist = await reopened.history();
          const histById = new Map(hist.map((p) => [p.id, p.state]));

          for (const id of appliedIds) {
            expect(histById.get(id)).toBe("applied");
          }
          for (const id of pendingIds) {
            // Pending proposals always remain in the active log.
            expect(active.find((p) => p.id === id)?.state).toBe("pending");
          }

          // Detect whether this run actually completed the compaction.
          if (active.every((p) => p.state === "pending") && active.length === pendingIds.length) {
            landedCompacted++;
          }
        } finally {
          // maxRetries: a SIGKILLed compaction can leave a .tmp orphan that
          // races rmdir on macOS (ENOTEMPTY); retry settles it.
          await fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
      }

      // Prove the harness exercised a real compaction at least once.
      expect(landedCompacted).toBeGreaterThan(0);
    },
    120_000
  );
});
