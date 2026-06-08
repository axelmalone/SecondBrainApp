import { promises as fs } from "node:fs";
import * as path from "node:path";
import { guardedApply, readWithBaseline } from "../vault/index.js";
import type { DiskBaseline, GuardedApplyResult } from "../vault/index.js";
import { isInside } from "./vaultFiles.js";
import { ProposalStore } from "./proposalStore.js";
import { applyAnchoredAppend, triviallyEqual } from "./proposalApply.js";
import { diffBlocks, composeBlocks, allSelected } from "../shared/diff.js";
import type { DiffBlock } from "../shared/diff.js";
import type {
  AcceptanceStats,
  ApplyResult,
  ProposalDraft,
  StoredProposal,
} from "../shared/proposal.js";

export interface ProposalSessionDeps {
  store: ProposalStore;
  /** Current vault root (mutable in the app); null when no vault is open. */
  getRoot: () => string | null;
  /** Called after a proposal writes to disk, with the affected path(s) — wired
   *  to watcher self-write suppression + grounding reindex (like setOnSaved). */
  onApplied?: (paths: string[]) => void;
  /** Injectable clock for the keep-both sibling name (tests). */
  now?: () => Date;
}

const MAX_APPEND_RETRIES = 3;

/**
 * The apply engine for the write-back loop. Holds the ProposalStore and turns an
 * approved proposal into a guarded write through the SAME safe-write layer the
 * editor uses (guardedApply → atomicWrite TOCTOU guard → reconcile).
 *
 * Trust invariants enforced here:
 *  - SECURITY: every LLM-proposed path is re-validated isInside(root)+.md before
 *    any write — the most security-relevant new input in the system.
 *  - 4C conflict-at-approval: append re-splices against current disk; update/
 *    create collisions are NEVER clobbered — they recompute and re-surface for
 *    review, with keep-both as an explicit, separate action.
 *  - 7A crash safety: {applying} is recorded BEFORE the note write and {applied}
 *    AFTER; on restart an applying-without-applied is verified-then-reconciled,
 *    never blind re-applied (which would double-append).
 */
export class ProposalSession {
  private readonly store: ProposalStore;
  private readonly getRoot: () => string | null;
  private readonly onApplied: (paths: string[]) => void;
  private readonly now: () => Date;

  constructor(deps: ProposalSessionDeps) {
    this.store = deps.store;
    this.getRoot = deps.getRoot;
    this.onApplied = deps.onApplied ?? ((): void => {});
    this.now = deps.now ?? ((): Date => new Date());
  }

  /**
   * Resolve an LLM-proposed (vault-relative or absolute) path to a safe absolute
   * path inside the current vault, or null if it escapes the vault / isn't .md.
   * This is the mandatory security gate.
   */
  private resolveSafe(targetPath: string): string | null {
    const root = this.getRoot();
    if (!root) return null;
    const abs = path.resolve(root, targetPath);
    if (!isInside(root, abs)) return null;
    if (!abs.toLowerCase().endsWith(".md")) return null;
    return abs;
  }

  /** The proposalSink for aiSession: persist a parsed proposal, or null if its
   *  path is unsafe (then it is simply never queued). Captures baseText for the
   *  diff preview of update/append against current disk. */
  async create(
    draft: ProposalDraft,
    backref: { chatId: string; turnTs: number }
  ): Promise<StoredProposal | null> {
    const abs = this.resolveSafe(draft.targetPath);
    if (!abs) return null;
    let baseText: string | undefined;
    if (draft.kind !== "create") {
      try {
        baseText = await fs.readFile(abs, "utf8");
      } catch {
        baseText = undefined; // target doesn't exist yet
      }
    }
    return this.store.propose(draft, backref, baseText);
  }

  list(): Promise<StoredProposal[]> {
    return this.store.list();
  }

  stats(): Promise<AcceptanceStats> {
    return this.store.acceptanceStats();
  }

  reject(id: string): Promise<void> {
    return this.store.reject(id);
  }

