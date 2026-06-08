import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type {
  ProposalDraft,
  ProposalState,
  StoredProposal,
} from "../shared/proposal.js";

/** Only our own generated v4 UUIDs are valid ids (blocks IPC-borne garbage). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- The append-only event log (2A). One line per event; fold → latest state.
type ProposeEvent = {
  t: "propose";
  id: string;
  draft: ProposalDraft;
  chatId: string;
  turnTs: number;
  createdAt: number;
  baseText?: string;
};
type StaleEvent = {
  t: "stale";
  id: string;
  ts: number;
  baseText?: string;
  draft?: ProposalDraft;
  note?: string;
};
type EditEvent = { t: "edit"; id: string; ts: number; draft: ProposalDraft };
type RejectEvent = { t: "reject"; id: string; ts: number };
type ApplyingEvent = { t: "applying"; id: string; ts: number; targetPath: string };
type AppliedEvent = { t: "applied"; id: string; ts: number; appliedPath: string };
type ProposalEvent =
  | ProposeEvent
  | StaleEvent
  | EditEvent
  | RejectEvent
  | ApplyingEvent
  | AppliedEvent;

/** A proposal is RESOLVED once applied or rejected — eligible for archiving. */
function isResolved(state: ProposalState): boolean {
  return state === "applied" || state === "rejected";
}

/**
 * Durable proposal store (2A): a SINGLE append-only `proposals.jsonl` event log,
 * app-private, OUTSIDE the vault. Every propose / stale / edit / reject /
 * applying / applied is one appended line; reading folds the events to the
 * latest state per id. Append-only ⇒ a crash mid-write can only tear the LAST
 * line (tolerated), and the full history is the "auditable memory" moat —
 * every approve/reject/edit is recoverable.
 *
 * The `{chatId, turnTs}` backref to the originating chat turn lives HERE only;
 * the D14 chat format is never touched (CQ3-A).
 *
 * PURE Node (no Electron) so it is headlessly unit-testable, like chatStore.
 */
export class ProposalStore {
  constructor(private readonly dir: string) {}

  private get activeFile(): string {
    return path.join(this.dir, "proposals.jsonl");
  }
  private get archiveFile(): string {
    return path.join(this.dir, "proposals.archive.jsonl");
  }

