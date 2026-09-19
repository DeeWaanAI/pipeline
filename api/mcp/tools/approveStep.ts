// MCP tool: approve_step — record a human-in-the-loop decision on a paused
// run and re-enqueue it so the swarm worker resumes. Mirrors the approveStep
// mutation in api/routers/swarm.ts.

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import type { McpTool, McpAuthContext } from "../types";
import { getDb } from "../../queries/connection";
import { approvalAssignments, swarmRuns } from "@db/schema";
import { enqueueSwarmRun } from "../../workers/swarmWorker";
import { logger } from "../../lib/logger";
import { canAccessProject } from "./_shared";

const inputSchema = z.object({
  runId: z.number().int().positive(),
  action: z.enum(["approve", "reject", "modify"]),
  instructions: z.string().max(5000).optional(),
});

export const approveStep: McpTool = {
  name: "approve_step",
  description:
    "Approve, reject, or modify a paused human-in-the-loop pipeline step and resume the run. For 'modify', include instructions telling the previous agent what to change.",
  inputSchema,
  requiredScopes: ["mcp:write"],
  annotations: { readOnlyHint: false, destructiveHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = inputSchema.parse(args);

    const db = getDb();
    const [run] = await db.select().from(swarmRuns)
      .where(eq(swarmRuns.id, input.runId)).limit(1);
    if (!run) throw new Error("Run not found");

    // Access check BEFORE any mutation or data return.
    const allowed = run.userId === ctx.userId || await canAccessProject(ctx.userId, run.projectId);
    if (!allowed) throw new Error("Run not found");

    if (!run.executionState) throw new Error("No pending approval for this run");
    if (run.status !== "running") {
      throw new Error(`Run is not awaiting approval (status: ${run.status})`);
    }

    // Update execution state with the approval action (mirror approveStep mutation).
    const execState = run.executionState as NonNullable<typeof run.executionState>;
    execState.pendingApproval = {
      stepOrder: execState.pendingApproval?.stepOrder ?? 0,
      lastOutput: execState.pendingApproval?.lastOutput ?? "",
      action: input.action,
      instructions: input.instructions,
    };

    // Note: status intentionally untouched — a paused run stays "running" and
    // the worker's resume path (claim + executionState) requires that.
    await db.update(swarmRuns)
      .set({ executionState: execState })
      .where(eq(swarmRuns.id, input.runId));

    // TeamSync: if this run was handed off to the deciding user via
    // team_handoff, mark their pending assignment completed. Best-effort —
    // a failure here must not block the decision.
    try {
      const completed = await db.update(approvalAssignments)
        .set({ status: "completed", completedAt: new Date() })
        .where(and(
          eq(approvalAssignments.swarmRunId, input.runId),
          eq(approvalAssignments.assigneeUserId, ctx.userId),
          eq(approvalAssignments.status, "pending"),
        ));
      if (completed[0].affectedRows > 0) {
        logger.info("[mcp:approve_step] handoff assignment completed", {
          runId: input.runId, count: completed[0].affectedRows, userId: ctx.userId,
        });
      }
    } catch (err) {
      logger.warn("[mcp:approve_step] assignment completion failed", {
        runId: input.runId, error: (err as Error).message, requestId: ctx.requestId,
      });
    }

    // Re-enqueue so the worker resumes with the recorded decision. The
    // per-run claim makes duplicate enqueues safe (second job no-ops).
    try {
      await enqueueSwarmRun(input.runId, ctx.userId);
    } catch (err) {
      logger.error("[mcp:approve_step] Failed to enqueue resume job", {
        runId: input.runId, error: (err as Error).message, requestId: ctx.requestId,
      });
      throw new Error("Decision recorded but failed to resume run — retry approve_step");
    }

    logger.info("[mcp:approve_step] run resumed", {
      runId: input.runId, action: input.action, userId: ctx.userId,
      clientId: ctx.clientId, requestId: ctx.requestId,
    });

    return { runId: input.runId, action: input.action, status: "resumed" };
  },
};