  /** Replace a proposal's content with a user-edited version (resets to pending). */
  async edit(id: string, content: string): Promise<StoredProposal | null> {
    const p = await this.store.get(id);
    if (!p) return null;
    await this.store.edit(id, { ...p.draft, content });
    return this.store.get(id);
  }

  /**
   * The diff the review UX renders (multi-hunk for update, an append-preview for
   * append, all-add for create). Computed against the text the user reviewed
   * against (baseText) so hunk ids are stable for partial approval.
   */
  async diff(id: string): Promise<DiffBlock[]> {
    const p = await this.store.get(id);
    if (!p) return [];
    const abs = this.resolveSafe(p.draft.targetPath);
    if (!abs) return [];
    return (await this.blocksFor(p, abs)).blocks;
  }

  private async blocksFor(
    p: StoredProposal,
    abs: string
  ): Promise<{ blocks: DiffBlock[]; baseExists: boolean }> {
    let current = "";
    let baseExists = false;
    try {
      current = await fs.readFile(abs, "utf8");
      baseExists = true;
    } catch {
      /* note doesn't exist */
    }
    if (p.draft.kind === "create") {
      return { blocks: diffBlocks("", p.draft.content), baseExists };
    }
    if (p.draft.kind === "update") {
      const base = p.baseText ?? current;
      return { blocks: diffBlocks(base, p.draft.content), baseExists };
    }
    // append: preview the re-spliced result against current disk content.
    const preview =
      applyAnchoredAppend(current, p.draft.anchor, p.draft.content) ??
      current + p.draft.content;
    return { blocks: diffBlocks(current, preview), baseExists };
  }

  /**
   * Apply (approve) a proposal. With `selectedHunkIds` the user approved only a
   * SUBSET of the diff's hunks (hunk-vs-whole): we compose the exact resulting
   * text and write it as a guarded full-text edit. Without it, the whole
   * proposal is applied by its kind. Never clobbers.
   */
  async approve(id: string, selectedHunkIds?: number[]): Promise<ApplyResult> {
    const p = await this.store.get(id);
    if (!p) return { status: "error", message: "proposal not found" };
    const abs = this.resolveSafe(p.draft.targetPath);
    if (!abs) return { status: "invalid" }; // mandatory security gate

    try {
      if (selectedHunkIds !== undefined) {
        const { blocks } = await this.blocksFor(p, abs);
        if (!allSelected(blocks, new Set(selectedHunkIds))) {
          const full = composeBlocks(blocks, new Set(selectedHunkIds));
          // Record what the user actually chose (audit + the edited tally),
          // then write the composed text as a guarded full-text edit.
          await this.store.edit(id, { ...p.draft, kind: "update", content: full });
          const edited = await this.store.get(id);
          return await this.applyComposed(edited ?? p, abs, full);
        }
      }
      switch (p.draft.kind) {
        case "create":
          return await this.applyCreate(p, abs);
        case "update":
          return await this.applyUpdate(p, abs);
        case "append":
          return await this.applyAppend(p, abs);
      }
    } catch (err) {
      return { status: "error", message: String(err) };
    }
  }

  /** Guarded full-text write of a composed (partially-approved) result. */
  private async applyComposed(
    p: StoredProposal,
    abs: string,
    full: string
  ): Promise<ApplyResult> {
    let cur;
    try {
      cur = await readWithBaseline(abs);
    } catch {
      cur = null;
    }
    await this.store.markApplying(p.id, abs);
    const r = cur
      ? await guardedApply(abs, cur.baseline, full)
      : await guardedApply(abs, undefined, full);
    if (r.status === "saved") {
      await this.store.markApplied(p.id, abs);
      this.onApplied([abs]);
      return { status: "applied", appliedPath: abs };
    }
    if (r.status === "conflict") {
      await this.store.markStale(p.id, {
        baseText: r.diskText,
        note: "target changed during apply; review again",
      });
      return await this.reviewResult(p.id, cur ? "stale" : "collision");
    }
    return this.mapNonConflict(r);
  }

