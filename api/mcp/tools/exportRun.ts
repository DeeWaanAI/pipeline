// MCP tool: export_run — full granular execution history for one pipeline run.
// Returns the run record + every agentRuns step (role, system/user prompts,
// context input, tokens used, latency, model and provider) + every
// agentResponses row (full content). Wraps the export.exportRun tRPC procedure
// (chat-first rule: chat and web run identical logic). Access is enforced by
// the procedure (run owner only). Used by the orchestration-economics research
// harness to archive granular run data locally for cost accounting and
// qualitative analysis.

import { z } from "zod";
import { eq } from "drizzle-orm";
import type { McpTool, McpAuthContext } from "../types";
import { getDb } from "../../queries/connection";
import { users } from "@db/schema";
import { logger } from "../../lib/logger";
import { appRouter } from "../../router";

const inputSchema = z.object({
  runId: z.number().int().positive(),
});

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

export const exportRun: McpTool = {
  name: "export_run",
  description:
    "Export the full granular execution history of one of your pipeline runs as portable JSON: the run record, every intermediate agent step (role, prompts, context input, tokens used, latency, model and provider), and every agent response (full content). Ownership is verified. Hand the returned JSON to your client's filesystem tools to archive it locally.",
  inputSchema,
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true, destructiveHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const { runId } = inputSchema.parse(args);
    const caller = await makeCaller(ctx);
    const result = await caller.export.exportRun({ runId });
    logger.info("MCP export_run", { userId: ctx.userId, runId });
    return {
      ...result,
      message: `Run ${runId} exported (${result.agentRuns.length} steps, ${result.agentResponses.length} responses). To archive locally, ask your chat client to write this JSON to a file.`,
    };
  },
};
