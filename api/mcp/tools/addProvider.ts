// MCP tool: add_provider — add an LLM provider from the desktop chat without
// opening the web app. Validates the slug against known providers, encrypts
// the key using the same scheme as the web Settings page, and inserts a row
// into llm_providers. On success, the user can immediately run or design
// pipelines with it.

import { z } from "zod";
import { eq } from "drizzle-orm";
import type { McpTool, McpAuthContext } from "../types";
import { getDb } from "../../queries/connection";
import { llmProviders } from "@db/schema";
import { getProviderDefaults } from "../../lib/providers";
import { encrypt, getMasterKey } from "../../services/cryptoService";

const inputSchema = z.object({
  slug: z.string().trim().min(1).max(100).describe("Provider slug — e.g. gemini, deepseek, openai, together, aliyun, mistral. Call suggest_llm_providers to see the full list with signup links."),
  apiKey: z.string().trim().min(1).max(2000).describe("Your API key for the provider (never shown back to you)."),
  defaultModel: z.string().trim().max(100).optional().describe("Model to use by default (e.g. gemini-2.0-flash). Falls back to the provider's first known model."),
  baseUrl: z.string().url().max(512).optional().describe("Override the default base URL (rarely needed — e.g. for Ollama local: http://localhost:11434/v1)."),
});

function encryptApiKey(key: string): string {
  const masterKey = getMasterKey();
  return encrypt(key, masterKey).encrypted;
}

export const addProvider: McpTool = {
  name: "add_provider",
  description:
    "Add a new LLM provider to your account so you can design and run pipelines. Provide the provider slug and API key; the rest is auto-filled from known defaults. Call suggest_llm_providers first if you need a free/cheap option or signup link.",
  inputSchema,
  requiredScopes: ["mcp:write"],
  annotations: { readOnlyHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = inputSchema.parse(args);

    const defaults = getProviderDefaults(input.slug);
    if (!defaults) {
      throw new Error(
        `Unknown provider slug "${input.slug}". Call suggest_llm_providers for the supported list.`,
      );
    }

    const db = getDb();

    // Prevent duplicates (same slug for this user) — upsert semantics would
    // leak whether we overwrite, so we just block and ask them to update
    // via the web app if needed.
    const [existing] = await db
      .select({ id: llmProviders.id })
      .from(llmProviders)
      .where(eq(llmProviders.userId, ctx.userId))
      .limit(50);
    if (existing) {
      const dup = await db
        .select({ id: llmProviders.id })
        .from(llmProviders)
        .where(eq(llmProviders.userId, ctx.userId))
        .limit(50);
      // Check for slug match
      const all = await db
        .select({ id: llmProviders.id, slug: llmProviders.slug })
        .from(llmProviders)
        .where(eq(llmProviders.userId, ctx.userId));
      if (all.some((p) => p.slug === input.slug)) {
        throw new Error(
          `You already have a "${input.slug}" provider configured. Remove it in Settings or use a different slug.`,
        );
      }
    }

    const model = input.defaultModel?.trim() || defaults.models[0];
    const baseUrl = input.baseUrl?.trim() || defaults.baseUrl;
    const encryptedKey = encryptApiKey(input.apiKey);

    const [result] = await db.insert(llmProviders).values({
      userId: ctx.userId,
      name: defaults.name,
      slug: input.slug,
      baseUrl,
      apiKeyRef: encryptedKey,
      defaultModel: model,
      models: defaults.models,
      config: {},
      isEnabled: true,
    });

    const providerId = Number(result.insertId);

    return {
      id: providerId,
      name: defaults.name,
      slug: input.slug,
      defaultModel: model,
      baseUrl,
      models: defaults.models,
      next: `Provider added. You can now run get_settings to confirm, or design_pipeline / run_pipeline to use it.`,
    };
  },
};
