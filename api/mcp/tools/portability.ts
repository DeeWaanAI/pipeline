// MCP tools: Data portability (Batch B, auditor recommendation #7).
// No lock-in, from chat: export a pipeline, export everything you own, or
// push a pipeline backup to your connected GitHub repo. Local-folder saving
// needs nothing from us — the user's client-side filesystem tools write the
// returned JSON wherever they choose; the LLM orchestrates both in one ask.
//
// All three delegate to the real tRPC procedures via a server-side caller
// (chat-first rule: chat and web run identical logic).

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import type { McpTool, McpAuthContext } from "../types";
import { getDb } from "../../queries/connection";
import { projects, users } from "@db/schema";
import { logger } from "../../lib/logger";
import { appRouter } from "../../router";

async function makeCaller(ctx: McpAuthContext) {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, ctx.userId)).limit(1);
  if (!user) throw new Error("User not found");
  return appRouter.createCaller({
    req: new Request("http://internal/mcp"),
    resHeaders: new Headers(),
    user,
    requestId: `mcp-${crypto.randomUUID()}`,
  });
}

// ═══════════════════════════════════════════════════════════════════
// 2. export_my_data
// ═══════════════════════════════════════════════════════════════════

export const exportMyData: McpTool = {
  name: "export_my_data",
  description:
    "Export ALL your DeeWaanAI data as one portable JSON backup: projects, pipeline steps, custom agents (with prompts), templates, and preferences. No lock-in — this is everything, restorable via the app's import. For large accounts the JSON can be long; ask your client to write it straight to a file.",
  inputSchema: z.object({}),
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true, destructiveHint: false },
  handler: async (_args: unknown, ctx: McpAuthContext) => {
    const caller = await makeCaller(ctx);
    const result = await caller.export.exportAllUserData();
    logger.info("MCP export_my_data", {
      userId: ctx.userId,
      projects: result.projects.length,
      agents: result.customAgents.length,
      templates: result.pipelineTemplates.length,
    });
    return {
      ...result,
      message: `Full backup: ${result.projects.length} projects, ${result.pipelineSteps.length} steps, ${result.customAgents.length} agents, ${result.pipelineTemplates.length} templates. Ask your chat client to write this JSON to a file.`,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════