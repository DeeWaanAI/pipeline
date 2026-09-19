import { createOpenAIAdapter } from "./openai";
import { createAnthropicAdapter } from "./anthropic";
import type { LLMProviderAdapter } from "./base";

export function createProviderAdapter(
  slug: string,
  apiKey: string,
  baseUrl: string,
  defaultModel: string
): LLMProviderAdapter {
  const defaults = getProviderDefaults(slug);
  const config = defaults
    ? { name: defaults.name, slug, defaultBaseUrl: defaults.baseUrl, supportedModels: defaults.models }
    : undefined;

  // Route to provider-specific adapter
  if (slug === "anthropic") {
    return createAnthropicAdapter(apiKey, baseUrl, defaultModel, config);
  }

  return createOpenAIAdapter(apiKey, baseUrl, defaultModel, config);
}

export function getProviderDefaults(slug: string): {
  name: string;
  baseUrl: string;
  models: string[];
} | null {
  const defaults: Record<string, { name: string; baseUrl: string; models: string[] }> = {
    openai: {
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      models: ["gpt-4o", "gpt-4o-mini", "o1-preview", "o1-mini"],
    },
    anthropic: {
      name: "Anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      models: ["claude-3-5-sonnet-20241022", "claude-3-opus-20240229", "claude-3-haiku-20240307"],
    },
    deepseek: {
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      models: ["deepseek-chat", "deepseek-reasoner"],
    },
    kimi: {
      name: "Moonshot Kimi",
      baseUrl: "https://api.moonshot.cn/v1",
      models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
    },
    together: {
      name: "Together.ai",
      baseUrl: "https://api.together.xyz/v1",
      models: [
        "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        "Qwen/Qwen2.5-72B-Instruct-Turbo",
        "deepseek-ai/DeepSeek-V3",
      ],
    },
    aliyun: {
      name: "Aliyun (Qwen)",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      models: [
        "qwen-max",
        "qwen-plus",
        "qwen-turbo",
        "qwen-coder-plus",
        "deepseek-r1",
        "deepseek-v3",
      ],
    },
    gemini: {
      name: "Google Gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      models: [
        "gemini-3.1-pro-preview",
        "gemini-3.1-flash-lite",
        "gemini-2.5-pro",
        "gemini-2.5-flash",
      ],
    },
    mistral: {
      name: "Mistral AI",
      baseUrl: "https://api.mistral.ai/v1",
      models: [
        "mistral-large-latest",
        "mistral-medium-latest",
        "mistral-small-latest",
        "codestral-latest",
        "open-mistral-nemo",
      ],
    },
    minimax: {
      name: "MiniMax",
      baseUrl: "https://api.minimax.io/v1",
      models: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-Text-01"],
    },
  };
  return defaults[slug] ?? null;
}

export type { ChatMessage, ChatOptions, ChatResponse, LLMProviderAdapter } from "./base";
