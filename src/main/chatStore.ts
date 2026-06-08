import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type {
  ChatSession,
  ChatSummary,
  StoredMessage,
} from "../shared/chat.js";

/** Only our own generated v4 UUIDs are valid ids — this also blocks any path
 *  traversal from an id that crossed the IPC boundary. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TITLE_MAX = 60;

type HeaderRecord = { t: "h"; id: string; createdAt: number };
type MessageRecord = { t: "m" } & StoredMessage;
type Record = HeaderRecord | MessageRecord;

function titleFrom(messages: StoredMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "New chat";
  const line = firstUser.content.trim().split("\n")[0] ?? "";
  const t = line.slice(0, TITLE_MAX).trim();
  return t.length > 0 ? t : "New chat";
}

/**
 * Durable multi-chat store (D14): one APPEND-ONLY JSON-lines file per chatId in
 * an app-private directory OUTSIDE the vault. Each line is a record; appends are
 * never rewrites, so a crash mid-write can only ever tear the LAST line — which
 * the reader tolerates — and no earlier turn is lost. Isolation between chats is
 * a filesystem boundary: each chat is its own file, so one chat can never bleed
 * into or corrupt another (or a note).
 */
export class ChatStore {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    if (!UUID_RE.test(id)) throw new Error("invalid chat id");
    return path.join(this.dir, `${id}.jsonl`);
  }

  /** Create a fresh, empty chat and return its summary. */
  async createChat(): Promise<ChatSummary> {
    await fs.mkdir(this.dir, { recursive: true });
    const id = randomUUID();
    const createdAt = Date.now();
    const header: HeaderRecord = { t: "h", id, createdAt };
    // `wx` refuses to clobber — a UUID collision must never overwrite a chat.
    await fs.writeFile(this.file(id), JSON.stringify(header) + "\n", {
      flag: "wx",
    });
    return {
      id,
      title: "New chat",
      createdAt,
      updatedAt: createdAt,
      messageCount: 0,
    };
  }

  /** Append one turn. Append-only: the existing file is never rewritten. */
  async appendMessage(id: string, msg: StoredMessage): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const rec: MessageRecord = { t: "m", ...msg };
    await fs.appendFile(this.file(id), JSON.stringify(rec) + "\n");
  }

  /** Load a chat's full transcript, or null if it doesn't exist. */
  async loadChat(id: string): Promise<ChatSession | null> {
    const parsed = await this.read(id);
    if (!parsed) return null;
    return { id, createdAt: parsed.createdAt, messages: parsed.messages };
  }

  /** Every chat, newest activity first. Missing dir → empty list. */
  async listChats(): Promise<ChatSummary[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const summaries: ChatSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -".jsonl".length);
      if (!UUID_RE.test(id)) continue;
      const parsed = await this.read(id);
      if (!parsed) continue;
      const last = parsed.messages[parsed.messages.length - 1];
      summaries.push({
        id,
        title: titleFrom(parsed.messages),
        createdAt: parsed.createdAt,
        updatedAt: last ? last.ts : parsed.createdAt,
        messageCount: parsed.messages.length,
      });
    }
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries;
  }

  /** Delete a chat's file. No-op if already gone. */
  async deleteChat(id: string): Promise<void> {
    await fs.rm(this.file(id), { force: true });
  }

  private async read(
    id: string
  ): Promise<{ createdAt: number; messages: StoredMessage[] } | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file(id), "utf8");
    } catch {
      return null;
    }
    let createdAt = 0;
    const messages: StoredMessage[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let rec: Record;
      try {
        rec = JSON.parse(line) as Record;
      } catch {
        // A torn final line (crash mid-append) — or any unparseable line — is
        // skipped rather than failing the whole load. D14 durability.
        continue;
      }
      if (rec.t === "h") createdAt = rec.createdAt;
      else if (rec.t === "m") {
        const { t: _t, ...msg } = rec;
        messages.push(msg);
      }
    }
    // Header absent (e.g. its line was the torn one) → fall back to first turn.
    if (createdAt === 0) createdAt = messages[0]?.ts ?? Date.now();
    return { createdAt, messages };
  }
}