  private async append(event: ProposalEvent): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.appendFile(this.activeFile, JSON.stringify(event) + "\n");
  }

  /** Record a brand-new proposal and return its folded record. */
  async propose(
    draft: ProposalDraft,
    backref: { chatId: string; turnTs: number },
    baseText?: string
  ): Promise<StoredProposal> {
    const id = randomUUID();
    const createdAt = Date.now();
    const ev: ProposeEvent = {
      t: "propose",
      id,
      draft,
      chatId: backref.chatId,
      turnTs: backref.turnTs,
      createdAt,
    };
    if (baseText !== undefined) ev.baseText = baseText;
    await this.append(ev);
    const stored = await this.get(id);
    if (!stored) throw new Error("proposal vanished immediately after write");
    return stored;
  }

  /** Mark a proposal stale (target drifted on disk), optionally recomputing. */
  async markStale(
    id: string,
    patch: { baseText?: string; draft?: ProposalDraft; note?: string } = {}
  ): Promise<void> {
    this.assertId(id);
    const ev: StaleEvent = { t: "stale", id, ts: Date.now() };
    if (patch.baseText !== undefined) ev.baseText = patch.baseText;
    if (patch.draft !== undefined) ev.draft = patch.draft;
    if (patch.note !== undefined) ev.note = patch.note;
    await this.append(ev);
  }

  /** Replace the proposal's draft with a user-edited version (resets to pending). */
  async edit(id: string, draft: ProposalDraft): Promise<void> {
    this.assertId(id);
    await this.append({ t: "edit", id, ts: Date.now(), draft });
  }

  /** Record the user rejecting a proposal. */
  async reject(id: string): Promise<void> {
    this.assertId(id);
    await this.append({ t: "reject", id, ts: Date.now() });
  }

  /** Crash marker BEFORE the note write lands (7A). */
  async markApplying(id: string, targetPath: string): Promise<void> {
    this.assertId(id);
    await this.append({ t: "applying", id, ts: Date.now(), targetPath });
  }

  /** Crash marker AFTER the note write lands (7A). */
  async markApplied(id: string, appliedPath: string): Promise<void> {
    this.assertId(id);
    await this.append({ t: "applied", id, ts: Date.now(), appliedPath });
  }

  /** All proposals, folded, newest-updated first. */
  async list(): Promise<StoredProposal[]> {
    const folded = await this.fold(this.activeFile);
    return [...folded.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** One folded proposal by id, or null. */
  async get(id: string): Promise<StoredProposal | null> {
    if (!UUID_RE.test(id)) return null;
    const folded = await this.fold(this.activeFile);
    return folded.get(id) ?? null;
  }

  /**
   * Ids stuck in "applying" with no matching "applied" — a crash landed mid-apply
   * (7A). The caller (proposalSession) verifies-then-reconciles each, NEVER blind
   * re-applies. Returns the folded records so the caller has the draft + backref.
   */
  async recoverInFlight(): Promise<StoredProposal[]> {
    const all = await this.list();
    return all.filter((p) => p.state === "applying");
  }

  private assertId(id: string): void {
    if (!UUID_RE.test(id)) throw new Error("invalid proposal id");
  }

  /** Parse one log file's raw text into ordered events (torn line tolerant). */
  private async readEvents(
    file: string
  ): Promise<{ raw: string; events: ProposalEvent[] }> {
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      return { raw: "", events: [] };
    }
    const events: ProposalEvent[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const ev = JSON.parse(line) as ProposalEvent;
        if (ev && typeof ev.id === "string" && UUID_RE.test(ev.id)) {
          events.push(ev);
        }
      } catch {
        // Torn final line (crash mid-append) or garbage — skip, keep the rest.
      }
    }
    return { raw, events };
  }

  /**
   * The full audit history: archive ⊎ active, folded. The archive holds resolved
   * proposals evicted by compaction; the active log holds the rest. Used by the
   * acceptance-rate instrument and durability checks. A proposal that crashed
   * mid-compaction may appear in both files with identical terminal events —
   * folding both is idempotent, so the merge stays correct.
   */
  async history(): Promise<StoredProposal[]> {
    const archived = await this.readEvents(this.archiveFile);
    const active = await this.readEvents(this.activeFile);
    const byId = this.foldEvents([...archived.events, ...active.events]);
    return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Fold an event log file to one StoredProposal per id. */
  private async fold(file: string): Promise<Map<string, StoredProposal>> {
    const { events } = await this.readEvents(file);
    return this.foldEvents(events);
  }

  /** Fold an ordered event list to one StoredProposal per id. */
  private foldEvents(events: ProposalEvent[]): Map<string, StoredProposal> {
    const byId = new Map<string, StoredProposal>();
    for (const ev of events) {
      switch (ev.t) {
        case "propose": {
          const p: StoredProposal = {
            id: ev.id,
            draft: ev.draft,
            state: "pending",
            chatId: ev.chatId,
            turnTs: ev.turnTs,
            createdAt: ev.createdAt,
            updatedAt: ev.createdAt,
          };
          if (ev.baseText !== undefined) p.baseText = ev.baseText;
          byId.set(ev.id, p);
          break;
        }
        case "stale": {
          const p = byId.get(ev.id);
          if (!p) break;
          p.state = "stale";
          p.updatedAt = ev.ts;
          if (ev.draft !== undefined) p.draft = ev.draft;
          if (ev.baseText !== undefined) p.baseText = ev.baseText;
          if (ev.note !== undefined) p.note = ev.note;
          break;
        }
        case "edit": {
          const p = byId.get(ev.id);
          if (!p) break;
          p.draft = ev.draft;
          p.state = "pending"; // a fresh edit clears staleness
          p.updatedAt = ev.ts;
          break;
        }
        case "reject": {
          const p = byId.get(ev.id);
          if (!p) break;
          p.state = "rejected";
          p.updatedAt = ev.ts;
          break;
        }
        case "applying": {
          const p = byId.get(ev.id);
          if (!p) break;
          p.state = "applying";
          p.updatedAt = ev.ts;
          break;
        }
        case "applied": {
          const p = byId.get(ev.id);
          if (!p) break;
          p.state = "applied";
          p.appliedPath = ev.appliedPath;
          p.updatedAt = ev.ts;
          break;
        }
      }
    }
    return byId;
  }

  /**
   * Compaction-on-launch (1A): archive the events of every RESOLVED proposal
   * (applied/rejected), then rewrite the active log with only the still-active
   * proposals' events. ORDER IS LOAD-BEARING for crash safety: the archive
   * append is durably fsync'd BEFORE the active log is atomically replaced, so a
   * kill-9 at any instant leaves the union (active ⊎ archive) lossless —
   * worst case a resolved proposal appears in both until the next launch.
   */
  async compactOnLaunch(): Promise<void> {
    const { raw, events } = await this.readEvents(this.activeFile);
    if (events.length === 0) return;

    const folded = await this.fold(this.activeFile);
    const resolvedIds = new Set(
      [...folded.values()].filter((p) => isResolved(p.state)).map((p) => p.id)
    );
    if (resolvedIds.size === 0) return; // nothing to compact

    // Partition the ORIGINAL lines so fold semantics are preserved exactly.
    const resolvedLines: string[] = [];
    const activeLines: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let id: string | undefined;
      try {
        id = (JSON.parse(line) as { id?: string }).id;
      } catch {
        continue; // drop a torn line during compaction
      }
      if (id && resolvedIds.has(id)) resolvedLines.push(line);
      else if (id) activeLines.push(line);
    }

    // 1. Archive FIRST, durably, before touching the active log.
    await fs.mkdir(this.dir, { recursive: true });
    await this.appendDurable(this.archiveFile, resolvedLines.join("\n") + "\n");

    // 2. Atomically replace the active log with only the active proposals.
    const body = activeLines.length > 0 ? activeLines.join("\n") + "\n" : "";
    await this.atomicReplace(this.activeFile, body);
  }

  /** Append + fsync the file so the bytes are durable before we proceed. */
  private async appendDurable(file: string, data: string): Promise<void> {
    const fh = await fs.open(file, "a");
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  /** Overwrite a file atomically: temp → fsync → rename. */
  private async atomicReplace(file: string, body: string): Promise<void> {
    const tmp = `${file}.${randomUUID()}.tmp`;
    const fh = await fs.open(tmp, "wx");
    try {
      await fh.writeFile(body);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, file);
  }
}