  private async applyCreate(p: StoredProposal, abs: string): Promise<ApplyResult> {
    await this.store.markApplying(p.id, abs);
    const r = await guardedApply(abs, undefined, p.draft.content);
    if (r.status === "saved") {
      await this.store.markApplied(p.id, abs);
      this.onApplied([abs]);
      return { status: "applied", appliedPath: abs };
    }
    if (r.status === "conflict") {
      // A note already exists at this path — never clobber; offer keep-both.
      await this.store.markStale(p.id, {
        baseText: r.diskText,
        note: "a note already exists at this path",
      });
      return await this.reviewResult(p.id, "collision");
    }
    return this.mapNonConflict(r);
  }

  private async applyUpdate(p: StoredProposal, abs: string): Promise<ApplyResult> {
    let cur;
    try {
      cur = await readWithBaseline(abs);
    } catch {
      await this.store.markStale(p.id, {
        note: "target note no longer exists; review again",
      });
      return await this.reviewResult(p.id, "stale");
    }
    const curText = cur.content.toString("utf8");
    if (!triviallyEqual(curText, p.baseText ?? "")) {
      // Disk drifted since the user reviewed — recompute + re-surface (4C).
      await this.store.markStale(p.id, {
        baseText: curText,
        note: "target changed on disk; review again",
      });
      return await this.reviewResult(p.id, "stale");
    }

    await this.store.markApplying(p.id, abs);
    const r = await guardedApply(abs, cur.baseline, p.draft.content);
    if (r.status === "saved") {
      await this.store.markApplied(p.id, abs);
      this.onApplied([abs]);
      return { status: "applied", appliedPath: abs };
    }
    if (r.status === "conflict") {
      await this.store.markStale(p.id, {
        baseText: r.diskText,
        note: "target changed during apply; review again",
      });
      return await this.reviewResult(p.id, "stale");
    }
    return this.mapNonConflict(r);
  }

  private async applyAppend(p: StoredProposal, abs: string): Promise<ApplyResult> {
    await this.store.markApplying(p.id, abs);

    for (let attempt = 0; attempt < MAX_APPEND_RETRIES; attempt++) {
      let cur: { content: Buffer; baseline: DiskBaseline } | null;
      try {
        cur = await readWithBaseline(abs);
      } catch {
        cur = null; // target doesn't exist → create it with the fragment
      }

      if (!cur) {
        const created = applyAnchoredAppend("", undefined, p.draft.content);
        const r = await guardedApply(abs, undefined, created ?? p.draft.content);
        if (r.status === "saved") {
          await this.store.markApplied(p.id, abs);
          this.onApplied([abs]);
          return { status: "applied", appliedPath: abs };
        }
        if (r.status === "conflict") continue; // someone created it; retry as append
        return this.mapNonConflict(r);
      }

      const curText = cur.content.toString("utf8");
      const spliced = applyAnchoredAppend(curText, p.draft.anchor, p.draft.content);
      if (spliced === null) {
        await this.store.markStale(p.id, {
          baseText: curText,
          note: "could not find the anchor text to append after; review again",
        });
        return await this.reviewResult(p.id, "anchor-missing");
      }

      const r = await guardedApply(abs, cur.baseline, spliced);
      if (r.status === "saved") {
        await this.store.markApplied(p.id, abs);
        this.onApplied([abs]);
        return { status: "applied", appliedPath: abs };
      }
      if (r.status === "conflict" || r.status === "deleted") {
        continue; // disk moved under us — re-read + re-splice (append composes)
      }
      return this.mapNonConflict(r); // renamed
    }
    return { status: "error", message: "append did not converge after retries" };
  }

  /**
   * Explicit keep-both: write the proposal's content to a `name (conflict DATE)`
   * sibling, preserving the existing note untouched. The separate, deliberate
   * escape hatch for a collision — never the default.
   */
  async keepBoth(id: string): Promise<ApplyResult> {
    const p = await this.store.get(id);
    if (!p) return { status: "error", message: "proposal not found" };
    const abs = this.resolveSafe(p.draft.targetPath);
    if (!abs) return { status: "invalid" };

    const sibling = await this.freeConflictPath(abs);
    await this.store.markApplying(p.id, sibling);
    const r = await guardedApply(sibling, undefined, p.draft.content);
    if (r.status === "saved") {
      await this.store.markApplied(p.id, sibling);
      this.onApplied([sibling]);
      return { status: "applied", appliedPath: sibling };
    }
    return this.mapNonConflict(r);
  }

