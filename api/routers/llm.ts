import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { declaredModelPrices, llmProviders, users } from "@db/schema";
import { declaredModelPrices as sqliteDeclaredModelPrices } from "@db/schema.sqlite";
import { upsertOnUniqueKey } from "../lib/upsert";
import { eq, and, desc } from "drizzle-orm";
import { createProviderAdapter, getProviderDefaults } from "../lib/providers";
import { encrypt, decrypt, getMasterKey } from "../services/cryptoService";
import { LLMProviderInputSchema } from "@contracts/index";

function encryptApiKey(key: string): string {
  const masterKey = getMasterKey();
  return encrypt(key, masterKey).encrypted;
}

function decryptApiKey(encrypted: string): string {
  const masterKey = getMasterKey();
  return decrypt(encrypted, masterKey);
}

export const llmRouter = createRouter({
  listProviders: authedQuery.query(async ({ ctx }) => {
    return getDb()
      .select({
        id: llmProviders.id,
        name: llmProviders.name,
        slug: llmProviders.slug,
        baseUrl: llmProviders.baseUrl,
        defaultModel: llmProviders.defaultModel,
        models: llmProviders.models,
        config: llmProviders.config,
        isEnabled: llmProviders.isEnabled,
        createdAt: llmProviders.createdAt,
        updatedAt: llmProviders.updatedAt,
      })
      .from(llmProviders)
      .where(eq(llmProviders.userId, ctx.user.id));
  }),

  getProvider: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input, ctx }) => {
      const [provider] = await getDb()
        .select({
          id: llmProviders.id,
          name: llmProviders.name,
          slug: llmProviders.slug,
          baseUrl: llmProviders.baseUrl,
          defaultModel: llmProviders.defaultModel,
          models: llmProviders.models,
          config: llmProviders.config,
          isEnabled: llmProviders.isEnabled,
          createdAt: llmProviders.createdAt,
          updatedAt: llmProviders.updatedAt,
        })
        .from(llmProviders)
        .where(and(eq(llmProviders.id, input.id), eq(llmProviders.userId, ctx.user.id)));
      return provider ?? null;
    }),

  createProvider: authedQuery
    .input(LLMProviderInputSchema)
    .mutation(async ({ input, ctx }) => {
      const encryptedKey = encryptApiKey(input.apiKey);
      await getDb()
        .insert(llmProviders)
        .values({
          userId: ctx.user.id,
          name: input.name,
          slug: input.slug,
          baseUrl: input.baseUrl,
          apiKeyRef: encryptedKey,
          defaultModel: input.defaultModel,
          models: input.models ?? getProviderDefaults(input.slug)?.models ?? [],
          config: input.config ?? {},
        });

      const [provider] = await getDb()
        .select()
        .from(llmProviders)
        .where(and(eq(llmProviders.slug, input.slug), eq(llmProviders.userId, ctx.user.id)))
        .orderBy(desc(llmProviders.id))
        .limit(1);
      return provider;
    }),

  updateProvider: authedQuery
    .input(
      z.object({
        id: z.number(),
        name: z.string().optional(),
        baseUrl: z.string().url().optional(),
        apiKey: z.string().optional(),
        defaultModel: z.string().optional(),
        models: z.array(z.string()).optional(),
        isEnabled: z.boolean().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      const updateData: Record<string, unknown> = {};
      if (data.name) updateData.name = data.name;
      if (data.baseUrl) updateData.baseUrl = data.baseUrl;
      if (data.apiKey) updateData.apiKeyRef = encryptApiKey(data.apiKey);
      if (data.defaultModel) updateData.defaultModel = data.defaultModel;
      if (data.models) updateData.models = data.models;
      if (data.isEnabled !== undefined) updateData.isEnabled = data.isEnabled;

      await getDb()
        .update(llmProviders)
        .set(updateData)
        .where(and(eq(llmProviders.id, id), eq(llmProviders.userId, ctx.user.id)));

      const [provider] = await getDb()
        .select()
        .from(llmProviders)
        .where(and(eq(llmProviders.id, id), eq(llmProviders.userId, ctx.user.id)));
      return provider;
    }),

  deleteProvider: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      try {
        await getDb()
          .delete(llmProviders)
          .where(and(eq(llmProviders.id, input.id), eq(llmProviders.userId, ctx.user.id)));
      } catch (e) {
        // MySQL errno 1451 (ER_ROW_IS_REFERENCED_2): the provider is still referenced
        // by projects/agents/custom_agents/pipeline_steps (RESTRICT FKs). Surface a
        // actionable message instead of a raw FK error.
        const err = e as { errno?: number; cause?: { errno?: number }; message?: string };
        const errno = err.errno ?? err.cause?.errno;
        if (errno === 1451 || /foreign key constraint/i.test(err.message ?? "")) {
          throw new Error(
            "This provider is still used by a project, agent, or pipeline step. Remove those references first — or use Edit to replace its API key instead of deleting."
          );
        }
        throw e;
      }
      return { success: true };
    }),

  // ─── Declared model prices (migration 034) ─────────────────────────
  // The last rate source: used only when neither the host's published list nor
  // the platform vector knows the model. Entered per 1M tokens because that is
  // the unit provider consoles and local-model docs use; the ledger converts.
  // A declared 0 is a real statement ("this model runs on my own hardware"),
  // which is why it is kept distinct from UNKNOWN everywhere it is disclosed.

  listDeclaredPrices: authedQuery.query(async ({ ctx }) => {
    return getDb()
      .select({
        id: declaredModelPrices.id,
        providerRefId: declaredModelPrices.providerRefId,
        providerName: llmProviders.name,
        modelId: declaredModelPrices.modelId,
        inputUsdPerMillion: declaredModelPrices.inputUsdPerMillion,
        outputUsdPerMillion: declaredModelPrices.outputUsdPerMillion,
        updatedAt: declaredModelPrices.updatedAt,
      })
      .from(declaredModelPrices)
      .innerJoin(llmProviders, eq(declaredModelPrices.providerRefId, llmProviders.id))
      .where(eq(llmProviders.userId, ctx.user.id))
      .orderBy(desc(declaredModelPrices.id));
  }),

  setDeclaredPrice: authedQuery
    .input(z.object({
      providerId: z.number().int().positive(),
      modelId: z.string().min(1).max(191),
      inputUsdPerMillion: z.number().min(0).max(100000),
      outputUsdPerMillion: z.number().min(0).max(100000),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [provider] = await db
        .select({ id: llmProviders.id })
        .from(llmProviders)
        .where(and(eq(llmProviders.id, input.providerId), eq(llmProviders.userId, ctx.user.id)))
        .limit(1);
      // Same error as "does not exist": a foreign provider id must not be
      // distinguishable from a missing one.
      if (!provider) throw new Error("Provider not found");
      const modelId = input.modelId.trim();
      if (!modelId) throw new Error("A model id is required");
      const values = {
        inputUsdPerMillion: input.inputUsdPerMillion.toFixed(8),
        outputUsdPerMillion: input.outputUsdPerMillion.toFixed(8),
      };
      await upsertOnUniqueKey({
        db,
        mysqlTable: declaredModelPrices,
        sqliteTable: sqliteDeclaredModelPrices,
        values: { providerRefId: provider.id, modelId, createdBy: ctx.user.id, ...values },
        conflictTarget: (t) => [t.providerRefId, t.modelId],
        set: () => ({ ...values, createdBy: ctx.user.id }),
      });
      const [row] = await db
        .select({
          id: declaredModelPrices.id,
          providerRefId: declaredModelPrices.providerRefId,
          modelId: declaredModelPrices.modelId,
          inputUsdPerMillion: declaredModelPrices.inputUsdPerMillion,
          outputUsdPerMillion: declaredModelPrices.outputUsdPerMillion,
          updatedAt: declaredModelPrices.updatedAt,
        })
        .from(declaredModelPrices)
        .where(and(eq(declaredModelPrices.providerRefId, provider.id), eq(declaredModelPrices.modelId, modelId)))
        .limit(1);
      return row;
    }),

  deleteDeclaredPrice: authedQuery
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [owned] = await db
        .select({ id: declaredModelPrices.id })
        .from(declaredModelPrices)
        .innerJoin(llmProviders, eq(declaredModelPrices.providerRefId, llmProviders.id))
        .where(and(eq(declaredModelPrices.id, input.id), eq(llmProviders.userId, ctx.user.id)))
        .limit(1);
      if (!owned) throw new Error("Price entry not found");
      await db.delete(declaredModelPrices).where(eq(declaredModelPrices.id, input.id));
      // Removing a declaration cannot corrupt anything: the model simply goes
      // back to UNKNOWN unless the host or the vector states a price.
      return { success: true };
    }),

  testConnection: authedQuery
    .input(z.object({ providerId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const [provider] = await getDb()
        .select()
        .from(llmProviders)
        .where(and(eq(llmProviders.id, input.providerId), eq(llmProviders.userId, ctx.user.id)));

      if (!provider) return { success: false, error: "Provider not found", latency: 0 };

      try {
        const apiKey = decryptApiKey(provider.apiKeyRef);
        const adapter = createProviderAdapter(provider.slug, apiKey, provider.baseUrl, provider.defaultModel);
        const start = Date.now();
        const result = await adapter.validateKey();
        const latency = Date.now() - start;

        return {
          success: result.valid,
          error: result.error,
          latency,
        };
      } catch (e) {
        return { success: false, error: (e as Error).message, latency: 0 };
      }
    }),

  chat: authedQuery
    .input(
      z.object({
        providerId: z.number(),
        model: z.string().optional(),
        messages: z.array(
          z.object({
            role: z.enum(["user", "assistant", "system"]),
            content: z.string(),
          })
        ),
        temperature: z.number().optional(),
        maxTokens: z.number().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const [provider] = await getDb()
        .select()
        .from(llmProviders)
        .where(and(eq(llmProviders.id, input.providerId), eq(llmProviders.userId, ctx.user.id)));

      if (!provider) throw new Error("Provider not found");

      const apiKey = decryptApiKey(provider.apiKeyRef);
      const adapter = createProviderAdapter(provider.slug, apiKey, provider.baseUrl, provider.defaultModel);

      const result = await adapter.chat(input.messages, {
        model: input.model ?? provider.defaultModel,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
      });

      return result;
    }),

  getDefaults: authedQuery
    .input(z.object({ slug: z.string() }))
    .query(({ input }) => {
      return getProviderDefaults(input.slug);
    }),

  fetchModels: authedQuery
    .input(z.object({ providerId: z.number() }))
    .query(async ({ input, ctx }) => {
      const [provider] = await getDb()
        .select()
        .from(llmProviders)
        .where(and(eq(llmProviders.id, input.providerId), eq(llmProviders.userId, ctx.user.id)));

      if (!provider) throw new Error("Provider not found");

      const apiKey = decryptApiKey(provider.apiKeyRef);
      const adapter = createProviderAdapter(provider.slug, apiKey, provider.baseUrl, provider.defaultModel);

      try {
        const models = await adapter.listModels();
        return { models, source: "api" as const };
      } catch {
        const defaults = getProviderDefaults(provider.slug);
        return { models: defaults?.models ?? [], source: "static" as const };
      }
    }),

  // Fetch models BEFORE saving a provider (preview mode)
  fetchModelsPreview: authedQuery
    .input(z.object({
      slug: z.string(),
      baseUrl: z.string(),
      apiKey: z.string(),
    }))
    .mutation(async ({ input }) => {
      const adapter = createProviderAdapter(input.slug, input.apiKey, input.baseUrl, "");
      try {
        const models = await adapter.listModels();
        return { models, source: "api" as const };
      } catch {
        const defaults = getProviderDefaults(input.slug);
        return { models: defaults?.models ?? [], source: "static" as const };
      }
    }),

  // ─── User-level default LLM provider ─────────────────────────────
  // Persists the user's preferred default provider+model so new pipelines
  // and agents can fall back to it when no per-project/per-agent default is set.
  setDefaultProvider: authedQuery
    .input(z.object({
      providerId: z.number().nullable(), // null clears the default
      model: z.string().nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (input.providerId !== null) {
        const [provider] = await getDb()
          .select({ id: llmProviders.id })
          .from(llmProviders)
          .where(and(eq(llmProviders.id, input.providerId), eq(llmProviders.userId, ctx.user.id)));
        if (!provider) throw new Error("Provider not found or not owned by user");
      }
      await getDb()
        .update(users)
        .set({
          defaultProviderId: input.providerId,
          defaultModel: input.model ?? null,
        })
        .where(eq(users.id, ctx.user.id));
      return { providerId: input.providerId, model: input.model ?? null };
    }),

  getDefaultProvider: authedQuery.query(async ({ ctx }) => {
    const [user] = await getDb()
      .select({
        defaultProviderId: users.defaultProviderId,
        defaultModel: users.defaultModel,
      })
      .from(users)
      .where(eq(users.id, ctx.user.id));
    if (!user?.defaultProviderId) return null;
    const [provider] = await getDb()
      .select({
        id: llmProviders.id,
        name: llmProviders.name,
        slug: llmProviders.slug,
        defaultModel: llmProviders.defaultModel,
      })
      .from(llmProviders)
      .where(and(eq(llmProviders.id, user.defaultProviderId), eq(llmProviders.userId, ctx.user.id)));
    if (!provider) return null;
    return {
      providerId: provider.id,
      providerName: provider.name,
      slug: provider.slug,
      model: user.defaultModel ?? provider.defaultModel,
    };
  }),

  // ─── User preferences persistence ─────────────────────────────────
  // Save/load arbitrary user data (saved messages, UI state, recent projects)
  // so it survives deployments and DB wipes. Used by the chat persistence
  // layer and any UI state that must not be lost on upgrade.
  savePreferences: authedQuery
    .input(z.object({
      preferences: z.any(),
    }))
    .mutation(async ({ input, ctx }) => {
      await getDb()
        .update(users)
        .set({ preferences: input.preferences })
        .where(eq(users.id, ctx.user.id));
      return { ok: true };
    }),

  loadPreferences: authedQuery.query(async ({ ctx }) => {
    const [user] = await getDb()
      .select({ preferences: users.preferences })
      .from(users)
      .where(eq(users.id, ctx.user.id));
    return user?.preferences ?? null;
  }),
});
