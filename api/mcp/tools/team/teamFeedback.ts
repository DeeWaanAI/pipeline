// MCP tool (Phase 2 — TeamSync): team_feedback_submit.
// Submit product feedback from any desktop app. Mirrors the minimal insert
// in api/routers/feedback.ts, with MCP context (clientId as the host, tool
// name, optional run link) in the context fields the schema provides.

import { z } from "zod";
import { eq, and, inArray } from "drizzle-orm";
import type { McpTool, McpAuthContext } from "../../types";
import { getDb } from "../../../queries/connection";
import { feedback, swarmRuns, teamMembers, teamProjects } from "@db/schema";
import { logger } from "../../../lib/logger";
import { canAccessProject } from "../_shared";

const inputSchema = z.object({
  category: z.enum(["bug", "suggestion", "praise", "confusion"]).default("suggestion"),
  message: z.string().min(1).max(5000),
  runId: z.number().int().positive().optional(),
});

export const teamFeedbackSubmit: McpTool = {
  name: "team_feedback_submit",
  description:
    "Submit product feedback (bug, suggestion, praise, or confusion) from your desktop app. Optionally tie it to a pipeline run so the team sees the context.",
  inputSchema,
  requiredScopes: ["team:write"],
  featureFlag: "teamsync",
  annotations: { readOnlyHint: false, destructiveHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = inputSchema.parse(args);

    const db = getDb();

    let projectId: number | null = null;
    let teamId: number | null = null;

    if (input.runId !== undefined) {
      const [run] = await db.select().from(swarmRuns)
        .where(eq(swarmRuns.id, input.runId)).limit(1);
      if (!run) throw new Error("Run not found");

      // Access check BEFORE recording run-linked feedback.
      const allowed = run.userId === ctx.userId || await canAccessProject(ctx.userId, run.projectId);
      if (!allowed) throw new Error("Run not found");

      projectId = run.projectId;

      // Auto-detect the team from the project (mirror feedback.submit):
      // first team the caller belongs to that this project is shared with.
      const memberships = await db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(eq(teamMembers.userId, ctx.userId));
      const teamIds = memberships.map((m) => m.teamId);
      if (teamIds.length > 0) {
        const [shared] = await db
          .select({ teamId: teamProjects.teamId })
          .from(teamProjects)
          .where(and(
            eq(teamProjects.projectId, projectId),
            inArray(teamProjects.teamId, teamIds),
          ))
          .limit(1);
        if (shared) teamId = shared.teamId;
      }
    }

    // Minimal insert mirroring api/routers/feedback.ts, with MCP context in
    // the fields the schema provides: clientId as the host (browser), the
    // tool name as activeStep, and the run link as url.
    const [result] = await db.insert(feedback).values({
      teamId,
      projectId,
      userId: ctx.userId,
      targetType: "general",
      feedbackType: input.category,
      severity: "minor",
      content: input.message,
      contextJson: {
        browser: ctx.clientId,
        activeStep: "team_feedback_submit",
        ...(input.runId !== undefined ? { url: `run:${input.runId}` } : {}),
      },
      status: "new",
    });

    logger.info("[mcp:team_feedback_submit] feedback recorded", {
      feedbackId: Number(result.insertId), runId: input.runId ?? null,
      category: input.category, userId: ctx.userId,
      clientId: ctx.clientId, requestId: ctx.requestId,
    });

    return { id: Number(result.insertId), success: true, teamId };
  },
};
