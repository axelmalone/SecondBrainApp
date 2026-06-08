import { ChatStore } from "./chatStore.js";
import type {
  ChatSession,
  ChatSummary,
  StoredMessage,
} from "../shared/chat.js";

/**
 * Holds the single app-private ChatStore behind the IPC boundary (D14). The
 * renderer never touches these files directly; it round-trips plain data.
 */
let store: ChatStore | null = null;

export function initChats(dir: string): void {
  store = new ChatStore(dir);
}

export function chatList(): Promise<ChatSummary[]> {
  return store ? store.listChats() : Promise.resolve([]);
}

export function chatCreate(): Promise<ChatSummary> {
  if (!store) return Promise.reject(new Error("chat store not initialized"));
  return store.createChat();
}

export function chatLoad(id: string): Promise<ChatSession | null> {
  return store ? store.loadChat(id) : Promise.resolve(null);
}

export async function chatAppend(
  id: string,
  msg: StoredMessage
): Promise<void> {
  await store?.appendMessage(id, msg);
}

export async function chatDelete(id: string): Promise<void> {
  await store?.deleteChat(id);
}
