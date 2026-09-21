import type { ChatMessage, ChatOptions, ChatResponse, LLMProviderAdapter, ModelRates } from "./base";

interface ProviderConfig {
  name: string;
  slug: string;
  defaultBaseUrl: string;
  supportedModels: string[];
}

/**
 * Parse provider-specific errors to give actionable messages.
 */
function formatProviderError(providerName: string, status: number, errorBody: string, retryAfter?: string): string {
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(errorBody); } catch { /* ignore */ }

  const errorMessage = (parsed.error as Record<string, unknown>)?.message as string
    ?? (parsed.message as string)
    ?? errorBody;

  const errorCode = (parsed.error as Record<string, unknown>)?.code as string
    ?? (parsed.code as string)
    ?? "";

  // Aliyun DashScope specific errors
  if (providerName === "Aliyun" || errorCode === "invalid_parameter_error") {
    if (errorMessage.includes("not activated") || errorCode === "invalid_parameter_error") {
      // Include the raw upstream message — "invalid_parameter_error" covers
      // far more than activation, and the masked text hides the real cause.
      return `${providerName}: DashScope invalid_parameter_error: ${String(errorMessage).slice(0, 300)}`;
    }
    if (status === 401) {
      return `${providerName}: Invalid API key. Check your key at https://dashscope.console.aliyun.com/api-key.`;
    }
  }

  // DeepSeek specific
  if (providerName === "DeepSeek") {
    if (status === 401) return `${providerName}: Invalid API key. Get one at https://platform.deepseek.com/api_keys.`;
    if (status === 429) return `${providerName}: Rate limit exceeded. Please wait a moment and try again.${retryAfter ? ` [retry-after:${retryAfter}]` : ""}`;
  }

  // Kimi specific
  if (providerName === "Moonshot Kimi") {
    if (status === 401) return `${providerName}: Invalid API key. Get one at https://platform.moonshot.cn/console/api-keys.`;
    if (errorMessage.includes("balance")) return `${providerName}: Account balance insufficient. Add credits at https://platform.moonshot.cn/console.`;
  }

  // OpenAI specific
  if (providerName === "OpenAI") {
    if (status === 401) return `${providerName}: Invalid API key. Check your key at https://platform.openai.com/api-keys.`;
    if (status === 429) return `${providerName}: Rate limit exceeded or insufficient credits.${retryAfter ? ` [retry-after:${retryAfter}]` : ""}`;
    if (errorMessage.includes("model") && errorMessage.includes("not found")) {
      return `${providerName}: Model not found. Check available models at https://platform.openai.com/docs/models.`;
    }
  }

  // Gemini (Google AI) specific
  if (providerName === "Google Gemini") {
    if (status === 401 || status === 403) return `${providerName}: Invalid API key. Get one at https://aistudio.google.com/apikey.`;
    if (status === 429) return `${providerName}: Rate limit exceeded. Try a different model or wait.${retryAfter ? ` [retry-after:${retryAfter}]` : ""}`;
  }

  // Mistral specific
  if (providerName === "Mistral AI") {
    if (status === 401) return `${providerName}: Invalid API key. Get one at https://console.mistral.ai/api-keys.`;
    if (status === 429) return `${providerName}: Rate limit exceeded. Check your plan at https://console.mistral.ai.${retryAfter ? ` [retry-after:${retryAfter}]` : ""}`;
  }

  // MiniMax specific
  if (providerName === "MiniMax") {
    if (status === 401) return `${providerName}: Invalid API key. Get one at https://platform.minimax.io/user-center/payment/api-keys.`;
    if (status === 429) return `${providerName}: Rate limit exceeded. Please wait a moment and try again.${retryAfter ? ` [retry-after:${retryAfter}]` : ""}`;
    if (errorMessage.includes("balance") || errorMessage.includes("insufficient")) return `${providerName}: Account balance insufficient. Add credits at https://platform.minimax.io.`;
  }

  // Anthropic specific (for custom endpoints using OpenAI-compat)
  if (providerName === "Anthropic") {
    if (status === 401) return `${providerName}: Invalid API key. Check your key at https://console.anthropic.com/settings/keys.`;
    if (status === 429) return `${providerName}: Rate limit exceeded. Please wait a moment and try again.${retryAfter ? ` [retry-after:${retryAfter}]` : ""}`;
  }

  // Generic: include provider name, status, and the actual error
  let msg = `${providerName} API error (${status}): ${errorMessage}`;
  if (retryAfter) msg += ` [retry-after:${retryAfter}]`;
  return msg;
}

