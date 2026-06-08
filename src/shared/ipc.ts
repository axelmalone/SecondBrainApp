// The IPC contract between the Electron main process (which owns the vault I/O
// layer and the live Automerge docs) and the renderer (which only ever sees
// plain text). The renderer never touches the filesystem or a CRDT directly.

import type {
  AiIndexResult,
  AiSendOptions,
  AiSendResult,
  AiSetKeyResult,
  AiStatus,
  ChatRequest,
  GroundingStatus,
  ProviderId,
} from "./ai.js";
import type { ChatSession, ChatSummary, StoredMessage } from "./chat.js";
import type { AcceptanceStats, ApplyResult, StoredProposal } from "./proposal.js";
import type { RenderNode } from "./render.js";

export type {
  AiIndexResult,
  AiSendOptions,
  AiSendResult,
  AiSetKeyResult,
  AiStatus,
  ChatRequest,
  GroundingStatus,
} from "./ai.js";
export type { ChatSession, ChatSummary, StoredMessage } from "./chat.js";
export type { AcceptanceStats, ApplyResult, StoredProposal } from "./proposal.js";
export type { RenderNode, RenderTag } from "./render.js";

export type ConflictResolution = "keep-mine" | "take-theirs" | "keep-both";

export interface OpenResult {
  path: string;
  text: string;
}

/** The active vault: absolute root + its display name. null when none chosen. */
export interface VaultInfo {
  root: string | null;
  name: string | null;
}

/** One entry in the vault file tree. Dirs carry their (already-walked) children. */
export interface FileNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: FileNode[];
}

/** Outcome of a save attempt. Discriminated on `status`. */
export type SaveResult =
  | { status: "saved"; text: string }
  | { status: "conflict"; diskText: string } // external write detected, edits unsaved
  | { status: "deleted" } // the file is gone from disk
  | { status: "renamed" } // a different file now sits at the path
  | { status: "error"; message: string };

/** Outcome of resolving a conflict per the user's choice. */
export type ResolveResult =
  | { status: "keep-mine"; text: string }
  | { status: "take-theirs"; text: string }
  | { status: "keep-both"; theirsText: string; minePath: string }
  | { status: "error"; message: string };

/** The surface exposed to the renderer on `window.secondBrain`. */
export interface SecondBrainAPI {
  /** The active vault root + display name (null if none chosen yet). */
  vaultInfo(): Promise<VaultInfo>;
  /** Pick an EXISTING folder as the vault. null if cancelled. */
  vaultChoose(): Promise<VaultInfo | null>;
  /** Create a NEW vault folder and switch to it. null if cancelled. */
  vaultCreate(): Promise<VaultInfo | null>;
  /** The vault's markdown file tree (dirs + .md files, dot-dirs skipped). */
  vaultFiles(): Promise<FileNode[]>;
  /** Open a note by absolute path (from the tree). null if outside the vault. */
  openPath(path: string): Promise<OpenResult | null>;
  /** Save edited text back to disk via the guarded atomic write. */
  save(path: string, text: string): Promise<SaveResult>;
  /** Resolve a pending conflict for an open note. */
  resolve(path: string, resolution: ConflictResolution): Promise<ResolveResult>;
  /** Render markdown to the safe render-AST for the glass-box read view (5A). */
  renderMarkdown(source: string): Promise<RenderNode[]>;
  /** Open a wikilink's target note by name/path. null if it doesn't exist. */
  openWikilink(target: string): Promise<OpenResult | null>;
  /** Open an external (http/https/mailto) link in the system browser. */
  openExternal(url: string): Promise<void>;

  /** Current key-store state + which providers have a key configured. */
  aiStatus(): Promise<AiStatus>;
  /** Store (or replace) a BYO provider key. */
  aiSetKey(provider: ProviderId, key: string): Promise<AiSetKeyResult>;
  /** Send a chat request through the model gateway, optionally vault-grounded. */
  aiSend(req: ChatRequest, opts?: AiSendOptions): Promise<AiSendResult>;
  /** Current grounding index state (ready / indexing / counts). */
  aiGroundingStatus(): Promise<GroundingStatus>;
  /** Re-index the vault for grounding. Triggers the local embedding model. */
  aiIndexVault(): Promise<AiIndexResult>;

  // ---- Write-back review queue (the proposal loop) ----
  /** Every proposal, folded, newest-updated first. */
  proposalList(): Promise<StoredProposal[]>;
  /** Apply (approve) a proposal through the guarded safe-write layer. */
  proposalApprove(id: string): Promise<ApplyResult>;
  /** Reject a proposal (records the decision; nothing is written). */
  proposalReject(id: string): Promise<void>;
  /** Replace a proposal's content with the user's edited text (resets to pending). */
  proposalEdit(id: string, content: string): Promise<StoredProposal | null>;
  /** Explicit keep-both: write the proposal to a sibling, leave the target intact. */
  proposalKeepBoth(id: string): Promise<ApplyResult>;
  /** Acceptance-rate tally (proposed/approved/edited/rejected) — the gate signal. */
  proposalStats(): Promise<AcceptanceStats>;

  /** Durable multi-chat store (D14), one append-only file per chat. */
  chatList(): Promise<ChatSummary[]>;
  chatCreate(): Promise<ChatSummary>;
  chatLoad(id: string): Promise<ChatSession | null>;
  chatAppend(id: string, msg: StoredMessage): Promise<void>;
  chatRename(id: string, title: string): Promise<void>;
  chatDelete(id: string): Promise<void>;
}
