import { describe, it, expect } from "vitest";
import { runAgenticTurn } from "../src/gateway/agenticTurn.js";
import type { ToolContext, ToolSearchHit } from "../src/gateway/tools/registry.js";
import type { ChatRequest, ChatResponse } from "../src/shared/ai.js";

/** A gateway that replays scripted responses and records what it was called with. */
class ScriptedGateway {
  calls = 0;
  toolNamesPerCall: string[][] = [];
  signalsSeen: (AbortSignal | undefined)[] = [];
  constructor(private readonly responses: ChatResponse[]) {}
  async call(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    this.toolNamesPerCall.push((req.tools ?? []).map((t) => t.name));
    this.signalsSeen.push(signal);
    const r = this.responses[this.calls] ?? { provider: "anthropic", model: "x", text: "(end)" };
    this.calls += 1;
    return r;
  }
}

const text = (t: string): ChatResponse => ({ provider: "anthropic", model: "x", text: t });
const withCalls = (...calls: { id: string; name: string; input: unknown }[]): ChatResponse => ({
  provider: "anthropic",
  model: "x",
  text: "",
  toolCalls: calls,
});

/** A recording ToolContext over a tiny in-memory vault. */
function recCtx(files: Record<string, string> = {}): ToolContext & {
  searchCalls: string[];
  readCalls: string[];
} {
  const searchCalls: string[] = [];
  const readCalls: string[] = [];
  return {
    searchCalls,
    readCalls,
    search: (q): ToolSearchHit[] => {
      searchCalls.push(q);
      return Object.entries(files).map(([p, t]) => ({ notePath: p, text: t }));
    },
    resolvePath: (p) => (p.includes("..") || !p.endsWith(".md") ? null : `/vault/${p}`),
    readFile: async (abs) => {
      readCalls.push(abs);
      return files[abs.replace("/vault/", "")] ?? "body";
    },
  };
}

const baseReq: ChatRequest = {
  model: { provider: "anthropic", model: "x" },
  messages: [{ role: "user", content: "what did I decide?" }],
};

describe("runAgenticTurn", () => {
  it("loops search → read → answer (multi-round)", async () => {
    const gw = new ScriptedGateway([
      withCalls({ id: "1", name: "search_vault", input: { query: "decide" } }),
      withCalls({ id: "2", name: "read_note", input: { path: "a.md" } }),
      text("You decided X."),
    ]);
    const ctx = recCtx({ "a.md": "decision body" });
    const res = await runAgenticTurn(gw, baseReq, ctx);

    expect(res.parsed.text).toBe("You decided X.");
    expect(gw.calls).toBe(3);
    expect(ctx.searchCalls).toEqual(["decide"]);
    expect(ctx.readCalls).toEqual(["/vault/a.md"]);
    // Every turn offered the read tools + propose tool.
    expect(gw.toolNamesPerCall[0]).toEqual(
      expect.arrayContaining(["search_vault", "read_note", "propose_note_edit"])
    );
  });

  it("executes ALL parallel tool calls in one turn before continuing", async () => {
    const gw = new ScriptedGateway([
      withCalls(
        { id: "1", name: "search_vault", input: { query: "a" } },
        { id: "2", name: "search_vault", input: { query: "b" } }
      ),
      text("done"),
    ]);
    const ctx = recCtx();
    const res = await runAgenticTurn(gw, baseReq, ctx);
    expect(ctx.searchCalls).toEqual(["a", "b"]); // both ran
    expect(res.parsed.text).toBe("done");
  });

  it("caps the loop and forces a final answer with NO tools", async () => {
    // 6 tool-call responses (never text), then the forced final answer.
    const spin = withCalls({ id: "x", name: "search_vault", input: { query: "loop" } });
    const gw = new ScriptedGateway([spin, spin, spin, spin, spin, text("forced answer")]);
    const ctx = recCtx();
    const res = await runAgenticTurn(gw, baseReq, ctx);

    expect(gw.calls).toBe(6); // 5 loop steps + 1 forced final
    expect(res.parsed.text).toBe("forced answer");
    expect(gw.toolNamesPerCall[5]).toEqual([]); // final call offered NO tools
  });

  it("repeat-guard: an identical call is not re-executed", async () => {
    const same = { id: "1", name: "search_vault", input: { query: "x" } };
    const gw = new ScriptedGateway([withCalls(same), withCalls({ ...same, id: "2" }), text("ok")]);
    const ctx = recCtx();
    await runAgenticTurn(gw, baseReq, ctx);
    expect(ctx.searchCalls).toEqual(["x"]); // ran ONCE despite two identical calls
  });

  it("a tool error is fed back as a result, never thrown into the loop", async () => {
    const gw = new ScriptedGateway([
      withCalls({ id: "1", name: "read_note", input: { path: "../escape" } }), // resolvePath → null → throws
      text("recovered"),
    ]);
    const ctx = recCtx();
    const res = await runAgenticTurn(gw, baseReq, ctx); // must NOT reject
    expect(res.parsed.text).toBe("recovered");
  });

  it("threads the caller AbortSignal through every gateway.call", async () => {
    const ac = new AbortController();
    const gw = new ScriptedGateway([
      withCalls({ id: "1", name: "search_vault", input: { query: "q" } }),
      text("done"),
    ]);
    await runAgenticTurn(gw, baseReq, recCtx(), ac.signal);
    expect(gw.signalsSeen).toEqual([ac.signal, ac.signal]);
  });
});
