import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { agentResponses, swarmRuns, projects } from "@db/schema";
import { eq, and, desc, asc, inArray } from "drizzle-orm";
import { assertProjectVisible, assertResponseVisible, isProtectedRun } from "../services/runAccess";

export const responseRouter = createRouter({
  getChain: authedQuery
    .input(z.object({ swarmRunId: z.number() }))
    .query(async ({ input, ctx }) => {
      // Verify ownership
      const [run] = await getDb()
        .select()
        .from(swarmRuns)
        .where(and(eq(swarmRuns.id, input.swarmRunId), eq(swarmRuns.userId, ctx.user.id)));
      if (!run) return [];

      const rows = await getDb()
        .select()
        .from(agentResponses)
        .where(eq(agentResponses.swarmRunId, input.swarmRunId))
        .orderBy(asc(agentResponses.id));
      // §8.1: a protected run's buyer view is the FINAL output. Intermediates
      // are withheld even from the buyer, because a step could echo the seller's
      // instructions into its own output.
      if (isProtectedRun(run)) {
        return run.finalResponseId
          ? rows.filter((r) => r.id === run.finalResponseId)
          : [];
      }
      return rows;
    }),

  getById: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input, ctx }) => {
      // Was queried by id alone: any authenticated user could read any
      // tenant's response content (A12).
      await assertResponseVisible(ctx.user.id, input.id);
      const [response] = await getDb()
        .select()
        .from(agentResponses)
        .where(eq(agentResponses.id, input.id));
      if (!response) return null;
      // §8.1: visibility of the PROJECT is not visibility of the step. A
      // protected run's intermediates stay withheld even from its own buyer,
      // who can otherwise read this id straight from the chain listing.
      if (response.swarmRunId) {
        const [run] = await getDb()
          .select({ runParams: swarmRuns.runParams, finalResponseId: swarmRuns.finalResponseId })
          .from(swarmRuns)
          .where(eq(swarmRuns.id, response.swarmRunId))
          .limit(1);
        if (isProtectedRun(run) && run.finalResponseId !== response.id) return null;
      }
      return response;
    }),

  listByType: authedQuery
    .input(
      z.object({
        projectId: z.number(),
        responseType: z.enum(["raw", "feedback", "corrected", "synthesized", "final"]),
        limit: z.number().default(50),
        offset: z.number().default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      // Queried by projectId alone before: any user could enumerate another
      // tenant's outputs (A12).
      await assertProjectVisible(ctx.user.id, input.projectId);
      const rows = await getDb()
        .select()
        .from(agentResponses)
        .where(
          and(
            eq(agentResponses.projectId, input.projectId),
            eq(agentResponses.responseType, input.responseType)
          )
        )
        .orderBy(desc(agentResponses.createdAt))
        .limit(input.limit)
        .offset(input.offset);
      // Protected runs keep their intermediates hidden, from their own buyer
      // included (§8.1).
      if (rows.length === 0) return rows;
      const runIds = [...new Set(rows.map((r) => r.swarmRunId).filter(Boolean) as number[])];
      if (runIds.length === 0) return rows;
      const runs = await getDb()
        .select({ id: swarmRuns.id, runParams: swarmRuns.runParams, finalResponseId: swarmRuns.finalResponseId })
        .from(swarmRuns).where(inArray(swarmRuns.id, runIds));
      const protectedRuns = new Map(runs.filter(isProtectedRun).map((r) => [r.id, r.finalResponseId]));
      if (protectedRuns.size === 0) return rows;
      return rows.filter((r) => !protectedRuns.has(r.swarmRunId ?? -1) || r.id === protectedRuns.get(r.swarmRunId ?? -1));
    }),

  flagResponse: authedQuery
    .input(
      z.object({
        responseId: z.number(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // A write, and previously unguarded: any user could flag or annotate any
      // tenant's response by id.
      await assertResponseVisible(ctx.user.id, input.responseId);
      await getDb()
        .update(agentResponses)
        .set({ isFlagged: true, humanNotes: input.notes ?? null })
        .where(eq(agentResponses.id, input.responseId));
      return { success: true };
    }),

  addHumanNotes: authedQuery
    .input(
      z.object({
        responseId: z.number(),
        notes: z.string(),
        rating: z.number().min(1).max(5).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      await assertResponseVisible(ctx.user.id, input.responseId);
      await getDb()
        .update(agentResponses)
        .set({
          humanReviewed: true,
          humanNotes: input.notes,
        })
        .where(eq(agentResponses.id, input.responseId));
      return { success: true };
    }),

  // List swarm runs for a project with response counts
  listSwarmRuns: authedQuery
    .input(z.object({ projectId: z.number(), limit: z.number().default(20) }))
    .query(async ({ input, ctx }) => {
      return getDb()
        .select({
          id: swarmRuns.id,
          userPrompt: swarmRuns.userPrompt,
          status: swarmRuns.status,
          currentStep: swarmRuns.currentStep,
          pipelineVersion: swarmRuns.pipelineVersion,
          totalTokensUsed: swarmRuns.totalTokensUsed,
          totalLatencyMs: swarmRuns.totalLatencyMs,
          startedAt: swarmRuns.startedAt,
          completedAt: swarmRuns.completedAt,
        })
        .from(swarmRuns)
        .where(
          and(
            eq(swarmRuns.projectId, input.projectId),
            eq(swarmRuns.userId, ctx.user.id)
          )
        )
        .orderBy(desc(swarmRuns.startedAt))
        .limit(input.limit);
    }),

  // List all swarm runs across ALL projects for the current user (global audit view)
  listAllRuns: authedQuery
    .input(z.object({ limit: z.number().default(50) }))
    .query(async ({ input, ctx }) => {
      return getDb()
        .select({
          id: swarmRuns.id,
          userPrompt: swarmRuns.userPrompt,
          status: swarmRuns.status,
          currentStep: swarmRuns.currentStep,
          pipelineVersion: swarmRuns.pipelineVersion,
          totalTokensUsed: swarmRuns.totalTokensUsed,
          totalLatencyMs: swarmRuns.totalLatencyMs,
          startedAt: swarmRuns.startedAt,
          completedAt: swarmRuns.completedAt,
          projectId: swarmRuns.projectId,
          projectName: projects.name,
          isTestRun: swarmRuns.isTestRun,
        })
        .from(swarmRuns)
        .innerJoin(projects, eq(swarmRuns.projectId, projects.id))
        .where(eq(swarmRuns.userId, ctx.user.id))
        .orderBy(desc(swarmRuns.startedAt))
        .limit(input.limit);
    }),
});
