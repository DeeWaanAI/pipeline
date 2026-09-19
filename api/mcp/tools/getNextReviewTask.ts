// MCP tool: get_next_review_task — pull one blind review task from the pool.
// Returns ONLY { taskId, inputText, actualOutput, rubric }: the listing id,
// title, creator, and category are server-only (blind review, spec 0.5.3).

import { z } from "zod";
import type { McpTool, McpAuthContext } from "../types";
import { claimNextBlindTask } from "../../routers/marketplace";

const inputSchema = z.object({});

export const getNextReviewTask: McpTool = {
  name: "get_next_review_task",
  description:
    "Pull the next blind marketplace review task. You must be an enrolled, active reviewer (see enroll_reviewer). Returns one anonymized test input/output pair plus the scoring rubric — the listing's identity is never revealed. Review it, then submit scores with submit_review_task.",
  inputSchema,
  requiredScopes: ["mcp:write"], // claims (mutates) a pooled task
  annotations: { readOnlyHint: false, destructiveHint: false },
  handler: async (_args: unknown, ctx: McpAuthContext) => {
    const task = await claimNextBlindTask(ctx.userId);
    if (!task) {
      return {
        task: null,
        message: "No review tasks available right now. Check back later — tasks appear when new pipelines enter certification.",
      };
    }
    return {
      task,
      next: `Score each rubric dimension 1-5, then call submit_review_task with taskId: ${task.taskId}`,
    };
  },
};