export function createOpenAIAdapter(
  apiKey: string,
  baseUrl: string,
  defaultModel: string,
  config?: ProviderConfig,
): LLMProviderAdapter {
  const providerName = config?.name ?? "OpenAI";
  const providerSlug = config?.slug ?? "openai";
  const defaultBaseUrl = config?.defaultBaseUrl ?? "https://api.openai.com/v1";
  const supportedModels = config?.supportedModels ?? ["gpt-4o", "gpt-4o-mini", "o1-preview", "o1-mini"];
  // Tolerate users pasting a full endpoint URL: strip any trailing slash and
  // a duplicated /chat/completions suffix (the adapter appends it itself).
  const normalizedBaseUrl = baseUrl
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/i, "");

  return {
    name: providerName,
    slug: providerSlug,
    defaultBaseUrl,
    supportedModels,

    async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
      const startTime = Date.now();

      // Convert messages to API format (supports both string content and multimodal arrays)
      const apiMessages = messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));

      const buildRequestBody = (maxTokensParam: "max_tokens" | "max_completion_tokens") => {
        const body: Record<string, unknown> = {
          model: options?.model ?? defaultModel,
          messages: apiMessages,
        };
        if (options?.temperature !== undefined) body.temperature = options.temperature;
        if (options?.maxTokens !== undefined) body[maxTokensParam] = options.maxTokens;
        if (options?.topP !== undefined) body.top_p = options.topP;
        if (options?.extraBody) Object.assign(body, options.extraBody);
        return body;
      };

      const postChat = (body: Record<string, unknown>) =>
        fetch(`${normalizedBaseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          ...(options?.noRedirect ? { redirect: "error" as const } : {}),
        });

      let response = await postChat(buildRequestBody("max_tokens"));

      if (!response.ok) {
        const errorText = await response.text();
        const retryAfter = response.headers.get("retry-after") ?? undefined;
        // Newer OpenAI models (gpt-5.x, o-series) reject max_tokens and require
        // max_completion_tokens instead — retry once with the new parameter name.
        if (
          response.status === 400 &&
          options?.maxTokens !== undefined &&
          errorText.includes("max_completion_tokens")
        ) {
          response = await postChat(buildRequestBody("max_completion_tokens"));
          if (!response.ok) {
            const retryErrorText = await response.text();
            throw new Error(formatProviderError(providerName, response.status, retryErrorText, retryAfter));
          }
        } else {
          throw new Error(formatProviderError(providerName, response.status, errorText, retryAfter));
        }
      }

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
        model: string;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };
      const latencyMs = Date.now() - startTime;

      return {
        content: data.choices[0]?.message?.content ?? "",
        usage: {
          promptTokens: data.usage?.prompt_tokens ?? 0,
          completionTokens: data.usage?.completion_tokens ?? 0,
          totalTokens: data.usage?.total_tokens ?? 0,
        },
        model: data.model ?? (options?.model ?? defaultModel),
        latencyMs,
      };
    },

    async validateKey(): Promise<{ valid: boolean; error?: string }> {
      try {
        const response = await fetch(`${normalizedBaseUrl}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!response.ok) {
          const text = await response.text();
          return { valid: false, error: formatProviderError(providerName, response.status, text) };
        }
        return { valid: true };
      } catch (e) {
        return { valid: false, error: `${providerName}: ${(e as Error).message}` };
      }
    },

    async listModels(): Promise<string[]> {
      try {
        const response = await fetch(`${normalizedBaseUrl}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!response.ok) return supportedModels;
        const data = await response.json() as {
          data: Array<{ id: string }>;
        };
        return data.data?.map((m) => m.id) ?? supportedModels;
      } catch {
        return supportedModels;
      }
    },

    /**
     * Some OpenAI-compatible hosts publish rates on the same endpoint (Together
     * does). Together's `pricing.input`/`pricing.output` are USD per 1M tokens;
     * the app's ledger and quotes work in per-1K, so the conversion happens
     * here once rather than at every call site. A host using a different unit
     * would mis-scale by 1000×, which is why every quote labels the source and
     * prints the numbers it used. A host that returns no `pricing` object
     * yields {} — the caller then falls back and says so, because a missing
     * price is not a free model.
     */
    async listPricing(): Promise<Record<string, ModelRates>> {
      const response = await fetch(`${normalizedBaseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) return {};
      const payload = await response.json() as
        { data?: Array<{ id: string; pricing?: Record<string, unknown> }> }
        | Array<{ id: string; pricing?: Record<string, unknown> }>;
      const entries = Array.isArray(payload) ? payload : payload.data ?? [];
      const out: Record<string, ModelRates> = {};
      for (const entry of entries) {
        const rate = toModelRates(entry.pricing);
        if (entry.id && rate) out[entry.id] = rate;
      }
      return out;
    },
  };
}

/** per-1M-token USD input/output → per-1K, or null when either is absent. */
export function toModelRates(pricing: Record<string, unknown> | undefined): ModelRates | null {
  const input = Number(pricing?.input);
  const output = Number(pricing?.output);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  if (input <= 0 || output <= 0) return null;
  return { in: input / 1000, out: output / 1000 };
}
