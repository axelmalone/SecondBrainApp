import { describe, it, expect } from "vitest";
import { anthropicAdapter } from "../src/gateway/providers/anthropic.js";
import { openaiAdapter } from "../src/gateway/providers/openai.js";
import type { FetchLike } from "../src/gateway/types.js";
import type { ChatMessage, ChatRequest } from "../src/shared/ai.js";

/** A fetch that records the parsed request body and returns a fixed response. */
function capturing(responseBody: string): {
  fetch: FetchLike;
  body: () => Record<string, unknown>;
} {
  let captured: Record<string, unknown> = {};
  const fetch: FetchLike = async (_url, init) => {
    captured = JSON.parse((init.body as string) ?? "{}");
    return new Response(responseBody, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, body: () => captured };
}

// A message list with a full tool round-trip, including TWO parallel tool calls
// in one assistant turn and their two results.
const msgs: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "what did I decide about pricing?" },
  {
    role: "assistant",
    content: "Let me search.",
    toolCalls: [
      { id: "t1", name: "search_vault", input: { query: "pricing" } },
      { id: "t2", name: "search_vault", input: { query: "decision" } },
    ],
  },
  { role: "tool", toolCallId: "t1", content: "chunk A" },
  { role: "tool", toolCallId: "t2", content: "chunk B" },
  { role: "user", content: "(continue)" },
];

const ctx = (fetch: FetchLike) => ({
  apiKey: "k",
  fetch,
  signal: new AbortController().signal,
});

describe("anthropic adapter — tool round-trip serialization (6A)", () => {
  it("rebuilds tool_use blocks and collapses parallel results into one user turn", async () => {
    const cap = capturing(
      JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" })
    );
    const req: ChatRequest = {
      model: { provider: "anthropic", model: "claude-x" },
      messages: msgs,
    };
    await anthropicAdapter.send(req, ctx(cap.fetch));
    const body = cap.body();

    expect(body.system).toBe("sys"); // system pulled out separately
    const m = body.messages as { role: string; content: unknown }[];
    // user, assistant(tool_use), user(tool_results x2 collapsed), user(continue)
    expect(m).toHaveLength(4);

    expect(m[0]).toEqual({ role: "user", content: "what did I decide about pricing?" });

    // assistant turn = [text block, tool_use, tool_use] in order (6A reconstruction)
    expect(m[1]?.role).toBe("assistant");
    const blocks = m[1]?.content as Record<string, unknown>[];
    expect(blocks[0]).toEqual({ type: "text", text: "Let me search." });
    expect(blocks[1]).toEqual({
      type: "tool_use",
      id: "t1",
      name: "search_vault",
      input: { query: "pricing" },
    });
    expect(blocks[2]).toMatchObject({ type: "tool_use", id: "t2" });

    // BOTH tool_results land in a SINGLE user turn (parallel-call requirement)
    expect(m[2]?.role).toBe("user");
    const results = m[2]?.content as Record<string, unknown>[];
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      type: "tool_result",
      tool_use_id: "t1",
      content: "chunk A",
    });
    expect(results[1]).toMatchObject({ type: "tool_result", tool_use_id: "t2" });

    expect(m[3]).toEqual({ role: "user", content: "(continue)" });
  });
});

describe("openai adapter — tool round-trip serialization (6A)", () => {
  it("emits assistant.tool_calls (args as JSON string) and role:tool results by id", async () => {
    const cap = capturing(
      JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] })
    );
    const req: ChatRequest = {
      model: { provider: "openai", model: "gpt-x" },
      messages: msgs,
    };
    await openaiAdapter.send(req, ctx(cap.fetch));
    const m = cap.body().messages as Record<string, unknown>[];

    // OpenAI keeps system inline: system, user, assistant, tool, tool, user
    expect(m).toHaveLength(6);
    expect(m[0]).toEqual({ role: "system", content: "sys" });

    const asst = m[2] as { role: string; content: unknown; tool_calls: unknown[] };
    expect(asst.role).toBe("assistant");
    expect(asst.content).toBe("Let me search.");
    expect(asst.tool_calls).toHaveLength(2);
    expect(asst.tool_calls[0]).toEqual({
      id: "t1",
      type: "function",
      function: { name: "search_vault", arguments: '{"query":"pricing"}' },
    });

    expect(m[3]).toEqual({ role: "tool", tool_call_id: "t1", content: "chunk A" });
    expect(m[4]).toEqual({ role: "tool", tool_call_id: "t2", content: "chunk B" });
    expect(m[5]).toEqual({ role: "user", content: "(continue)" });
  });

  it("assistant content is null when a turn is a pure tool call (no text)", async () => {
    const cap = capturing(
      JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] })
    );
    const req: ChatRequest = {
      model: { provider: "openai", model: "gpt-x" },
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "search_vault", input: {} }] },
        { role: "tool", toolCallId: "t1", content: "r" },
      ],
    };
    await openaiAdapter.send(req, ctx(cap.fetch));
    const m = cap.body().messages as Record<string, unknown>[];
    expect((m[1] as { content: unknown }).content).toBeNull();
  });
});
