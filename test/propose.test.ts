import { describe, it, expect } from "vitest";
import { runProposalTurn } from "../src/gateway/propose.js";
import { GatewayError } from "../src/gateway/errors.js";
import { PROPOSE_TOOL_NAME } from "../src/shared/proposal.js";
import type { ChatRequest, ChatResponse } from "../src/shared/ai.js";

const req: ChatRequest = {
  model: { provider: "anthropic", model: "m" },
  messages: [{ role: "user", content: "log that I shipped" }],
};

/** A fake gateway returning scripted responses, recording the requests it saw. */
function scriptedGateway(responses: ChatResponse[]) {
  const seen: ChatRequest[] = [];
  let i = 0;
  return {
    seen,
    call(r: ChatRequest): Promise<ChatResponse> {
      seen.push(r);
      const out = responses[i++];
      if (!out) throw new Error("no scripted response");
      return Promise.resolve(out);
    },
  };
}

function ok(text: string, extra: Partial<ChatResponse> = {}): ChatResponse {
  return { provider: "anthropic", model: "m", text, ...extra };
}

describe("runProposalTurn", () => {
  it("offers the propose tool and returns a parsed proposal on first try", async () => {
    const gw = scriptedGateway([
      ok("done", {
        toolCalls: [
          {
            name: PROPOSE_TOOL_NAME,
            input: { kind: "append", targetPath: "Daily.md", content: "- shipped" },
          },
        ],
      }),
    ]);
    const out = await runProposalTurn(gw, req);
    expect(out.parsed.proposal?.kind).toBe("append");
    // The tool was injected into the request.
    expect(gw.seen[0]?.tools?.some((t) => t.name === PROPOSE_TOOL_NAME)).toBe(true);
    expect(gw.seen).toHaveLength(1);
  });

  it("does one bounded re-ask on a malformed proposal, then succeeds", async () => {
    const gw = scriptedGateway([
      ok("", { toolCalls: [{ name: PROPOSE_TOOL_NAME, input: { kind: "bad" } }] }),
      ok("fixed", {
        toolCalls: [
          {
            name: PROPOSE_TOOL_NAME,
            input: { kind: "create", targetPath: "n.md", content: "hi" },
          },
        ],
      }),
    ]);
    const out = await runProposalTurn(gw, req);
    expect(out.parsed.proposal?.kind).toBe("create");
    expect(gw.seen).toHaveLength(2);
    // The re-ask fed the validation error back as a new user turn.
    const lastMsg = gw.seen[1]?.messages.at(-1);
    expect(lastMsg?.role).toBe("user");
    expect(lastMsg?.content).toContain("invalid");
  });

  it("a second malformed proposal throws MalformedProposal (no apply)", async () => {
    const gw = scriptedGateway([
      ok("", { toolCalls: [{ name: PROPOSE_TOOL_NAME, input: { kind: "bad" } }] }),
      ok("", { toolCalls: [{ name: PROPOSE_TOOL_NAME, input: { kind: "still-bad" } }] }),
    ]);
    await expect(runProposalTurn(gw, req)).rejects.toMatchObject({
      variant: "MalformedProposal",
    });
    expect(gw.seen).toHaveLength(2);
  });

  it("a plain answer (no proposal) does not trigger a re-ask", async () => {
    const gw = scriptedGateway([ok("Paris is the capital of France.")]);
    const out = await runProposalTurn(gw, req);
    expect(out.parsed.proposal).toBeUndefined();
    expect(out.parsed.text).toContain("Paris");
    expect(gw.seen).toHaveLength(1);
  });

  it("propagates non-proposal gateway errors without retry", async () => {
    const gw = {
      calls: 0,
      call(): Promise<ChatResponse> {
        this.calls++;
        return Promise.reject(new GatewayError("RateLimited", { status: 429 }));
      },
    };
    await expect(runProposalTurn(gw, req)).rejects.toMatchObject({
      variant: "RateLimited",
    });
    expect(gw.calls).toBe(1);
  });
});
