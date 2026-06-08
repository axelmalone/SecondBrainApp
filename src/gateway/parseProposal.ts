import { GatewayError } from "./errors.js";
import type { ChatResponse } from "../shared/ai.js";
import {
  PROPOSE_TOOL_NAME,
  type ParsedTurn,
  type ProposalDraft,
  type ProposalKind,
} from "../shared/proposal.js";

const KINDS: ProposalKind[] = ["create", "append", "update"];

function malformed(message: string): GatewayError {
  return new GatewayError("MalformedProposal", { message });
}

/**
 * Validate a raw proposal object (from a tool call's `input` or a parsed JSON
 * block) into a typed ProposalDraft. The ONE schema validator both extraction
 * paths funnel through (CQ1 hybrid). Throws MalformedProposal with a descriptive
 * message — the message is fed back to the model on the bounded re-ask, then
 * stripped by toSafeError before it ever crosses IPC.
 *
 * Path SECURITY (isInside the vault root) is enforced separately at apply time
 * where the root is known; here we only enforce the syntactic shape (.md, no
 * control chars). Never trust this path for a write without that apply-time check.
 */
export function validateProposalDraft(raw: unknown): ProposalDraft {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw malformed("proposal must be a JSON object");
  }
  const o = raw as Record<string, unknown>;

  if (typeof o.kind !== "string" || !KINDS.includes(o.kind as ProposalKind)) {
    throw malformed(`"kind" must be one of create | append | update`);
  }
  const kind = o.kind as ProposalKind;

  if (typeof o.targetPath !== "string" || o.targetPath.length === 0) {
    throw malformed(`"targetPath" must be a non-empty string`);
  }
  const targetPath = o.targetPath;
  if (!targetPath.toLowerCase().endsWith(".md")) {
    throw malformed(`"targetPath" must end in .md`);
  }
  // Reject control characters / newlines — a path is always a single line.
  for (let i = 0; i < targetPath.length; i++) {
    if (targetPath.charCodeAt(i) < 0x20) {
      throw malformed(`"targetPath" contains illegal control characters`);
    }
  }

  if (typeof o.content !== "string") {
    throw malformed(`"content" must be a string`);
  }
  // Empty content is a degenerate no-op edit; refuse it rather than write blanks.
  if (kind !== "update" && o.content.trim().length === 0) {
    throw malformed(`"content" must be non-empty for a ${kind} proposal`);
  }

  if (o.anchor !== undefined && typeof o.anchor !== "string") {
    throw malformed(`"anchor" must be a string when present`);
  }
  if (o.reason !== undefined && typeof o.reason !== "string") {
    throw malformed(`"reason" must be a string when present`);
  }

  const draft: ProposalDraft = { kind, targetPath, content: o.content };
  // Anchor is only meaningful for append; ignore it elsewhere.
  if (kind === "append" && typeof o.anchor === "string" && o.anchor.length > 0) {
    draft.anchor = o.anchor;
  }
  if (typeof o.reason === "string" && o.reason.length > 0) draft.reason = o.reason;
  return draft;
}

/** Matches a fenced ```proposal … ``` block in the model's text (fallback path). */
const PROPOSAL_FENCE = /```proposal\s*\n([\s\S]*?)\n?```/i;

/**
 * Normalize a provider ChatResponse into a ParsedTurn (CQ1-C). The SINGLE
 * normalizer both paths funnel into:
 *
 *  1. tool-use: if the model emitted a `propose_note_edit` tool call, validate
 *     its input. A malformed tool input → MalformedProposal.
 *  2. JSON-in-text fallback: otherwise, if the text contains a ```proposal
 *     fenced block, parse + validate it and strip it from the displayed text.
 *
 * "No proposal" is the NORMAL Q&A case (CQ2-A) — never an error. Only a proposal
 * that was ATTEMPTED but is invalid raises MalformedProposal.
 */
export function parseProposal(res: ChatResponse): ParsedTurn {
  // 1. Tool-use path.
  const call = res.toolCalls?.find((c) => c.name === PROPOSE_TOOL_NAME);
  if (call) {
    const proposal = validateProposalDraft(call.input);
    return { text: res.text, proposal };
  }

  // 2. JSON-in-text fallback path.
  const match = res.text.match(PROPOSAL_FENCE);
  if (match) {
    let raw: unknown;
    try {
      raw = JSON.parse(match[1] ?? "");
    } catch (err) {
      throw new GatewayError("MalformedProposal", {
        message: "proposal block was not valid JSON",
        cause: err,
      });
    }
    const proposal = validateProposalDraft(raw);
    // Strip the machine block so the user only sees the natural-language answer.
    const text = res.text.replace(PROPOSAL_FENCE, "").trim();
    return { text, proposal };
  }

  // No proposal attempted — plain answer.
  return { text: res.text };
}