  /**
   * Crash recovery (7A). For every proposal stuck in {applying} with no
   * {applied}, VERIFY whether the write actually landed on disk, then reconcile.
   * NEVER blind re-apply — re-applying an append would double-write.
   */
  async recoverOnLaunch(): Promise<void> {
    const inFlight = await this.store.recoverInFlight();
    for (const p of inFlight) {
      const abs = this.resolveSafe(p.draft.targetPath);
      let curText: string | null = null;
      if (abs) {
        try {
          curText = await fs.readFile(abs, "utf8");
        } catch {
          curText = null;
        }
      }
      if (this.didLand(p, curText)) {
        await this.store.markApplied(p.id, p.appliedPath ?? abs ?? p.draft.targetPath);
      } else {
        // Did not land (or can't prove it) → re-surface for review, never re-apply.
        await this.store.markStale(p.id, {
          baseText: curText ?? "",
          note: "apply was interrupted; verified not applied — review again",
        });
      }
    }
    await this.store.compactOnLaunch();
  }

  /**
   * Proactive staleness (4C): on a vault dirty event for `absPath`, mark any
   * actionable proposal targeting it stale if the disk content trivially differs
   * from what the user reviewed against. Trivial diffs are normalized so an
   * Obsidian autosave (trailing newline) does not false-stale.
   */
  async onVaultDirty(absPath: string): Promise<void> {
    const all = await this.store.list();
    for (const p of all) {
      if (p.state !== "pending") continue;
      const abs = this.resolveSafe(p.draft.targetPath);
      if (!abs || abs !== absPath) continue;
      let curText: string;
      try {
        curText = await fs.readFile(abs, "utf8");
      } catch {
        continue;
      }
      if (p.draft.kind === "create") continue; // create has no on-disk base
      if (!triviallyEqual(curText, p.baseText ?? "")) {
        await this.store.markStale(p.id, {
          baseText: curText,
          note: "the target note changed on disk; review again",
        });
      }
    }
  }

  // ---- internals ----

  private didLand(p: StoredProposal, curText: string | null): boolean {
    if (curText === null) return false;
    if (p.draft.kind === "append") {
      // Append is not idempotent — only treat as landed if the fragment is
      // already present (so we never double-append).
      return curText.includes(p.draft.content.replace(/\s+$/, ""));
    }
    // create / update land iff the file now equals the proposed full text.
    return triviallyEqual(curText, p.draft.content);
  }

  private async reviewResult(
    id: string,
    reason: "stale" | "collision" | "anchor-missing"
  ): Promise<ApplyResult> {
    const proposal = await this.store.get(id);
    if (!proposal) return { status: "error", message: "proposal vanished" };
    return { status: "needs-review", reason, proposal };
  }

  private mapNonConflict(r: GuardedApplyResult): ApplyResult {
    if (r.status === "deleted") return { status: "deleted" };
    if (r.status === "renamed") return { status: "renamed" };
    return { status: "error", message: "unexpected apply state" };
  }

  /** Local YYYY-MM-DD stamp for the keep-both sibling filename. */
  private dateStamp(): string {
    const d = this.now();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  private async freeConflictPath(original: string): Promise<string> {
    const dir = path.dirname(original);
    const ext = path.extname(original);
    const base = path.basename(original, ext);
    const stamp = this.dateStamp();
    for (let n = 1; ; n++) {
      const suffix = n === 1 ? "" : ` ${n}`;
      const candidate = path.join(dir, `${base} (conflict ${stamp}${suffix})${ext}`);
      try {
        await fs.access(candidate);
      } catch {
        return candidate;
      }
    }
  }
}
