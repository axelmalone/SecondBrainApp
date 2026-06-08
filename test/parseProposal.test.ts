import { describe, it, expect } from "vitest";
import { parseProposal, validateProposalDraft } from "../src/gateway/parseProposal.js";
import { GatewayError } from "../src/gateway/errors.js";
import { PROPOSE_TOOL_NAME } from "../src/shared/proposal.js";
import type { ChatResponse } from "../src/shared/ai.js";

function res(partial: Partial<ChatResponse>): ChatResponse {
  return { provider: "anthropic", model: "m", text: "", ...partial };
}

describe("parseProposal — tool-use path", () => {
  it("normalizes a valid tool call into a ProposalDraft", () => {
    const out = parseProposal(
      res({
        text: "Logged it.",
        toolCalls: [
          {
            name: PROPOSE_TOOL_NAME,
            input: {
              kind: "append",
              targetPath: "Daily/2026-06-08.md",
              content: "- shipped the loop",
              anchor: "## Log",
            },
          },
        ],
      })
    );
    expect(out.text).toBe("Logged it.");
    expect(out.proposal).toEqual({
      kind: "append",
      targetPath: "Daily/2026-06-08.md",
      content: "- shipped the loop",
      anchor: "## Log",
    });
  });

  it("a malformed tool input throws MalformedProposal", () => {
    expect(() =>
      parseProposal(
        res({
          toolCalls: [{ name: PROPOSE_TOOL_NAME, input: { kind: "frobnicate" } }],
        })
      )
    ).toThrow(GatewayError);
    try {
      parseProposal(
        res({ toolCalls: [{ name: PROPOSE_TOOL_NAME, input: { kind: "x" } }] })
      );
    } catch (e) {
      expect((e as GatewayError).variant).toBe("MalformedProposal");
    }
  });

  it("ignores tool calls that are not the propose tool", () => {
    const out = parseProposal(
      res({ text: "hi", toolCalls: [{ name: "other_tool", input: {} }] })
    );
    expect(out.proposal).toBeUndefined();
    expect(out.text).toBe("hi");
  });
});

describe("parseProposal — JSON-in-text fallback path", () => {
  it("extracts and strips a fenced proposal block, keeping the prose", () => {
    const text =
      "Sure, I'll note that.\n\n```proposal\n" +
      JSON.stringify({
        kind: "create",
        targetPath: "Ideas/spline.md",
        content: "# Spline\n\nthoughts",
      }) +
      "\n```\n";
    const out = parseProposal(res({ text }));
    expect(out.proposal?.kind).toBe("create");
    expect(out.proposal?.targetPath).toBe("Ideas/spline.md");
    expect(out.text).toBe("Sure, I'll note that.");
    expect(out.text).not.toContain("proposal");
  });

  it("an unparseable proposal block throws MalformedProposal", () => {
    const out = (): unknown =>
      parseProposal(res({ text: "```proposal\n{not json}\n```" }));
    expect(out).toThrow(GatewayError);
  });
});

describe("parseProposal — no proposal is the normal case", () => {
  it("plain text with no tool call and no block yields no proposal", () => {
    const out = parseProposal(res({ text: "The capital of France is Paris." }));
    expect(out.proposal).toBeUndefined();
    expect(out.text).toBe("The capital of France is Paris.");
  });
});

describe("validateProposalDraft — schema rules", () => {
  const base = { kind: "create", targetPath: "a.md", content: "x" };
  it("accepts a minimal valid create", () => {
    expect(validateProposalDraft(base).kind).toBe("create");
  });
  it("rejects a non-.md path", () => {
    expect(() => validateProposalDraft({ ...base, targetPath: "a.txt" })).toThrow();
  });
  it("rejects a path with control characters", () => {
    expect(() =>
      validateProposalDraft({ ...base, targetPath: "a\nb.md" })
    ).toThrow();
  });
  it("rejects empty content for create/append but allows it for update", () => {
    expect(() => validateProposalDraft({ ...base, content: "  " })).toThrow();
    expect(
      validateProposalDraft({ kind: "update", targetPath: "a.md", content: "" })
        .content
    ).toBe("");
  });
  it("drops an anchor on non-append kinds", () => {
    const d = validateProposalDraft({ ...base, anchor: "## H" });
    expect(d.anchor).toBeUndefined();
  });
});
