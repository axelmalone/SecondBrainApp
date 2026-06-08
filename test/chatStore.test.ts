import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ChatStore } from "../src/main/chatStore.js";

let dir: string;
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

async function makeStore(): Promise<ChatStore> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-chat-"));
  return new ChatStore(dir);
}

describe("ChatStore basics (D14)", () => {
  it("creates, appends, and reloads a chat in order", async () => {
    const store = await makeStore();
    const { id } = await store.createChat();

    await store.appendMessage(id, { role: "user", content: "hi", ts: 1 });
    await store.appendMessage(id, {
      role: "assistant",
      content: "hello",
      ts: 2,
      grounding: { grounded: false, reason: "off" },
    });

    const session = await store.loadChat(id);
    expect(session?.messages.map((m) => m.content)).toEqual(["hi", "hello"]);
    expect(session?.messages[1]?.grounding).toEqual({
      grounded: false,
      reason: "off",
    });
  });

  it("loadChat returns null for an unknown id", async () => {
    const store = await makeStore();
    expect(
      await store.loadChat("00000000-0000-0000-0000-000000000000")
    ).toBeNull();
  });

  it("derives the title from the first user message and sorts by recency", async () => {
    const store = await makeStore();
    const a = await store.createChat();
    const b = await store.createChat();
    await store.appendMessage(a.id, {
      role: "user",
      content: "first chat topic",
      ts: 10,
    });
    await store.appendMessage(b.id, {
      role: "user",
      content: "second chat topic",
      ts: 20, // more recent → should sort first
    });

    const list = await store.listChats();
    expect(list[0]?.id).toBe(b.id);
    expect(list[0]?.title).toBe("second chat topic");
    expect(list[1]?.title).toBe("first chat topic");
  });

  it("renameChat overrides the derived title; empty clears the override", async () => {
    const store = await makeStore();
    const { id } = await store.createChat();
    await store.appendMessage(id, {
      role: "user",
      content: "derived title here",
      ts: 10,
    });

    await store.renameChat(id, "My custom name");
    let row = (await store.listChats()).find((c) => c.id === id);
    expect(row?.title).toBe("My custom name");

    // Latest rename record wins (append-only — no rewrite of earlier turns).
    await store.renameChat(id, "Renamed again");
    row = (await store.listChats()).find((c) => c.id === id);
    expect(row?.title).toBe("Renamed again");

    // Clearing the override falls back to the first-message title.
    await store.renameChat(id, "");
    row = (await store.listChats()).find((c) => c.id === id);
    expect(row?.title).toBe("derived title here");
  });

  it("an empty chat lists as 'New chat' with zero messages", async () => {
    const store = await makeStore();
    const { id } = await store.createChat();
    const list = await store.listChats();
    const row = list.find((c) => c.id === id);
    expect(row?.title).toBe("New chat");
    expect(row?.messageCount).toBe(0);
  });

  it("deletes a chat", async () => {
    const store = await makeStore();
    const { id } = await store.createChat();
    await store.deleteChat(id);
    expect(await store.loadChat(id)).toBeNull();
    expect(await store.listChats()).toEqual([]);
  });

  it("missing store dir lists as empty (no crash)", async () => {
    const store = new ChatStore(path.join(os.tmpdir(), "sb-chat-does-not-exist-xyz"));
    expect(await store.listChats()).toEqual([]);
  });
});

describe("ChatStore isolation (filesystem boundary)", () => {
  it("two chats never bleed into each other", async () => {
    const store = await makeStore();
    const a = await store.createChat();
    const b = await store.createChat();

    await store.appendMessage(a.id, { role: "user", content: "alpha", ts: 1 });
    await store.appendMessage(b.id, { role: "user", content: "beta", ts: 1 });

    const sa = await store.loadChat(a.id);
    const sb = await store.loadChat(b.id);
    expect(sa?.messages.map((m) => m.content)).toEqual(["alpha"]);
    expect(sb?.messages.map((m) => m.content)).toEqual(["beta"]);
    // Separate files on disk.
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBe(2);
  });
});

describe("ChatStore crash durability (append-only)", () => {
  it("a torn final line never loses earlier turns", async () => {
    const store = await makeStore();
    const { id } = await store.createChat();
    await store.appendMessage(id, { role: "user", content: "kept one", ts: 1 });
    await store.appendMessage(id, { role: "assistant", content: "kept two", ts: 2 });

    // Simulate a crash mid-append: a partial, unterminated JSON line at the end.
    const file = path.join(dir, `${id}.jsonl`);
    await fs.appendFile(file, '{"t":"m","role":"user","content":"torn');

    const session = await store.loadChat(id);
    expect(session?.messages.map((m) => m.content)).toEqual([
      "kept one",
      "kept two",
    ]);
  });
});

describe("ChatStore id safety", () => {
  it("rejects a non-UUID id (blocks path traversal)", async () => {
    const store = await makeStore();
    await expect(
      store.appendMessage("../../etc/evil", { role: "user", content: "x", ts: 1 })
    ).rejects.toThrow(/invalid chat id/);
  });
});
