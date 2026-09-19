// MCP tool: export_batch_results — export a batch run as CSV.
// Delegates directly to batchService.exportBatchResults (server-side, no tRPC hop needed).

import { z } from "zod";
import type { McpTool, McpAuthContext } from "../types";
import { exportBatchResults } from "../../services/batchService";
import { logger } from "../../lib/logger";

const inputSchema = z.object({
  batchId: z.number().int().positive(),
});

export const exportBatchResultsTool: McpTool = {
  name: "export_batch_results",
  description:
    "Export the results of a completed batch run as CSV. Returns a CSV string with columns: run_id, input_preview, status, final_response, total_tokens_used, total_latency_ms.",
  inputSchema,
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true, destructiveHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = inputSchema.parse(args);

    const csv = await exportBatchResults(input.batchId, ctx.userId);

    logger.info("[mcp:export_batch_results] exported", {
      batchId: input.batchId,
      userId: ctx.userId,
      csvLength: csv.length,
    });

    return {
      csv,
      message: `Batch ${input.batchId} exported. Ask your chat client to save the CSV to a file.`,
    };
  },
};
