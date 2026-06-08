import { GatewayError } from "./errors.js";
import { parseProposal } from "./parseProposal.js";
import {
  PROPOSE_TOOL,
  type ParsedTurn,
} from "../shared/proposal.js";
import type { ChatRequest, ChatResponse } from "../shared/ai.js";

/** The slice of ModelGateway runProposalTurn needs (structural, for test fakes). */
export interface ProposalTurnGateway {
  call(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
}

export interface ProposalTurnResult {
  parsed: ParsedTurn;
  /** The provider response the parsed turn was derived from (for usage/badges). */
  response: ChatResponse;
}

/**
 * Run one chat turn that MAY produce a proposal. Offers the propose tool, calls
 * the gateway, and normalizes the response through parseProposal. If the model
 * attempted a proposal that failed validation, performs exactly ONE bounded
 * re-ask feeding the validation error back; a second failure throws
 * MalformedProposal (the only new variant), which the caller funnels through the
 * existing toSafeError boundary. "No proposal" is a normal success, not a retry.
 */
export async function runProposalTurn(
  gateway: ProposalTurnGateway,
  req: ChatRequest,
  signal?: AbortSignal
): Promise<ProposalTurnResult> {
  const withTool: ChatRequest = {
    ...req,
    tools: [...(req.tools ?? []), PROPOSE_TOOL],
  };

  const first = await gateway.call(withTool, signal);
  try {
    return { parsed: parseProposal(first), response: first };
  } catch (err) {
    if (!(err instanceof GatewayError) || err.variant !== "MalformedProposal") {
      throw err;
    }

    // One bounded re-ask: feed our own validation message back (no secrets) and
    // ask the model to correct the proposal or simply answer without one.
    const retryReq: ChatRequest = {
      ...withTool,
      messages: [
        ...withTool.messages,
        { role: "assistant", content: first.text || "(attempted an edit)" },
        {
          role: "user",
          content:
            `Your proposed edit was invalid: ${err.message}. ` +
            "Re-send a corrected proposal, or just answer without proposing an edit.",
        },
      ],
    };

    const second = await gateway.call(retryReq, signal);
    // A second malformed proposal throws MalformedProposal — propagates out.
    return { parsed: parseProposal(second), response: second };
  }
}
