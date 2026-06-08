import { describe, it, expect } from "vitest";
import { anthropicAdapter } from "../src/gateway/providers/anthropic.js";
import { openaiAdapter } from "../src/gateway/providers/openai.js";
import { PROPOSE_TOOL, PROPOSE_TOOL_NAME } from "../src/shared/proposal.js";
import type { ChatRequest } from "../src/shared/ai.js";
import type { FetchLike } from "../src/gateway/types.js";

const req: ChatRequest = {
  model: { provider: "anthropic", model: "m" },
  messages: [{ role: "user", content: "log it" }],
  tools: [PROPOSE_TOOL],
};

/** Capture the outgoing request body, return a fixed response. */
function captureFetch(body: string): { fetch: FetchLike; sent: () => unknown } {
  let captured: unknown;
  const fetch: FetchLike = async (_url, init) => {
    captured = JSON.parse(String(init.body));
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, sent: () => captured };
}

const ctx = (fetch: FetchLike) => ({ apiKey: "k", fetch, signal: new AbortController().signal });

describe("anthropic adapter tool-use", () => {
  it("maps tools into the request and extracts a tool_use block", async () => {
    const cap = captureFetch(
      JSON.stringify({
        content: [
          { type: "text", text: "done" },
          {
            type: "tool_use",
            id: "tu_1",
            name: PROPOSE_TOOL_NAME,
            input: { kind: "append", targetPath: "D.md", content: "- x" },
          },
        ],
        stop_reason: "tool_use",
      })
    );
    const res = await anthropicAdapter.send({ ...req, model: req.model }, ctx(cap.fetch));
    const body = cap.sent() as { tools?: { name: string; input_schema: unknown }[] };
    expect(body.tools?.[0]?.name).toBe(PROPOSE_TOOL_NAME);
    expect(body.tools?.[0]?.input_schema).toBeDefined();
    expect(res.text).toBe("done");
    expect(res.toolCalls?.[0]).toMatchObject({ name: PROPOSE_TOOL_NAME, id: "tu_1" });
  });
});

describe("openai adapter tool-use", () => {
  it("maps tools as functions and parses tool_calls (content null)", async () => {
    const cap = captureFetch(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: PROPOSE_TOOL_NAME,
                    arguments: JSON.stringify({
                      kind: "create",
                      targetPath: "n.md",
                      content: "hi",
                    }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      })
    );
    const res = await openaiAdapter.send(
      { ...req, model: { provider: "openai", model: "gpt" } },
      ctx(cap.fetch)
    );
    const body = cap.sent() as { tools?: { type: string; function: { name: string } }[] };
    expect(body.tools?.[0]?.type).toBe("function");
    expect(body.tools?.[0]?.function.name).toBe(PROPOSE_TOOL_NAME);
    expect(res.text).toBe("");
    expect(res.toolCalls?.[0]).toMatchObject({ name: PROPOSE_TOOL_NAME, id: "call_1" });
    expect((res.toolCalls?.[0]?.input as { kind: string }).kind).toBe("create");
  });
});
