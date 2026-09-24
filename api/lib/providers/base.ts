// Multimodal content part for vision-capable models
export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string; detail?: "low" | "high" | "auto" };
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  // string for simple text, ContentPart[] for multimodal (images + text)
  content: string | ContentPart[];
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  systemPrompt?: string;
  /** Provider-specific request-body extensions (e.g. { enable_thinking: false } for Qwen). */
  extraBody?: Record<string, unknown>;
  /**
   * Protected-execution transport policy (spec §8.2): fail instead of following
   * an HTTP redirect, so an approved origin cannot hand the prompt — and the
   * bearer key — to another host. Ordinary runs keep fetch's default behavior.
   */
  noRedirect?: boolean;
}

export interface ChatResponse {
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    complete?: boolean;
  };
  model: string;
  latencyMs: number;
}

export function normalizeTokenUsage(prompt: unknown, completion: unknown, total?: unknown): ChatResponse["usage"] {
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  const promptTokens = valid(prompt) ? prompt : 0;
  const completionTokens = valid(completion) ? completion : 0;
  return {
    promptTokens, completionTokens,
    totalTokens: valid(total) ? total : promptTokens + completionTokens,
    complete: valid(prompt) && valid(completion),
  };
}

export interface ModelRates {
  /** USD per 1,000 tokens — the unit the ledger and quotes use. Provider
   *  endpoints report per-1M; the adapter converts. */
  in: number;
  out: number;
}

export interface LLMProviderAdapter {
  readonly name: string;
  readonly slug: string;
  readonly defaultBaseUrl: string;
  readonly supportedModels: string[];
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
  validateKey(): Promise<{ valid: boolean; error?: string }>;
  listModels(): Promise<string[]>;
  /**
   * Present only where the provider publishes rates on its own models
   * endpoint (Together does; OpenAI and Anthropic do not). These are LIST
   * prices: promotional, committed-use and cached-input discounts are not
   * visible from here, so a quote built on them can over-estimate and must say
   * so rather than claim accuracy.
   */
  listPricing?(): Promise<Record<string, ModelRates>>;
}
