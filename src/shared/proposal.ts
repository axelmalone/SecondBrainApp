// The proposal contract — shared by the gateway (which parses the model's
// proposal), the main process (which stores + applies it), and the renderer
// (which renders the review queue). Carries NO provider code and NO secrets.

import type { ToolSpec } from "./ai.js";

/** The three distinct write paths a proposal can take (CEO plan §1). */
export type ProposalKind = "create" | "append" | "update";

/**
 * A validated proposal as emitted by the model — the normalized output of
 * parseProposal, identical whether it arrived via provider tool-use or the
 * JSON-in-text fallback. The store later wraps this with an id + backref; the
 * apply layer turns it into a guarded write.
 *
 * - create : `content` is the full text of a brand-new note at `targetPath`.
 * - update : `content` is the full new text of an existing note.
 * - append : `content` is a DELTA fragment; `anchor` (when present) is a heading
 *            or trailing-context snippet to splice it after in the CURRENT disk
 *            content at apply time. No anchor → append at end of file (3A).
 */
export interface ProposalDraft {
  kind: ProposalKind;
  /** Vault-relative path, must end in `.md`. Security-checked (isInside) at apply. */
  targetPath: string;
  content: string;
  /** append only: heading/snippet to insert after; omit to append at end. */
  anchor?: string;
  /** Short rationale surfaced to the user in the review queue. */
  reason?: string;
}

/**
 * Reserved backref `chatId` for proposals the APP initiates rather than a chat
 * turn — e.g. the Settings "Set up your assistant" bootstrap (F7). Using this
 * sentinel keeps the backref honest ("this came from the app, not a chat")
 * instead of fabricating a throwaway chat the user never opened. It is not a
 * real chat id and never resolves to a chat session.
 */
export const SYSTEM_CHAT_ID = "system";

/** The success shape of a parsed turn (CQ2-A): a proposal is optional. */
export interface ParsedTurn {
  text: string;
  proposal?: ProposalDraft;
}

/** Lifecycle of a stored proposal, folded from the proposals.jsonl event log. */
export type ProposalState =
  | "pending" // proposed, awaiting a decision
  | "stale" // target drifted on disk since proposal — needs re-review (4C)
  | "applying" // apply in progress (crash marker; 7A)
  | "applied" // written to disk
  | "rejected"; // user rejected

/** A proposal as it lives in the store + crosses IPC to the review queue. */
export interface StoredProposal {
  id: string;
  draft: ProposalDraft;
  state: ProposalState;
  /** Backref to the originating chat turn — lives HERE only, never in chatStore. */
  chatId: string;
  turnTs: number;
  createdAt: number;
  updatedAt: number;
  /**
   * The target note's disk text the diff/preview was computed against (update +
   * append). Recomputed when the proposal is marked stale against current disk.
   * Absent for create (no prior content).
   */
  baseText?: string;
  /** Where the write actually landed (keep-both may divert to a sibling). */
  appliedPath?: string;
  /** Human-facing note: staleness reason, apply outcome, etc. */
  note?: string;
  /** True once the user edited the proposed text before deciding (UI badge + stats). */
  edited?: boolean;
}

/** The outcome of approving (applying) a proposal — crosses IPC to the queue. */
export type ApplyResult =
  | { status: "applied"; appliedPath: string }
  // The target drifted / collided / lost its anchor: the proposal was NOT
  // written; it is recomputed against current disk and must be re-reviewed (4C).
  | {
      status: "needs-review";
      reason: "stale" | "collision" | "anchor-missing";
      proposal: StoredProposal;
    }
  | { status: "deleted" }
  | { status: "renamed" }
  | { status: "invalid" } // path failed the isInside(root)+.md security check
  | { status: "error"; message: string };

/**
 * The acceptance-rate gate instrument — the actual 2-week-trust signal, tallied
 * from proposals.jsonl (active ⊎ archive). `edited` counts proposals the user
 * changed before approving; it is a subset of `approved`-eligible activity.
 */
export interface AcceptanceStats {
  proposed: number;
  approved: number;
  edited: number;
  rejected: number;
  pending: number;
  /** approved / (approved + rejected), 0 when no decisions yet. */
  acceptanceRate: number;
}

// ---- The propose tool (tool-use path) ----

export const PROPOSE_TOOL_NAME = "propose_note_edit";

/**
 * The single tool we offer the model for writing to the vault. The model calls
 * it INSTEAD of writing the note itself; the user reviews + approves every call
 * before anything lands. Both providers map this to their native tool schema;
 * the JSON-in-text fallback instructs the model to emit the same object shape.
 */
export const PROPOSE_TOOL: ToolSpec = {
  name: PROPOSE_TOOL_NAME,
  description:
    "Propose ONE edit to the user's note vault: create a new note, append to an " +
    "existing note, or update an existing note in place. Do NOT call this to " +
    "answer a question — only when the user wants something recorded or changed. " +
    "The user reviews a diff and approves before anything is written.",
  inputSchema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["create", "append", "update"],
        description: "create a new note, append to one, or replace its full text",
      },
      targetPath: {
        type: "string",
        description: "Vault-relative path to the note, ending in .md",
      },
      content: {
        type: "string",
        description:
          "create/update: the FULL note text. append: only the fragment to add.",
      },
      anchor: {
        type: "string",
        description:
          "append only: a heading or short text snippet to insert after; omit to append at the end.",
      },
      reason: {
        type: "string",
        description: "One short sentence shown to the user explaining the edit.",
      },
    },
    required: ["kind", "targetPath", "content"],
  },
};
