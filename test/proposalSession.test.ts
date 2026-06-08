import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProposalStore } from "../src/main/proposalStore.js";
import { ProposalSession } from "../src/main/proposalSession.js";
import type { ProposalDraft } from "../src/shared/proposal.js";

let tmp: string;
afterEach(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

async function setup(): Promise<{
  session: ProposalSession;
  store: ProposalStore;
  vault: string;
  applied: string[];
}> {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sb-psess-"));
  const vault = path.join(tmp, "vault");
  const storeDir = path.join(tmp, "store");
  await fs.mkdir(vault, { recursive: true });
  const store = new ProposalStore(storeDir);
  const applied: string[] = [];
  const session = new ProposalSession({
    store,
    getRoot: () => vault,
    onApplied: (paths) => applied.push(...paths),
    now: () => new Date("2026-06-08T12:00:00Z"),
  });
  return { session, store, vault, applied };
}

const ref = { chatId: "c1", turnTs: 1 };
const draft = (o: Partial<ProposalDraft>): ProposalDraft => ({
  kind: "create",
  targetPath: "n.md",
  content: "x",
  ...o,
});
const read = (p: string): Promise<string> => fs.readFile(p, "utf8");

describe("ProposalSession.create — path security (mandatory)", () => {
  it("rejects a path that escapes the vault", async () => {
    const { session } = await setup();
    expect(await session.create(draft({ targetPath: "../escape.md" }), ref)).toBeNull();
    expect(
      await session.create(draft({ targetPath: "/etc/passwd.md" }), ref)
    ).toBeNull();
  });
  it("rejects a non-.md path", async () => {
    const { session } = await setup();
    expect(await session.create(draft({ targetPath: "n.txt" }), ref)).toBeNull();
  });
  it("queues a safe path", async () => {
    const { session } = await setup();
    const p = await session.create(draft({ targetPath: "Notes/idea.md" }), ref);
    expect(p?.state).toBe("pending");
  });
});

describe("ProposalSession.approve — create", () => {
  it("writes a brand-new note", async () => {
    const { session, vault, applied } = await setup();
    const p = await session.create(
      draft({ kind: "create", targetPath: "fresh.md", content: "# Fresh\n" }),
      ref
    );
    const res = await session.approve(p!.id);
    expect(res.status).toBe("applied");
    expect(await read(path.join(vault, "fresh.md"))).toBe("# Fresh\n");
    expect(applied).toContain(path.join(vault, "fresh.md"));
  });

  it("collides (never clobbers) when the note exists; keep-both writes a sibling", async () => {
    const { session, store, vault } = await setup();
    await fs.writeFile(path.join(vault, "dup.md"), "ORIGINAL", "utf8");
    const p = await session.create(
      draft({ kind: "create", targetPath: "dup.md", content: "PROPOSED" }),
      ref
    );
    const res = await session.approve(p!.id);
    expect(res.status).toBe("needs-review");
    if (res.status === "needs-review") expect(res.reason).toBe("collision");
    expect(await read(path.join(vault, "dup.md"))).toBe("ORIGINAL"); // untouched

    const kb = await session.keepBoth(p!.id);
    expect(kb.status).toBe("applied");
    expect(await read(path.join(vault, "dup.md"))).toBe("ORIGINAL");
    const sibling = path.join(vault, "dup (conflict 2026-06-08).md");
    expect(await read(sibling)).toBe("PROPOSED");
    expect((await store.get(p!.id))?.state).toBe("applied");
  });
});

describe("ProposalSession.approve — update (4C)", () => {
  it("applies when disk is unchanged since review", async () => {
    const { session, vault } = await setup();
    await fs.writeFile(path.join(vault, "u.md"), "v1\n", "utf8");
    const p = await session.create(
      draft({ kind: "update", targetPath: "u.md", content: "v2\n" }),
      ref
    );
    const res = await session.approve(p!.id);
    expect(res.status).toBe("applied");
    expect(await read(path.join(vault, "u.md"))).toBe("v2\n");
  });

  it("marks stale (no clobber) when the target drifted on disk", async () => {
    const { session, store, vault } = await setup();
    await fs.writeFile(path.join(vault, "u.md"), "v1\n", "utf8");
    const p = await session.create(
      draft({ kind: "update", targetPath: "u.md", content: "v2\n" }),
      ref
    );
    // Obsidian changes the note after the proposal was made.
    await fs.writeFile(path.join(vault, "u.md"), "EXTERNAL\n", "utf8");
    const res = await session.approve(p!.id);
    expect(res.status).toBe("needs-review");
    if (res.status === "needs-review") {
      expect(res.reason).toBe("stale");
      expect(res.proposal.baseText).toBe("EXTERNAL\n"); // recomputed vs current
    }
    expect(await read(path.join(vault, "u.md"))).toBe("EXTERNAL\n"); // untouched
    expect((await store.get(p!.id))?.state).toBe("stale");
  });

  it("does not false-stale on a trivial trailing-newline diff", async () => {
    const { session, vault } = await setup();
    await fs.writeFile(path.join(vault, "u.md"), "v1\n", "utf8");
    const p = await session.create(
      draft({ kind: "update", targetPath: "u.md", content: "v2\n" }),
      ref
    );
    await fs.writeFile(path.join(vault, "u.md"), "v1\n\n", "utf8"); // trivial drift
    const res = await session.approve(p!.id);
    expect(res.status).toBe("applied");
  });
});

describe("ProposalSession.approve — append (3A composes)", () => {
  it("appends at the end", async () => {
    const { session, vault } = await setup();
    await fs.writeFile(path.join(vault, "log.md"), "# Log\n", "utf8");
    const p = await session.create(
      draft({ kind: "append", targetPath: "log.md", content: "- entry" }),
      ref
    );
    const res = await session.approve(p!.id);
    expect(res.status).toBe("applied");
    expect(await read(path.join(vault, "log.md"))).toBe("# Log\n- entry\n");
  });

  it("composes cleanly when Obsidian edited the note after the proposal (no conflict)", async () => {
    const { session, vault } = await setup();
    await fs.writeFile(path.join(vault, "log.md"), "# Log\n", "utf8");
    const p = await session.create(
      draft({ kind: "append", targetPath: "log.md", content: "- ai entry" }),
      ref
    );
    // User edits the note in Obsidian between proposal and approval.
    await fs.writeFile(path.join(vault, "log.md"), "# Log\n- my own entry\n", "utf8");
    const res = await session.approve(p!.id);
    expect(res.status).toBe("applied"); // re-spliced against CURRENT content
    expect(await read(path.join(vault, "log.md"))).toBe(
      "# Log\n- my own entry\n- ai entry\n"
    );
  });

  it("marks stale when the anchor is gone", async () => {
    const { session, vault } = await setup();
    await fs.writeFile(path.join(vault, "log.md"), "# Log\n", "utf8");
    const p = await session.create(
      draft({ kind: "append", targetPath: "log.md", content: "- e", anchor: "## Today" }),
      ref
    );
    const res = await session.approve(p!.id);
    expect(res.status).toBe("needs-review");
    if (res.status === "needs-review") expect(res.reason).toBe("anchor-missing");
  });

  it("creates the note when the append target does not exist", async () => {
    const { session, vault } = await setup();
    const p = await session.create(
      draft({ kind: "append", targetPath: "new-daily.md", content: "- first" }),
      ref
    );
    const res = await session.approve(p!.id);
    expect(res.status).toBe("applied");
    expect(await read(path.join(vault, "new-daily.md"))).toBe("- first\n");
  });
});

describe("ProposalSession.onVaultDirty — proactive staleness (4C)", () => {
  it("marks a pending update stale on a real disk change", async () => {
    const { session, store, vault } = await setup();
    await fs.writeFile(path.join(vault, "u.md"), "v1\n", "utf8");
    const p = await session.create(
      draft({ kind: "update", targetPath: "u.md", content: "v2\n" }),
      ref
    );
    await fs.writeFile(path.join(vault, "u.md"), "CHANGED\n", "utf8");
    await session.onVaultDirty(path.join(vault, "u.md"));
    expect((await store.get(p!.id))?.state).toBe("stale");
  });

  it("does NOT stale on a trivial (newline) change", async () => {
    const { session, store, vault } = await setup();
    await fs.writeFile(path.join(vault, "u.md"), "v1\n", "utf8");
    const p = await session.create(
      draft({ kind: "update", targetPath: "u.md", content: "v2\n" }),
      ref
    );
    await fs.writeFile(path.join(vault, "u.md"), "v1\n\n", "utf8");
    await session.onVaultDirty(path.join(vault, "u.md"));
    expect((await store.get(p!.id))?.state).toBe("pending");
  });
});

describe("ProposalSession.diff + hunk-vs-whole approval", () => {
  it("exposes a multi-hunk diff and applies only the selected hunks", async () => {
    const { session, vault } = await setup();
    await fs.writeFile(path.join(vault, "u.md"), "a\nb\nc\nd\ne\n", "utf8");
    const p = await session.create(
      draft({ kind: "update", targetPath: "u.md", content: "a\nB\nc\nd\nE\n" }),
      ref
    );
    const blocks = await session.diff(p!.id);
    const changeIds = blocks
      .filter((b) => b.type === "change")
      .map((b) => (b as { id: number }).id);
    expect(changeIds).toHaveLength(2);

    // Approve ONLY the first hunk → only that change lands.
    const res = await session.approve(p!.id, [changeIds[0]!]);
    expect(res.status).toBe("applied");
    expect(await read(path.join(vault, "u.md"))).toBe("a\nB\nc\nd\ne\n");
  });

  it("approving with all hunks selected applies the whole edit", async () => {
    const { session, vault } = await setup();
    await fs.writeFile(path.join(vault, "u.md"), "x\ny\n", "utf8");
    const p = await session.create(
      draft({ kind: "update", targetPath: "u.md", content: "X\nY\n" }),
      ref
    );
    const blocks = await session.diff(p!.id);
    const ids = blocks.filter((b) => b.type === "change").map((b) => (b as { id: number }).id);
    const res = await session.approve(p!.id, ids);
    expect(res.status).toBe("applied");
    expect(await read(path.join(vault, "u.md"))).toBe("X\nY\n");
  });

  it("an append diff previews the fragment as additions", async () => {
    const { session, vault } = await setup();
    await fs.writeFile(path.join(vault, "log.md"), "# Log\n", "utf8");
    const p = await session.create(
      draft({ kind: "append", targetPath: "log.md", content: "- entry" }),
      ref
    );
    const blocks = await session.diff(p!.id);
    const change = blocks.find((b) => b.type === "change");
    expect(change).toMatchObject({ add: ["- entry"] });
  });
});

describe("ProposalSession acceptance stats", () => {
  it("tallies approved / rejected / edited and the acceptance rate", async () => {
    const { session, store, vault } = await setup();
    await fs.writeFile(path.join(vault, "a.md"), "v1\n", "utf8");

    const approved = await session.create(
      draft({ kind: "update", targetPath: "a.md", content: "v2\n" }),
      ref
    );
    await session.approve(approved!.id);

    const rejected = await session.create(
      draft({ kind: "create", targetPath: "b.md", content: "x" }),
      ref
    );
    await session.reject(rejected!.id);

    await session.create(draft({ kind: "create", targetPath: "c.md", content: "y" }), ref);

    const stats = await store.acceptanceStats();
    expect(stats.proposed).toBe(3);
    expect(stats.approved).toBe(1);
    expect(stats.rejected).toBe(1);
    expect(stats.pending).toBe(1);
    expect(stats.acceptanceRate).toBeCloseTo(0.5);
  });
});

describe("ProposalSession.recoverOnLaunch — verify-then-reconcile (7A)", () => {
  it("marks applied when the append fragment is already on disk (never double-applies)", async () => {
    const { session, store, vault } = await setup();
    await fs.writeFile(path.join(vault, "log.md"), "# Log\n- landed entry\n", "utf8");
    const p = await session.create(
      draft({ kind: "append", targetPath: "log.md", content: "- landed entry" }),
      ref
    );
    // Simulate a crash AFTER the note write but BEFORE the applied record.
    await store.markApplying(p!.id, path.join(vault, "log.md"));

    await session.recoverOnLaunch();

    // Resolved → compaction archived it; assert via the full history.
    const hist = await store.history();
    expect(hist.find((x) => x.id === p!.id)?.state).toBe("applied");
    // The note must NOT have been appended a second time.
    expect(await read(path.join(vault, "log.md"))).toBe("# Log\n- landed entry\n");
  });

  it("marks stale (never re-applies) when the write did not land", async () => {
    const { session, store, vault } = await setup();
    await fs.writeFile(path.join(vault, "log.md"), "# Log\n", "utf8");
    const p = await session.create(
      draft({ kind: "append", targetPath: "log.md", content: "- never landed" }),
      ref
    );
    await store.markApplying(p!.id, path.join(vault, "log.md"));

    await session.recoverOnLaunch();

    expect((await store.get(p!.id))?.state).toBe("stale");
    expect(await read(path.join(vault, "log.md"))).toBe("# Log\n"); // untouched
  });
});
