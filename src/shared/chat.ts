// Shared shapes for durable multi-chat persistence (D14). Safe for the renderer
// to import: plain data only. Chats live in an APP-PRIVATE store, one
// append-only file per chatId, OUTSIDE the vault — so a chat bug can never
// corrupt a note (isolation = filesystem boundary) and a torn final line from a
// crash never loses an earlier turn (append-only = crash durability).

import type { GroundingMeta } from "./ai.js";

/**
 * One persisted turn. Only user/assistant turns are stored — the ephemeral
 * grounding system-injection is never persisted. Assistant turns keep their
 * GroundingMeta so the D12 badge survives a reload.
 */
export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  ts: number;
  grounding?: GroundingMeta;
}

/** Lightweight row for the chat list (sidebar). */
export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/** A fully-loaded chat: its header plus every persisted turn, in order. */
export interface ChatSession {
  id: string;
  createdAt: number;
  messages: StoredMessage[];
}
