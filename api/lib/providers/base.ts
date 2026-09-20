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
  };
  model: string;
  latencyMs: number;
}

export interface LLMProviderAdapter {
  readonly name: string;
  readonly slug: string;
  readonly defaultBaseUrl: string;
  readonly supportedModels: string[];
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
  validateKey(): Promise<{ valid: boolean; error?: string }>;
  listModels(): Promise<string[]>;
}
