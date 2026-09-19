// MCP tool: submit_review_task — submit scores for a claimed blind review task.
// Writes the per-prompt review, marks the task completed, awards reviewer
// points, and runs the certification aggregation (spec 0.5.4/0.5.5).

import { z } from "zod";
import type { McpTool, McpAuthContext } from "../types";
import { submitBlindTaskReview } from "../../routers/marketplace";

const inputSchema = z.object({
  taskId: z.number().int().positive(),
  accuracy: z.number().min(1).max(5),
  completeness: z.number().min(1).max(5),
  clarity: z.number().min(1).max(5),
  tokenEfficiency: z.number().min(1).max(5),
  speed: z.number().min(1).max(5),
  consistency: z.number().min(1).max(5),
  reviewTime: z.number().min(1), // seconds spent reviewing
});

export const submitReviewTask: McpTool = {
  name: "submit_review_task",
  description:
    "Submit 1-5 scores for a blind review task you claimed via get_next_review_task. Awards reviewer points. When a listing reaches the reviewer quorum, certification is decided automatically (published or rejected).",
  inputSchema,
  requiredScopes: ["mcp:write"],
  annotations: { readOnlyHint: false, destructiveHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const { taskId, ...scores } = inputSchema.parse(args);
    const result = await submitBlindTaskReview(ctx.userId, taskId, scores);
    return {
      ...result,
      next: "Call get_next_review_task for another task.",
    };
  },
};
