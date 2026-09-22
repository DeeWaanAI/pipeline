// MCP tool: deewaanai_help — a guide to everything the caller can do from
// their desktop chat. Content is built by the pure helpContent.ts module from
// the caller's actual entitlements (what they own), scopes, feature flags and
// settings — so the guide only shows tools that will actually work for this
// user, and tips match their situation. There is no plan ladder to be
// "on": every signed-in account can do everything the scopes allow.

import { z } from "zod";
import { eq } from "drizzle-orm";
import type { McpTool, McpAuthContext } from "../types";
import { getDb } from "../../queries/connection";
import { llmProviders } from "@db/schema";
import { resolveCapabilities } from "../../services/entitlements";
import { isFeatureEnabled } from "../../plugins/featureFlags";
import { buildHelp } from "./helpContent";

const inputSchema = z.object({});

export const deewaanaiHelp: McpTool = {
  name: "deewaanai_help",
  description:
    "Guide to using DeeWaanAI from this chat: what pipelines are, every command your account and this connected app can actually run (with examples), and tips for your current setup. Start here if unsure what to ask.",
  inputSchema,
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true },
  handler: async (_args: unknown, ctx: McpAuthContext) => {
    const db = getDb();
    const { capabilities } = await resolveCapabilities(ctx.userId);

    const [samplingEnabled, batchModeEnabled, v2DesignEnabled, v2BenchmarkEnabled, v2PublicationEnabled, v2ProtectedEnabled, provider] = await Promise.all([
      isFeatureEnabled("mcp_sampling", ctx.userId),
      isFeatureEnabled("batch_mode", ctx.userId),
      isFeatureEnabled("v2DesignJobs", ctx.userId),
      isFeatureEnabled("v2Benchmarks", ctx.userId),
      isFeatureEnabled("v2Publication", ctx.userId),
      isFeatureEnabled("v2ProtectedExecution", ctx.userId),
      db.select({ id: llmProviders.id }).from(llmProviders)
        .where(eq(llmProviders.userId, ctx.userId)).limit(1),
    ]);

    return buildHelp({
      capabilities,
      scopes: [...ctx.scopes],
      flags: {
        mcp_sampling: samplingEnabled, batch_mode: batchModeEnabled,
        v2DesignJobs: v2DesignEnabled, v2Benchmarks: v2BenchmarkEnabled, v2Publication: v2PublicationEnabled,
        v2ProtectedExecution: v2ProtectedEnabled,
      },
      hasProvider: provider.length > 0,
      samplingSupported: ctx.runtime?.samplingSupported?.() ?? null,
    });
  },
};
