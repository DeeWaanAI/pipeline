// MCP tool: resume_batch — resume a paused batch run.
// Delegates directly to batchService.resumeBatch (server-side, no tRPC hop needed).

import { z } from "zod";
import type { McpTool, McpAuthContext } from "../types";
import { resumeBatch } from "../../services/batchService";
import { logger } from "../../lib/logger";

const inputSchema = z.object({
  batchId: z.number().int().positive(),
});

export const resumeBatchTool: McpTool = {
  name: "resume_batch",
  description:
    "Resume a batch run that was paused due to credit exhaustion or provider outage. Re-enqueues all non-terminal member runs.",
  inputSchema,
  requiredScopes: ["mcp:run"],
  annotations: { readOnlyHint: false, destructiveHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = inputSchema.parse(args);

    await resumeBatch(input.batchId, ctx.userId);

    logger.info("[mcp:resume_batch] resumed", {
      batchId: input.batchId,
      userId: ctx.userId,
    });

    return {
      success: true,
      message: `Batch ${input.batchId} resumed. Non-terminal runs have been re-enqueued.`,
    };
  },
};
