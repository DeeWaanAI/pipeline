import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { agentResponses, swarmRuns, projects } from "@db/schema";
import { eq, and, desc, asc } from "drizzle-orm";

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

      return getDb()
        .select()
        .from(agentResponses)
        .where(eq(agentResponses.swarmRunId, input.swarmRunId))
        .orderBy(asc(agentResponses.id));
    }),

  getById: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const [response] = await getDb()
        .select()
        .from(agentResponses)
        .where(eq(agentResponses.id, input.id));
      return response ?? null;
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
    .query(async ({ input }) => {
      return getDb()
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
    }),

  flagResponse: authedQuery
    .input(
      z.object({
        responseId: z.number(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
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
    .mutation(async ({ input }) => {
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
