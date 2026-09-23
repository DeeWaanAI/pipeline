import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { debugLogs, agentRuns, agentResponses, swarmRuns } from "@db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { assertProjectVisible, assertRunVisible, withholdsModel } from "../services/runAccess";

// Every procedure in this router used to query by swarmRunId/projectId alone,
// with no check that the caller could see that run. `debugLogs` rows carry
// prompt-derived content, so this was the widest A12 hole in the app — and it
// was reachable for a marketplace buyer run too, where the logged material
// describes the SELLER's workflow.
export const debugRouter = createRouter({
  list: authedQuery
    .input(
      z.object({
        swarmRunId: z.number(),
        eventType: z
          .enum(["thought", "action", "result", "error", "system"])
          .optional(),
        limit: z.number().default(100),
        offset: z.number().default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      await assertRunVisible(ctx.user.id, input.swarmRunId);
      const conditions = [eq(debugLogs.swarmRunId, input.swarmRunId)];
      if (input.eventType) {
        conditions.push(eq(debugLogs.eventType, input.eventType));
      }

      return getDb()
        .select()
        .from(debugLogs)
        .where(and(...conditions))
        .orderBy(desc(debugLogs.timestamp))
        .limit(input.limit)
        .offset(input.offset);
    }),

  getBySwarmRun: authedQuery
    .input(z.object({ swarmRunId: z.number() }))
    .query(async ({ input, ctx }) => {
      await assertRunVisible(ctx.user.id, input.swarmRunId);
      return getDb()
        .select()
        .from(debugLogs)
        .where(eq(debugLogs.swarmRunId, input.swarmRunId))
        .orderBy(debugLogs.timestamp);
    }),

  // Get per-run stats (for audit page)
  getRunStats: authedQuery
    .input(z.object({ swarmRunId: z.number() }))
    .query(async ({ input, ctx }) => {
      await assertRunVisible(ctx.user.id, input.swarmRunId);
      // Get run info
      const [run] = await getDb()
        .select()
        .from(swarmRuns)
        .where(eq(swarmRuns.id, input.swarmRunId));

      // Get all agent runs for this swarm run, ordered by pipeline step
      const agentRunList = await getDb()
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.swarmRunId, input.swarmRunId))
        .orderBy(agentRuns.pipelineStep, agentRuns.iteration);

      // Get all responses
      const responseList = await getDb()
        .select()
        .from(agentResponses)
        .where(eq(agentResponses.swarmRunId, input.swarmRunId))
        .orderBy(agentResponses.createdAt);

      // Build per-step stats
      const hideModel = withholdsModel(run);
      const steps = agentRunList.map((ar) => ({
        agentRole: ar.agentRole,
        agentName: ar.agentName,
        pipelineStep: ar.pipelineStep,
        iteration: ar.iteration,
        tokensUsed: ar.tokensUsed ?? 0,
        latencyMs: ar.latencyMs ?? 0,
        // Which model each step pins is part of a `run_only` grantor's
        // definition, and this is the one read that reaches step rows without
        // going through the export projection.
        modelUsed: hideModel ? "withheld_run_only_share" : (ar.modelUsed ?? "unknown"),
        status: ar.status,
      }));

      // Calculate totals
      const totalTokens = steps.reduce((sum, s) => sum + s.tokensUsed, 0);
      const totalLatencyMs = steps.reduce((sum, s) => sum + s.latencyMs, 0);

      // Group by role for breakdown
      const byRole: Record<string, { count: number; avgTokens: number; avgLatencyMs: number; totalTokens: number }> = {};
      for (const step of steps) {
        if (!byRole[step.agentRole]) {
          byRole[step.agentRole] = { count: 0, avgTokens: 0, avgLatencyMs: 0, totalTokens: 0 };
        }
        byRole[step.agentRole].count++;
        byRole[step.agentRole].totalTokens += step.tokensUsed;
        byRole[step.agentRole].avgLatencyMs += step.latencyMs;
      }
      const byRoleArray = Object.entries(byRole).map(([role, data]) => ({
        role,
        count: data.count,
        avgTokens: Math.round(data.totalTokens / data.count),
        avgLatencyMs: Math.round(data.avgLatencyMs / data.count),
      }));

      return {
        run: {
          userPrompt: run?.userPrompt ?? "",
          status: run?.status ?? "unknown",
          totalTokensUsed: totalTokens,
          totalLatencyMs,
          startedAt: run?.startedAt,
          completedAt: run?.completedAt,
        },
        steps,
        byRole: byRoleArray,
        responseCount: responseList.length,
      };
    }),

  // Get aggregate stats for a project (kept for backward compat)
  getStats: authedQuery
    .input(z.object({ projectId: z.number() }))
    .query(async ({ input, ctx }) => {
      await assertProjectVisible(ctx.user.id, input.projectId);
      const [runsResult] = await getDb()
        .select({ count: sql<number>`count(*)` })
        .from(agentRuns)
        .where(eq(agentRuns.projectId, input.projectId));

      const [responsesResult] = await getDb()
        .select({ count: sql<number>`count(*)` })
        .from(agentResponses)
        .where(eq(agentResponses.projectId, input.projectId));

      const [tokensResult] = await getDb()
        .select({ total: sql<number>`coalesce(sum(tokens_used), 0)` })
        .from(agentRuns)
        .where(eq(agentRuns.projectId, input.projectId));

      const [latencyResult] = await getDb()
        .select({ total: sql<number>`coalesce(sum(latency_ms), 0)` })
        .from(agentRuns)
        .where(eq(agentRuns.projectId, input.projectId));

      const byRole = await getDb()
        .select({
          role: agentRuns.agentRole,
          count: sql<number>`count(*)`,
          avgTokens: sql<number>`coalesce(avg(tokens_used), 0)`,
          avgLatency: sql<number>`coalesce(avg(latency_ms), 0)`,
        })
        .from(agentRuns)
        .where(eq(agentRuns.projectId, input.projectId))
        .groupBy(agentRuns.agentRole);

      const [flaggedResult] = await getDb()
        .select({ count: sql<number>`count(*)` })
        .from(agentResponses)
        .where(and(
          eq(agentResponses.projectId, input.projectId),
          eq(agentResponses.isFlagged, true)
        ));

      return {
        totalRuns: runsResult?.count ?? 0,
        totalResponses: responsesResult?.count ?? 0,
        totalTokens: tokensResult?.total ?? 0,
        totalLatencyMs: latencyResult?.total ?? 0,
        byRole: byRole.map((r) => ({
          role: r.role,
          count: r.count,
          avgTokens: Math.round(r.avgTokens),
          avgLatencyMs: Math.round(r.avgLatency),
        })),
        flaggedCount: flaggedResult?.count ?? 0,
      };
    }),
});
