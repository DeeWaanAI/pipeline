// MCP tool: batch_status — get the status of a research-mode batch run.
// Delegates directly to batchService.getBatchStatus (server-side, no tRPC hop needed).

import { z } from "zod";
import type { McpTool, McpAuthContext } from "../types";
import { getBatchStatus } from "../../services/batchService";
import { logger } from "../../lib/logger";

const inputSchema = z.object({
  batchId: z.number().int().positive(),
});

export const batchStatus: McpTool = {
  name: "batch_status",
  description:
    "Get the current status of a batch run: overall progress, per-run statuses, and total tokens used. Poll this after calling run_batch.",
  inputSchema,
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true, destructiveHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = inputSchema.parse(args);

    const status = await getBatchStatus(input.batchId, ctx.userId);
    if (!status) throw new Error("Batch not found");

    logger.info("[mcp:batch_status] fetched", {
      batchId: input.batchId,
      userId: ctx.userId,
      status: status.status,
      completed: status.completedRuns,
      total: status.totalRuns,
    });

    return {
      batchId: status.batchId,
      name: status.name,
      status: status.status,
      totalRuns: status.totalRuns,
      completedRuns: status.completedRuns,
      failedRuns: status.failedRuns,
      totalTokensUsed: status.totalTokensUsed,
      createdAt: status.createdAt.toISOString(),
      completedAt: status.completedAt?.toISOString() ?? null,
      runs: status.runs.map((r) => ({
        id: r.id,
        status: r.status,
        inputPreview: r.inputPreview,
        totalTokensUsed: r.totalTokensUsed,
      })),
    };
  },
};
