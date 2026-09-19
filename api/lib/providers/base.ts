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
