// MCP tools: get_settings / set_default_model — account settings from the
// desktop chat, so the user never has to open the web app for basics.
// get_settings shows what you own (purchased pipelines / granted
// entitlements), providers (never API keys), and the default model;
// set_default_model saves an owned, enabled model/provider route atomically,
// optionally updating that provider's default model too.
//
// There is no plan ladder: nothing here is an upsell, and a refusal to save a
// model always names the missing provider route and how to add one.

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { McpTool, McpAuthContext } from "../types";
import { getDb } from "../../queries/connection";
import { llmProviders, users } from "@db/schema";
import { resolveCapabilities } from "../../services/entitlements";
import { lockForUpdate } from "../../queries/connection";

async function settingsSnapshot(ctx: McpAuthContext) {
  const db = getDb();
  const { capabilities } = await resolveCapabilities(ctx.userId);
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

  // Resolve only against this account's rows, never a global/system provider.
  const selected = providers.find((provider) => provider.id === user?.defaultProviderId);
  const enabled = selected?.isEnabled === true;
  const accountModel = user?.defaultModel?.trim() || null;
  const providerModel = selected?.defaultModel?.trim() || null;
  const model = enabled ? accountModel ?? providerModel : null;
  const source = model ? (accountModel ? "account" : "provider") : "unset";
  const warnings: string[] = [];
  const nextSteps: string[] = [];
  if (!selected || !enabled) {
    warnings.push(!selected
      ? "No owned default provider is selected; no default route can be resolved."
      : "The selected default provider is disabled; no default route can be resolved.");
    nextSteps.push("Call get_settings to find an enabled provider you own, then call set_default_model with its providerId and your chosen model. If none exists, configure or enable your own provider first.");
  } else if (!model) {
    warnings.push("Neither the account nor its selected provider has a default model.");
    nextSteps.push("Call set_default_model with your chosen model and the selected providerId.");
  }
  if (enabled && accountModel && accountModel !== providerModel) {
    warnings.push("The account model differs from the selected provider's default; operations reading the provider default may use that model instead.");
    nextSteps.push("To align both defaults, call set_default_model with the same model and providerId and explicitly set setProviderDefault: true.");
  }
  warnings.push("Model access is not verified until a provider call. Saving settings makes no LLM request, and catalog listings do not prove access for your API key.");
  nextSteps.push("On your next intended provider call, if access is denied, confirm that this provider's key has access to the exact model, then explicitly choose an accessible model/provider pair. No model is silently substituted and no provider organization privacy settings are changed.");

  return {
    // What this account owns: unexpired entitlement rows (purchased
    // marketplace pipelines, manual grants). Not a plan — there is none.
    capabilities,
    defaultModel: user?.defaultModel ?? null,
    defaultProviderId: selected?.id ?? null,
    resolvedDefault: { model, providerId: enabled ? selected.id : null, source },
    modelAccessVerified: false,
    warnings,
    nextSteps,
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
    "Show your DeeWaanAI settings: what you own (purchased pipelines and other entitlements), owned providers (keys never shown), resolved default model and its account/provider/unset source, access warnings and next steps, and desktop sampling support.",
  inputSchema: z.object({}),
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true },
  handler: async (_args: unknown, ctx: McpAuthContext) => settingsSnapshot(ctx),
};

const setModelSchema = z.object({
  model: z.string().trim().min(1).max(100)
    .describe("Model name, e.g. gemini-2.0-flash, gpt-4o-mini, deepseek-chat"),
  providerId: z.number().int().min(1).optional()
    .describe("An enabled provider you own from get_settings; omitted means your currently selected provider, never an automatic choice"),
  setProviderDefault: z.boolean().optional()
    .describe("Explicitly set true to also update only the chosen provider's default model for operations that read provider defaults; otherwise leave it unchanged"),
});

export const setDefaultModel: McpTool = {
  name: "set_default_model",
  description:
    "Save an exact model and owned, enabled default provider together. Optionally setProviderDefault also updates that provider's default. No test LLM call or silent substitution; model access is not verified until a provider call.",
  inputSchema: setModelSchema,
  requiredScopes: ["mcp:write"],
  annotations: { readOnlyHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = setModelSchema.parse(args);
    const db = getDb();

    await db.transaction(async (tx) => {
      const [user] = await lockForUpdate(tx
        .select({ defaultProviderId: users.defaultProviderId })
        .from(users)
        .where(eq(users.id, ctx.userId))
        .limit(1));
      if (!user) throw new Error("Account not found. Reconnect before updating settings.");
      const providerId = input.providerId ?? user.defaultProviderId;
      // Every refusal below is a plain statement about the account's own
      // provider routes. Nothing here is a plan pitch: with BYOK the only
      // reason a model cannot be saved is that no enabled provider of yours
      // serves it, and the fix is add_provider.
      if (providerId == null) {
        throw new Error(`You have no enabled provider serving "${input.model}" — add one with add_provider, or call get_settings and supply an explicit providerId for a provider you own. Nothing is guessed.`);
      }
      const [owned] = await lockForUpdate(tx
        .select({ id: llmProviders.id, isEnabled: llmProviders.isEnabled })
        .from(llmProviders)
        .where(and(eq(llmProviders.id, providerId), eq(llmProviders.userId, ctx.userId)))
        .limit(1));
      if (!owned) {
        throw new Error(`The supplied or selected provider is not one of your configured providers, so nothing serves "${input.model}" yet. Call get_settings and choose an enabled providerId you own, or add one with add_provider.`);
      }
      if (owned.isEnabled !== true) {
        throw new Error(`The supplied or selected provider is disabled, so you have no enabled provider serving "${input.model}" yet. Enable it in Settings, choose another enabled providerId you own, or add one with add_provider.`);
      }

      await tx.update(users)
        .set({ defaultModel: input.model, defaultProviderId: owned.id })
        .where(eq(users.id, ctx.userId));
      if (input.setProviderDefault === true) {
        await tx.update(llmProviders)
          .set({ defaultModel: input.model })
          .where(and(
            eq(llmProviders.id, owned.id),
            eq(llmProviders.userId, ctx.userId),
            eq(llmProviders.isEnabled, true),
          ));
      }
    });

    return {
      updated: true,
      ...(await settingsSnapshot(ctx)),
    };
  },
};
