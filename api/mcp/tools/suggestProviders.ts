// MCP tool: suggest_llm_providers — curated guide to free, cheap, and local
// LLM providers so a user can pick one and add it without leaving the chat.
// Static data (no web search) — kept current manually; the MCP description
// tells the client to treat this as a starting point, not a live price feed.

import { z } from "zod";
import type { McpTool, McpAuthContext } from "../types";

const inputSchema = z.object({});

export interface ProviderSuggestion {
  slug: string;
  name: string;
  category: "Free tier" | "Very cheap" | "Local / zero cost";
  signupUrl: string;
  freeTier: string;
  suggestedModel: string;
  estimatedCost?: string; // per 1M tokens, rough
  setupNote: string;
}

const SUGGESTIONS: ProviderSuggestion[] = [
  {
    slug: "gemini",
    name: "Google Gemini",
    category: "Free tier",
    signupUrl: "https://aistudio.google.com/app/apikey",
    freeTier: "Generous free tier via AI Studio (subject to Google's rate limits, no credit card required).",
    suggestedModel: "gemini-2.0-flash",
    estimatedCost: "$0 (free tier)",
    setupNote: "Create an API key in Google AI Studio, paste it here with slug 'gemini'.",
  },
  {
    slug: "deepseek",
    name: "DeepSeek",
    category: "Very cheap",
    signupUrl: "https://platform.deepseek.com/api_keys",
    freeTier: "Small free credit on signup; pay-as-you-go after that. Very low per-token prices.",
    suggestedModel: "deepseek-chat",
    estimatedCost: "~$0.14 / 1M input tokens",
    setupNote: "Get an API key from the DeepSeek platform. Use slug 'deepseek'.",
  },
  {
    slug: "openai",
    name: "OpenAI",
    category: "Very cheap",
    signupUrl: "https://platform.openai.com/api-keys",
    freeTier: "No free tier for new accounts; pay-as-you-go with $5 minimum. gpt-4o-mini is the cheapest model.",
    suggestedModel: "gpt-4o-mini",
    estimatedCost: "~$0.15 / 1M input tokens (4o-mini)",
    setupNote: "OpenAI is the most compatible option. Use slug 'openai' and a gpt-4o-mini key for lowest cost.",
  },
  {
    slug: "together",
    name: "Together.ai",
    category: "Free tier",
    signupUrl: "https://api.together.xyz/signup",
    freeTier: "Free credits for new accounts; good for open-source models like Llama and Qwen.",
    suggestedModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    estimatedCost: "Free credits + pay-as-you-go",
    setupNote: "Together runs open-source models. Use slug 'together' and pick a Llama or Qwen model.",
  },
  {
    slug: "aliyun",
    name: "Aliyun (Qwen / DashScope)",
    category: "Free tier",
    signupUrl: "https://dashscope.console.aliyun.com/apiKey",
    freeTier: "Free tier for Qwen and DeepSeek models via DashScope (Chinese-friendly, generous limits).",
    suggestedModel: "qwen-turbo",
    estimatedCost: "$0 (free tier)",
    setupNote: "Sign up for DashScope, get an API key, use slug 'aliyun'. Good for qwen and deepseek-r1.",
  },
  {
    slug: "mistral",
    name: "Mistral AI",
    category: "Very cheap",
    signupUrl: "https://console.mistral.ai/api-keys",
    freeTier: "Free tier available for new accounts; also very cheap paid tier.",
    suggestedModel: "mistral-small-latest",
    estimatedCost: "Free tier + low pay-as-you-go",
    setupNote: "Mistral has strong European models. Use slug 'mistral' and mistral-small-latest for lowest cost.",
  },
  {
    slug: "openai",
    name: "Ollama (local)",
    category: "Local / zero cost",
    signupUrl: "https://ollama.com/download",
    freeTier: "100% free — runs on your own machine. No internet required after download.",
    suggestedModel: "llama3.1:8b",
    estimatedCost: "$0 (your own hardware)",
    setupNote: "Install Ollama, run 'ollama serve', then add provider with slug 'openai', baseUrl 'http://localhost:11434/v1', and any dummy API key. Only works if the app can reach your machine (not for Railway-hosted setups).",
  },
];

export const suggestLlmProviders: McpTool = {
  name: "suggest_llm_providers",
  description:
    "Show a curated list of free, cheap, and local LLM providers you can use with DeeWaanAI. No web search — each entry includes a signup link, suggested model, free-tier details, and setup instructions. Start here if you don't have an API key yet.",
  inputSchema,
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true },
  handler: async (_args: unknown, _ctx: McpAuthContext) => {
    const groups: Record<string, ProviderSuggestion[]> = {};
    for (const s of SUGGESTIONS) {
      (groups[s.category] ||= []).push(s);
    }
    return {
      count: SUGGESTIONS.length,
      categories: Object.keys(groups),
      providers: SUGGESTIONS,
      quickPick: SUGGESTIONS.filter((s) => s.category === "Free tier").map((s) => s.slug),
    };
  },
};
