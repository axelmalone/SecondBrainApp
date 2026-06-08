import { GatewayError } from "../errors.js";
import type {
  ChatRequest,
  ChatResponse,
  ProviderAdapter,
  ProviderContext,
  ToolCall,
} from "../types.js";
import { parseJson, postJson } from "./http.js";

const ENDPOINT = "https://api.openai.com/v1/chat/completions";

interface OpenAIToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}
interface OpenAIChoice {
  message?: { content?: string | null; tool_calls?: OpenAIToolCall[] };
  finish_reason?: string;
}
interface OpenAIResponse {
  choices?: OpenAIChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { code?: string; type?: string };
}

function classifyError(status: number, body: string): GatewayError {
  if (status === 401) return new GatewayError("AuthFailed", { status });
  if (status === 429) {
    // OpenAI distinguishes billing exhaustion via the insufficient_quota code.
    const lowered = body.toLowerCase();
    if (lowered.includes("insufficient_quota")) {
      return new GatewayError("QuotaExceeded", { status });
    }
    return new GatewayError("RateLimited", { status });
  }
  if (status >= 500) return new GatewayError("Timeout", { status });
  return new GatewayError("BadResponse", { status });
}

export const openaiAdapter: ProviderAdapter = {
  id: "openai",

  async send(req: ChatRequest, ctx: ProviderContext): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: req.model.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }

    const res = await postJson(
      ctx,
      ENDPOINT,
      { authorization: `Bearer ${ctx.apiKey}` },
      body
    );

    if (!res.ok) throw classifyError(res.status, res.text);

    const json = parseJson(res.text) as OpenAIResponse;
    const choice = json.choices?.[0];

    if (!choice) throw new GatewayError("BadResponse", { status: res.status });

    if (choice.finish_reason === "content_filter") {
      throw new GatewayError("Refusal", { status: res.status });
    }

    // tool_calls carry the structured proposal; content is null on a pure call.
    const rawCalls = choice.message?.tool_calls ?? [];
    const toolCalls: ToolCall[] = rawCalls
      .filter((c) => typeof c.function?.name === "string")
      .map((c) => {
        // arguments is a JSON STRING; parse it. On failure, pass the raw string
        // through so validateProposalDraft rejects it → MalformedProposal → re-ask.
        let input: unknown = c.function?.arguments;
        try {
          input = JSON.parse(c.function?.arguments ?? "");
        } catch {
          /* leave input as the raw string */
        }
        const call: ToolCall = { name: c.function?.name as string, input };
        if (typeof c.id === "string") call.id = c.id;
        return call;
      });

    const content = choice.message?.content;
    // Content may legitimately be null/absent when the model only emits a tool
    // call. Only treat it as malformed when there is NEITHER text NOR a call.
    if (typeof content !== "string" && toolCalls.length === 0) {
      throw new GatewayError("BadResponse", { status: res.status });
    }
    const text = typeof content === "string" ? content : "";

    const response: ChatResponse = {
      provider: "openai",
      model: req.model.model,
      text,
    };
    if (toolCalls.length > 0) response.toolCalls = toolCalls;
    if (json.usage) {
      response.usage = {
        inputTokens: json.usage.prompt_tokens ?? 0,
        outputTokens: json.usage.completion_tokens ?? 0,
      };
    }
    return response;
  },
};
