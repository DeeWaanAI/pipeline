// MCP tool: run_batch — enqueue a batch of pipeline runs for a project.
// Delegates directly to batchService.createBatch (server-side, no tRPC hop needed).

import { z } from "zod";
import type { McpTool, McpAuthContext } from "../types";
import { getDb } from "../../queries/connection";
import { projects } from "@db/schema";
import { eq } from "drizzle-orm";
import { createBatch } from "../../services/batchService";
import { logger } from "../../lib/logger";
import { requireProjectAccess } from "./_shared";

const inputSchema = z.object({
  projectId: z.number().int().positive(),
  inputs: z.array(z.string().min(1).max(20000)).min(1).max(100),
  name: z.string().max(200).optional(),
  templateId: z.number().int().positive().optional(),
  chain: z.object({
    targetProjectId: z.number().int().positive(),
    inputTemplate: z.string().max(500).optional(),
  }).optional(),
});

export const runBatch: McpTool = {
  name: "run_batch",
  description:
    "Start a research-mode batch run on a project. Creates a batch with 1–100 inputs, enqueues all member runs for the pipeline worker, and returns immediately — poll batch_status for progress. Supports optional chaining to a target project after completion.",
  inputSchema,
  requiredScopes: ["mcp:run"],
  featureFlag: "batch_mode",
  annotations: { readOnlyHint: false, destructiveHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = inputSchema.parse(args);

    await requireProjectAccess(ctx.userId, input.projectId);

    const db = getDb();
    const [project] = await db.select().from(projects)
      .where(eq(projects.id, input.projectId)).limit(1);
    if (!project) throw new Error("Project not found");

    const result = await createBatch({
      projectId: input.projectId,
      userId: ctx.userId,
      name: input.name,
      inputs: input.inputs,
      templateId: input.templateId,
      chain: input.chain,
    });

    logger.info("[mcp:run_batch] batch created", {
      batchId: result.batchId,
      runCount: result.runIds.length,
      projectId: input.projectId,
      userId: ctx.userId,
    });

    return {
      batchId: result.batchId,
      runIds: result.runIds,
      status: result.status,
      message: `Batch created with ${result.runIds.length} runs. Poll batch_status for progress.`,
    };
  },
};
