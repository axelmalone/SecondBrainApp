import { GatewayError } from "../errors.js";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ProviderAdapter,
  ProviderContext,
  ToolCall,
} from "../types.js";
import { parseJson, postJson } from "./http.js";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 1024;

interface AnthropicContentBlock {
  type: string;
  text?: string;
  // tool_use blocks:
  id?: string;
  name?: string;
  input?: unknown;
}
interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Map an Anthropic error response (status + body) to a typed GatewayError. */
function classifyError(status: number, body: string): GatewayError {
  if (status === 401) return new GatewayError("AuthFailed", { status });
  if (status === 429) return new GatewayError("RateLimited", { status });
  // Anthropic signals transient overload with 529, and 5xx are retryable.
  if (status === 529 || status >= 500) {
    return new GatewayError("Timeout", { status });
  }
  if (status === 400 || status === 403) {
    // Credit/billing problems arrive as a 400/403 with a billing-ish type.
    const lowered = body.toLowerCase();
    if (lowered.includes("credit") || lowered.includes("billing")) {
      return new GatewayError("QuotaExceeded", { status });
    }
  }
  return new GatewayError("BadResponse", { status });
}

/**
 * Reconstruct Anthropic's message array from our ChatMessage list (6A).
 * - assistant turns with `toolCalls` become `content: [text?, ...tool_use]`.
 * - `role: "tool"` messages have no Anthropic role; they map to `tool_result`
 *   blocks inside a USER turn. CONSECUTIVE tool results collapse into ONE user
 *   turn so a turn that emitted N parallel tool calls gets all N results back in
 *   a single turn (Anthropic 400s on a missing tool_result).
 */
function toAnthropicMessages(
  msgs: ChatMessage[]
): { role: string; content: unknown }[] {
  const out: { role: string; content: unknown }[] = [];
  let pendingResults: unknown[] = [];
  const flush = (): void => {
    if (pendingResults.length > 0) {
      out.push({ role: "user", content: pendingResults });
      pendingResults = [];
    }
  };
  for (const m of msgs) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      pendingResults.push({
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content,
      });
      continue;
    }
    flush();
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const blocks: unknown[] = [];
      if (m.content.length > 0) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
      }
      out.push({ role: "assistant", content: blocks });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  flush();
  return out;
}

export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",

  async send(req: ChatRequest, ctx: ProviderContext): Promise<ChatResponse> {
    // Anthropic takes system separately from the message turns.
    const system = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const messages = toAnthropicMessages(req.messages);

    const body: Record<string, unknown> = {
      model: req.model.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
    };
    if (system.length > 0) body.system = system;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }

    const res = await postJson(
      ctx,
      ENDPOINT,
      { "x-api-key": ctx.apiKey, "anthropic-version": API_VERSION },
      body
    );

    if (!res.ok) throw classifyError(res.status, res.text);

    const json = parseJson(res.text) as AnthropicResponse;

    if (json.stop_reason === "refusal") {
      throw new GatewayError("Refusal", { status: res.status });
    }

    if (!json.content || json.content.length === 0) {
      throw new GatewayError("BadResponse", { status: res.status });
    }

    const text = json.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");

    // tool_use blocks (stop_reason "tool_use") carry the structured proposal.
    const toolCalls: ToolCall[] = json.content
      .filter((b) => b.type === "tool_use" && typeof b.name === "string")
      .map((b) => {
        const call: ToolCall = { name: b.name as string, input: b.input };
        if (typeof b.id === "string") call.id = b.id;
        return call;
      });

    const response: ChatResponse = {
      provider: "anthropic",
      model: req.model.model,
      text,
    };
    if (toolCalls.length > 0) response.toolCalls = toolCalls;
    if (json.usage) {
      response.usage = {
        inputTokens: json.usage.input_tokens ?? 0,
        outputTokens: json.usage.output_tokens ?? 0,
      };
    }
    return response;
  },
};
