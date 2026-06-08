import { GatewayError } from "../errors.js";
import type {
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

export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",

  async send(req: ChatRequest, ctx: ProviderContext): Promise<ChatResponse> {
    // Anthropic takes system separately from the message turns.
    const system = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const messages = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

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
