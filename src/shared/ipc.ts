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

export type ConflictResolution = "keep-mine" | "take-theirs" | "keep-both";

export interface OpenResult {
  path: string;
  text: string;
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
  /** Open the native picker, load the chosen note. null if cancelled. */
  open(): Promise<OpenResult | null>;
  /** Save edited text back to disk via the guarded atomic write. */
  save(path: string, text: string): Promise<SaveResult>;
  /** Resolve a pending conflict for an open note. */
  resolve(path: string, resolution: ConflictResolution): Promise<ResolveResult>;

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

  /** Durable multi-chat store (D14), one append-only file per chat. */
  chatList(): Promise<ChatSummary[]>;
  chatCreate(): Promise<ChatSummary>;
  chatLoad(id: string): Promise<ChatSession | null>;
  chatAppend(id: string, msg: StoredMessage): Promise<void>;
  chatDelete(id: string): Promise<void>;
}
