// MCP tools: get_settings / set_default_model — account settings from the
// desktop chat, so the user never has to open the web app for basics.
// get_settings shows tier, capabilities, providers (never API keys), and
// the default model; set_default_model writes users.defaultModel (and
// optionally users.defaultProviderId) — the same fields the web Settings
// page edits.

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { McpTool, McpAuthContext } from "../types";
import { getDb } from "../../queries/connection";
import { llmProviders, users } from "@db/schema";
import { resolveCapabilities } from "../../services/entitlements";

async function settingsSnapshot(ctx: McpAuthContext) {
  const db = getDb();
  const { capabilities, tier } = await resolveCapabilities(ctx.userId);
  const [user] = await db
    .select({ defaultModel: users.defaultModel, defaultProviderId: users.defaultProviderId })
    .from(users)
    .where(eq(users.id, ctx.userId))
    .limit(1);
  const providers = await db
    .select({
      id: llmProviders.id,
      name: llmProviders.name,
      slug: llmProviders.slug,
      defaultModel: llmProviders.defaultModel,
      models: llmProviders.models,
      isEnabled: llmProviders.isEnabled,
    })
    .from(llmProviders)
    .where(eq(llmProviders.userId, ctx.userId));

  return {
    tier,
    capabilities,
    defaultModel: user?.defaultModel ?? null,
    defaultProviderId: user?.defaultProviderId ?? null,
    providers,
    desktopLlm: {
      // MCP sampling: can pipeline work run on the connected app's own LLM?
      clientSupportsSampling: ctx.runtime?.samplingSupported?.() ?? null,
      note: ctx.runtime?.samplingSupported?.()
        ? "Your connected app supports MCP sampling — design can run on its LLM without an API key."
        : "Your connected app does not support MCP sampling — pipeline design/runs use a provider API key from Settings.",
    },
  };
}

export const getSettings: McpTool = {
  name: "get_settings",
  description:
    "Show your DeeWaanAI settings: plan/tier, what you can do, configured LLM providers (keys never shown), default model, and whether your desktop app can run steps on its own LLM.",
  inputSchema: z.object({}),
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true },
  handler: async (_args: unknown, ctx: McpAuthContext) => settingsSnapshot(ctx),
};

const setModelSchema = z.object({
  model: z.string().trim().min(1).max(100)
    .describe("Model name, e.g. gemini-2.0-flash, gpt-4o-mini, deepseek-chat"),
  providerId: z.number().int().min(1).optional()
    .describe("Also switch the default provider (must be one of your configured provider ids from get_settings)"),
});

export const setDefaultModel: McpTool = {
  name: "set_default_model",
  description:
    "Set your preferred LLM model (and optionally which of your configured providers to use by default). Applies to new pipeline design and runs.",
  inputSchema: setModelSchema,
  requiredScopes: ["mcp:write"],
  annotations: { readOnlyHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = setModelSchema.parse(args);
    const db = getDb();

    if (input.providerId !== undefined) {
      const [owned] = await db
        .select({ id: llmProviders.id })
        .from(llmProviders)
        .where(and(eq(llmProviders.id, input.providerId), eq(llmProviders.userId, ctx.userId)))
        .limit(1);
      if (!owned) {
        throw new Error(
          `Provider ${input.providerId} is not one of your configured providers. Call get_settings to list your provider ids.`,
        );
      }
    }

    await db.update(users)
      .set({
        defaultModel: input.model,
        ...(input.providerId !== undefined ? { defaultProviderId: input.providerId } : {}),
      })
      .where(eq(users.id, ctx.userId));

    return {
      updated: true,
      ...(await settingsSnapshot(ctx)),
    };
  },
};
