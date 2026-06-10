import { parseProposal } from "./parseProposal.js";
import { PROPOSE_TOOL } from "../shared/proposal.js";
import { AGENTIC_TOOLS, AGENTIC_TOOL_SPECS, type ToolContext } from "./tools/registry.js";
import type { ProposalTurnGateway, ProposalTurnResult } from "./propose.js";
import type { ChatMessage, ToolCall } from "../shared/ai.js";

/** Max model round-trips before we force a final answer (4A). */
const MAX_STEPS = 5;

/** The agentic result, plus the note paths the model actually read — the honest
 *  provenance the caller turns into the answer's "grounded in …" badge. */
export interface AgenticTurnResult extends ProposalTurnResult {
  readPaths: string[];
}

/**
 * The AGENTIC retrieval loop (strangler-fig spike). Offers the read tools
 * (search_vault / read_note) plus the propose tool, and lets the model drive:
 *
 *   ┌─ gateway.call(messages, tools) ──────────────────────────────┐
 *   │  read tool calls?  → execute ALL, append results, loop       │
 *   │  text only / propose call (no reads) → DONE → parseProposal  │
 *   └──────────────────────────────────────────────────────────────┘
 *   cap hit → one final call with NO tools → must answer (never empty)
 *
 * Safety (4A): bounded step cap; a repeat-call guard returns a canned result
 * instead of re-running an identical call (no spin); a tool that throws is fed
 * back as an `{error}` result, never thrown into the loop; the caller's
 * AbortSignal threads through every gateway.call. The final turn always runs
 * through parseProposal, so a note-edit proposal still composes (2A).
 */
export async function runAgenticTurn(
  gateway: ProposalTurnGateway,
  baseReq: Parameters<ProposalTurnGateway["call"]>[0],
  toolCtx: ToolContext,
  signal?: AbortSignal
): Promise<AgenticTurnResult> {
  const loopTools = [...(baseReq.tools ?? []), ...AGENTIC_TOOL_SPECS, PROPOSE_TOOL];
  let messages: ChatMessage[] = [...baseReq.messages];
  const seen = new Set<string>();
  const readPaths: string[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const resp = await gateway.call({ ...baseReq, messages, tools: loopTools }, signal);
    const calls = resp.toolCalls ?? [];
    const readCalls = calls.filter((c) => c.name in AGENTIC_TOOLS);

    // Terminal: no READ tool call this turn. Either a plain text answer or a
    // propose_note_edit call — both are handled by parseProposal (write-back
    // composes, 2A).
    if (readCalls.length === 0) {
      return { parsed: parseProposal(resp), response: resp, readPaths };
    }

    // Replay the assistant's tool-use turn, then a tool_result for EVERY tool_use
    // it emitted (Anthropic 400s on a missing result — incl. a propose call that
    // rode along with reads, which we defer).
    messages = [
      ...messages,
      { role: "assistant", content: resp.text, toolCalls: calls },
    ];
    for (const call of calls) {
      const content = await runOneTool(call, toolCtx, seen, readPaths);
      const toolMsg: ChatMessage =
        call.id !== undefined
          ? { role: "tool", toolCallId: call.id, content }
          : { role: "tool", content };
      messages = [...messages, toolMsg];
    }
  }

  // Cap hit: force a final answer with NO read/propose tools so the model must
  // answer from what it has — never an empty turn.
  const baseTools = baseReq.tools ?? [];
  const finalReq = baseTools.length > 0
    ? { ...baseReq, messages, tools: baseTools }
    : { ...baseReq, messages };
  const final = await gateway.call(finalReq, signal);
  return { parsed: parseProposal(final), response: final, readPaths };
}

/** Run one tool call → its tool_result content. Never throws: validation/exec
 *  errors come back as an `{error}` string the model can react to (4A). */
async function runOneTool(
  call: ToolCall,
  ctx: ToolContext,
  seen: Set<string>,
  readPaths: string[]
): Promise<string> {
  const signature = `${call.name}:${JSON.stringify(call.input ?? null)}`;
  if (seen.has(signature)) {
    return `(You already called ${call.name} with these exact arguments. Reuse the earlier result instead of repeating it.)`;
  }
  seen.add(signature);

  const tool = AGENTIC_TOOLS[call.name];
  if (!tool) {
    // A non-read tool (e.g. propose_note_edit) emitted alongside reads. Give it a
    // result so the provider is satisfied, and defer it to the final answer.
    return "(Noted. Finish reading the notes you need, then make any edit proposal in your final answer.)";
  }
  try {
    const result = await tool.run(call.input, ctx);
    // Record a successfully read note for provenance (the answer's badge).
    if (call.name === "read_note") {
      const p = (call.input as { path?: unknown } | null)?.path;
      if (typeof p === "string") readPaths.push(p);
    }
    return result;
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}
