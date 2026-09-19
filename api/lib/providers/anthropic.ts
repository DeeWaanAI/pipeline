import type { ChatMessage, ChatOptions, ChatResponse, LLMProviderAdapter, ContentPart } from "./base";

interface ProviderConfig {
  name: string;
  slug: string;
  defaultBaseUrl: string;
  supportedModels: string[];
}

/**
 * Anthropic Messages API adapter.
 * Uses /v1/messages endpoint (NOT /chat/completions which is OpenAI's format).
 */
export function createAnthropicAdapter(
  apiKey: string,
  baseUrl: string,
  defaultModel: string,
  config?: ProviderConfig,
): LLMProviderAdapter {
  const providerName = config?.name ?? "Anthropic";
  const providerSlug = config?.slug ?? "anthropic";
  const defaultBaseUrl = config?.defaultBaseUrl ?? "https://api.anthropic.com/v1";
  const supportedModels = config?.supportedModels ?? [
    "claude-3-5-sonnet-20241022",
    "claude-3-opus-20240229",
    "claude-3-haiku-20240307",
  ];

  /**
   * Convert our standard ChatMessage content (string | ContentPart[])
   * to Anthropic's content format (string | ContentBlock[]).
   */
  function toAnthropicContent(content: string | ContentPart[]): string | Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }> {
    if (typeof content === "string") return content;

    return content.map((part) => {
      if (part.type === "text") {
        return { type: "text" as const, text: part.text ?? "" };
      }
      if (part.type === "image_url" && part.image_url?.url.startsWith("data:")) {
        // Parse data URL: data:image/jpeg;base64,/9j/4AAQ...
        const match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          return {
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: match[1],
              data: match[2],
            },
          };
        }
      }
      // Fallback: text representation
      return { type: "text" as const, text: `[Image: ${part.image_url?.url ?? "unknown"}]` };
    });
  }

  return {
    name: providerName,
    slug: providerSlug,
    defaultBaseUrl,
    supportedModels,

    async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
      const startTime = Date.now();

      // Anthropic requires system prompt as a separate top-level parameter
      // Extract system messages and pass the rest as conversation
      let systemPrompt = options?.systemPrompt ?? "";
      const conversationMessages: ChatMessage[] = [];

      for (const msg of messages) {
        if (msg.role === "system") {
          const text = typeof msg.content === "string" ? msg.content : (msg.content as ContentPart[]).filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
          systemPrompt = systemPrompt ? `${systemPrompt}\n\n${text}` : text;
        } else {
          conversationMessages.push(msg);
        }
      }

      // Build request body
      const requestBody: Record<string, unknown> = {
        model: options?.model ?? defaultModel,
        max_tokens: options?.maxTokens ?? 4096, // Anthropic requires max_tokens
        messages: conversationMessages.map((msg) => ({
          role: msg.role,
          content: toAnthropicContent(msg.content),
        })),
      };

      if (systemPrompt) {
        requestBody.system = systemPrompt;
      }
      if (options?.temperature !== undefined) requestBody.temperature = options.temperature;
      if (options?.topP !== undefined) requestBody.top_p = options.topP;

      const response = await fetch(`${baseUrl}/messages`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(errorText); } catch { /* ignore */ }

        const errorMessage = (parsed.error as Record<string, unknown>)?.message as string
          ?? (parsed.message as string)
          ?? errorText;

        if (response.status === 401) {
          throw new Error(`Anthropic: Invalid API key. Check your key at https://console.anthropic.com/settings/keys.`);
        }
        if (response.status === 429) {
          throw new Error(`Anthropic: Rate limit exceeded. Please wait a moment and try again.`);
        }
        throw new Error(`Anthropic API error (${response.status}): ${errorMessage}`);
      }

      const data = (await response.json()) as {
        content: Array<{ type: string; text?: string }>;
        model: string;
        usage?: { input_tokens: number; output_tokens: number };
        stop_reason?: string;
      };
      const latencyMs = Date.now() - startTime;

      // Anthropic returns content as an array of blocks
      const textContent = data.content
        ?.filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("") ?? "";

      return {
        content: textContent,
        usage: {
          promptTokens: data.usage?.input_tokens ?? 0,
          completionTokens: data.usage?.output_tokens ?? 0,
          totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
        },
        model: data.model ?? (options?.model ?? defaultModel),
        latencyMs,
      };
    },

    async validateKey(): Promise<{ valid: boolean; error?: string }> {
      try {
        // Anthropic doesn't have a /models endpoint for key validation
        // Use a minimal messages call instead
        const response = await fetch(`${baseUrl}/messages`, {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-3-haiku-20240307",
            max_tokens: 1,
            messages: [{ role: "user", content: "Hi" }],
          }),
        });

        // 200 or even some 4xx errors mean the key is valid
        if (response.status === 401) {
          return { valid: false, error: "Anthropic: Invalid API key" };
        }
        return { valid: true };
      } catch (e) {
        return { valid: false, error: `Anthropic: ${(e as Error).message}` };
      }
    },

    async listModels(): Promise<string[]> {
      // Anthropic doesn't have a public /models endpoint
      // Return the known models list
      return supportedModels;
    },
  };
}
