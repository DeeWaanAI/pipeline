// MCP tool (Phase 2 — TeamSync): team_handoff.
// Hand off a paused run's approval to a teammate: creates a pending
// approval_assignments row (one per run+assignee) plus a notification, so
// the teammate sees it in team_runs_list ("waitingForYou") from their app.

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import type { McpTool, McpAuthContext } from "../../types";
import { getDb } from "../../../queries/connection";
import {
  approvalAssignments, notifications, swarmRuns, teamMembers, teamProjects,
} from "@db/schema";
import { logger } from "../../../lib/logger";
import { canAccessProject, truncate } from "../_shared";

const inputSchema = z.object({
  runId: z.number().int().positive(),
  assigneeUserId: z.number().int().positive(),
  note: z.string().max(1000).optional(),
});

export const teamHandoff: McpTool = {
  name: "team_handoff",
  description:
    "Hand off a pipeline run's pending approval to a teammate. The assignee must share a team with the run's project. They will see the run under team_runs_list → waitingForYou and can decide with approve_step from their own app.",
  inputSchema,
  requiredScopes: ["team:write"],
  featureFlag: "teamsync",
  annotations: { readOnlyHint: false, destructiveHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = inputSchema.parse(args);

    const db = getDb();
    const [run] = await db.select().from(swarmRuns)
      .where(eq(swarmRuns.id, input.runId)).limit(1);
    if (!run) throw new Error("Run not found");

    // Access check BEFORE any mutation: caller must own the run or have
    // team access to its project.
    const allowed = run.userId === ctx.userId || await canAccessProject(ctx.userId, run.projectId);
    if (!allowed) throw new Error("Run not found");

    // Assignee must share a team with the run's project (teamMembers⨯teamProjects).
    const [assigneeAccess] = await db
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .innerJoin(teamProjects, eq(teamProjects.teamId, teamMembers.teamId))
      .where(and(
        eq(teamMembers.userId, input.assigneeUserId),
        eq(teamProjects.projectId, run.projectId),
      ))
      .limit(1);
    if (!assigneeAccess) {
      throw new Error("Assignee is not a member of any team this project is shared with");
    }

    // One pending row per (run, assignee): reuse the existing pending
    // assignment if present (no note column on approval_assignments — the
    // note rides on the notification below), otherwise insert a new one.
    const [existing] = await db
      .select({ id: approvalAssignments.id })
      .from(approvalAssignments)
      .where(and(
        eq(approvalAssignments.swarmRunId, input.runId),
        eq(approvalAssignments.assigneeUserId, input.assigneeUserId),
        eq(approvalAssignments.status, "pending"),
      ))
      .limit(1);

    let assignmentId: number;
    let reused = false;
    if (existing) {
      assignmentId = existing.id;
      reused = true;
    } else {
      const [result] = await db.insert(approvalAssignments).values({
        swarmRunId: input.runId,
        assigneeUserId: input.assigneeUserId,
        assignedBy: ctx.userId,
        status: "pending",
      });
      assignmentId = Number(result.insertId);
    }

    // Notification mirrors the `notifications` schema shape (userId, type,
    // title, message, dataJson); the note and run context ride in it.
    await db.insert(notifications).values({
      userId: input.assigneeUserId,
      type: "approval_handoff",
      title: "Pipeline approval requested",
      message: input.note
        ? truncate(input.note, 500)
        : `Run #${input.runId} is waiting for your approval`,
      dataJson: {
        runId: input.runId,
        projectId: run.projectId,
        assignedBy: ctx.userId,
        assignmentId,
        via: "team_handoff",
      },
    });

    logger.info("[mcp:team_handoff] assignment recorded", {
      runId: input.runId, assignmentId, assigneeUserId: input.assigneeUserId,
      reused, userId: ctx.userId, clientId: ctx.clientId, requestId: ctx.requestId,
    });

    return {
      assignmentId,
      runId: input.runId,
      assigneeUserId: input.assigneeUserId,
      status: "pending",
      reused,
    };
  },
};
