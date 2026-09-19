// MCP tools (Phase 2 — TeamSync): team_runs_list + team_run_resume.
// Cross-app run visibility: see runs on team-shared projects and which
// approvals are waiting for you, then resume a paused run from any app.

import { z } from "zod";
import { eq, and, desc, inArray } from "drizzle-orm";
import type { McpTool, McpAuthContext } from "../../types";
import { getDb } from "../../../queries/connection";
import { approvalAssignments, projects, swarmRuns, teamMembers, teamProjects } from "@db/schema";
import { enqueueSwarmRun } from "../../../workers/swarmWorker";
import type { SwarmRunParams } from "../../../services/swarmService";
import { logger } from "../../../lib/logger";
import { canAccessProject, truncate } from "../_shared";

const listInputSchema = z.object({
  teamId: z.number().int().positive(),
  limit: z.number().int().min(1).max(50).default(20),
});

const resumeInputSchema = z.object({
  runId: z.number().int().positive(),
});

async function requireTeamMembership(userId: number, teamId: number): Promise<void> {
  const db = getDb();
  const [membership] = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1);
  if (!membership) throw new Error("Team not found");
}

export const teamRunsList: McpTool = {
  name: "team_runs_list",
  description:
    "List pipeline runs across projects shared with a team, plus the approvals waiting for you (runs handed off to you from any teammate's app). Use team_run_resume to resume a run, or approve_step to record a decision.",
  inputSchema: listInputSchema,
  requiredScopes: ["team:read"],
  featureFlag: "teamsync",
  annotations: { readOnlyHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = listInputSchema.parse(args);

    // Access check BEFORE any data is returned.
    await requireTeamMembership(ctx.userId, input.teamId);

    const db = getDb();

    // Approvals handed off to the caller, still pending — joined with the
    // run + project for status, current step and a human-readable title.
    const waitingRows = await db
      .select({
        assignmentId: approvalAssignments.id,
        runId: approvalAssignments.swarmRunId,
        assignedBy: approvalAssignments.assignedBy,
        createdAt: approvalAssignments.createdAt,
        projectId: swarmRuns.projectId,
        projectName: projects.name,
        runStatus: swarmRuns.status,
        currentStep: swarmRuns.currentStep,
        prompt: swarmRuns.userPrompt,
      })
      .from(approvalAssignments)
      .innerJoin(swarmRuns, eq(approvalAssignments.swarmRunId, swarmRuns.id))
      .innerJoin(projects, eq(swarmRuns.projectId, projects.id))
      .where(and(
        eq(approvalAssignments.assigneeUserId, ctx.userId),
        eq(approvalAssignments.status, "pending"),
      ))
      .orderBy(desc(approvalAssignments.createdAt))
      .limit(50);

    // Recent runs on projects shared with THIS team.
    const shared = await db
      .select({ projectId: teamProjects.projectId })
      .from(teamProjects)
      .where(eq(teamProjects.teamId, input.teamId));
    const projectIds = shared.map((s) => s.projectId);

    const runRows = projectIds.length === 0 ? [] : await db
      .select({
        id: swarmRuns.id,
        projectId: swarmRuns.projectId,
        projectName: projects.name,
        status: swarmRuns.status,
        currentStep: swarmRuns.currentStep,
        executionState: swarmRuns.executionState,
        startedAt: swarmRuns.startedAt,
        completedAt: swarmRuns.completedAt,
      })
      .from(swarmRuns)
      .innerJoin(projects, eq(swarmRuns.projectId, projects.id))
      .where(inArray(swarmRuns.projectId, projectIds))
      .orderBy(desc(swarmRuns.startedAt))
      .limit(input.limit);

    logger.info("[mcp:team_runs_list] listed", {
      teamId: input.teamId, runCount: runRows.length, waitingCount: waitingRows.length,
      userId: ctx.userId, clientId: ctx.clientId, requestId: ctx.requestId,
    });

    return {
      teamId: input.teamId,
      waitingForYou: waitingRows.map((w) => ({
        assignmentId: w.assignmentId,
        runId: w.runId,
        projectId: w.projectId,
        projectName: truncate(w.projectName, 100),
        runStatus: w.runStatus,
        currentStep: w.currentStep,
        prompt: truncate(w.prompt, 200),
        assignedBy: w.assignedBy,
        assignedAt: w.createdAt,
      })),
      runs: runRows.map((r) => ({
        id: r.id,
        projectId: r.projectId,
        projectName: truncate(r.projectName, 100),
        status: r.status,
        currentStep: r.currentStep,
        pendingApproval: !!r.executionState?.pendingApproval,
        updatedAt: r.completedAt ?? r.startedAt,
      })),
    };
  },
};

export const teamRunResume: McpTool = {
  name: "team_run_resume",
  description:
    "Resume a paused pipeline run (e.g. after a human-in-the-loop approval) from any app. Mirrors the web app's resumePipeline. To record an approval decision instead, use approve_step.",
  inputSchema: resumeInputSchema,
  requiredScopes: ["team:write"],
  featureFlag: "teamsync",
  annotations: { readOnlyHint: false, destructiveHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = resumeInputSchema.parse(args);

    const db = getDb();
    const [run] = await db.select().from(swarmRuns)
      .where(eq(swarmRuns.id, input.runId)).limit(1);
    if (!run) throw new Error("Run not found");

    // Access check BEFORE any mutation or data return: run owner or
    // team member of a project the run belongs to.
    const allowed = run.userId === ctx.userId || await canAccessProject(ctx.userId, run.projectId);
    if (!allowed) throw new Error("Run not found");

    if (!run.executionState) throw new Error("No execution state to resume");

    // Mirror resumePipeline in api/routers/swarm.ts: persist the worker
    // rehydration payload, then re-enqueue. MCP calls carry no Gitee token;
    // the worker rebuilds the resume context from the DB.
    const runParams: SwarmRunParams = {
      source: "resumePipeline",
      prompt: run.userPrompt ?? "",
      memoryMode: "balanced",
      includeProjectFiles: true,
      clientTraceId: `team-resume-${Date.now()}`,
    };

    await db.update(swarmRuns)
      .set({ status: "running", startedAt: new Date(), runParams })
      .where(eq(swarmRuns.id, input.runId));

    // Note: any pending approval_assignment for this user+run intentionally
    // stays PENDING here — only approve_step completes it.

    try {
      await enqueueSwarmRun(input.runId, ctx.userId);
    } catch (err) {
      logger.error("[mcp:team_run_resume] Failed to enqueue resume job", {
        runId: input.runId, error: (err as Error).message, requestId: ctx.requestId,
      });
      throw new Error("Failed to resume run — retry team_run_resume");
    }

    logger.info("[mcp:team_run_resume] run resumed", {
      runId: input.runId, userId: ctx.userId,
      clientId: ctx.clientId, requestId: ctx.requestId,
    });

    return { runId: input.runId, status: "resumed" };
  },
};
