import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { pipelineSteps, customAgents, llmProviders, projects } from "@db/schema";
import { eq, and, asc, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";

/**
 * Batch version of resolveAgent — resolves multiple steps in a single query.
 * Fetches all user agents once, then matches each step against the result.
 * Only creates agents that don't exist yet (batch insert).
 */
async function batchResolveAgents(
  db: ReturnType<typeof getDb>,
  userId: number,
  steps: Array<{ name: string; role: string; systemPrompt: string }>,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (steps.length === 0) return result;

  // Build slug for each step
  const stepSlugs = steps.map((s) => ({
    ...s,
    slug: `${s.role}-${s.name.toLowerCase().replace(/[^a-z0-9_-]/g, "")}`,
  }));

  // Single query: fetch all user agents (replaces N * 3 queries)
  const allUserAgents = await db
    .select()
    .from(customAgents)
    .where(eq(customAgents.userId, userId));

  // Build lookup maps
  const bySlug = new Map(allUserAgents.map((a) => [a.slug, a.id]));
  const byRoleName = new Map(allUserAgents.map((a) => [`${a.role}|${a.name}`, a.id]));
  const byRole = new Map(allUserAgents.map((a) => [a.role, a.id]));

  // First pass: resolve existing agents
  const toCreate: typeof stepSlugs = [];
  for (const step of stepSlugs) {
    const id = bySlug.get(step.slug) ?? byRoleName.get(`${step.role}|${step.name}`) ?? byRole.get(step.role);
    if (id !== undefined) {
      result.set(step.slug, id);
    } else {
      toCreate.push(step);
    }
  }

  // Batch create any missing agents
  if (toCreate.length > 0) {
    await db.insert(customAgents).values(
      toCreate.map((s) => ({
        userId,
        name: s.name,
        slug: s.slug,
        role: s.role,
        systemPrompt: s.systemPrompt,
        description: `Auto-created for pipeline`,
        temperature: "0.7",
        maxTokens: 4096,
      })),
    );

    // Re-fetch created agents
    const created = await db
      .select()
      .from(customAgents)
      .where(
        and(
          eq(customAgents.userId, userId),
          inArray(customAgents.slug, toCreate.map((s) => s.slug)),
        ),
      );
    for (const agent of created) {
      result.set(agent.slug, agent.id);
    }
  }

  return result;
}

export const pipelineRouter = createRouter({
  // Get pipeline steps for a project
  get: authedQuery
    .input(z.object({ projectId: z.number() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();

      // OWNER-ONLY read (team sharing was removed with ticket #26). The
      // non-leaky "not found" wording is kept so probing ids tells nothing.
      const [project] = await db
        .select({ userId: projects.userId })
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .limit(1);
      if (!project || project.userId !== ctx.user.id) throw new Error("Project not found");

      const steps = await db
        .select()
        .from(pipelineSteps)
        .where(eq(pipelineSteps.projectId, input.projectId))
        .orderBy(asc(pipelineSteps.stepOrder));

      return steps;
    }),

  // Set pipeline steps (replaces all existing steps).
  // Auto-creates agents that don't exist in the user's library.
  set: authedQuery
    .input(z.object({
      projectId: z.number(),
      steps: z.array(z.object({
        name: z.string(),
        role: z.string(),
        systemPrompt: z.string(),
        providerId: z.number().nullable().optional(),
        model: z.string().nullable().optional(),
        temperature: z.string().optional(),
        maxTokens: z.number().optional(),
        isEnabled: z.boolean().optional(),
        stepType: z.string().optional(),
        ifConfig: z.object({
          options: z.array(z.string()),
          mappings: z.record(z.string(), z.number()),
        }).nullable().optional(),
        whileConfig: z.object({
          targetStep: z.number(),
          maxIterations: z.number(),
        }).nullable().optional(),
      })),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();

      const [project] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.userId, ctx.user.id)));
      if (!project) throw new Error("Project not found");

      // Validate: max 3 unique providers (only count agent steps)
      const agentSteps = input.steps.filter((s) => (s.stepType ?? "agent") === "agent");
      const providerIds = agentSteps
        .map((s) => s.providerId)
        .filter((p): p is number => p !== undefined && p !== null);
      const uniqueProviders = new Set(providerIds);
      if (uniqueProviders.size > 3) {
        throw new Error("A pipeline can use at most 3 different LLM providers — point the extra steps at one you already use.");
      }

      // Batch resolve all agents upfront (eliminates N+1 queries)
      const agentStepsToResolve = input.steps
        .filter((s) => (s.stepType ?? "agent") !== "approval")
        .map((s) => ({ name: s.name, role: s.role, systemPrompt: s.systemPrompt }));
      const agentMap = await batchResolveAgents(db, ctx.user.id, agentStepsToResolve);

      // Wrap delete + insert in a transaction for atomicity
      await db.transaction(async (tx) => {
        await tx.delete(pipelineSteps).where(eq(pipelineSteps.projectId, input.projectId));

        for (let i = 0; i < input.steps.length; i++) {
          const step = input.steps[i];
          const stepType = step.stepType ?? "agent";
          const isApproval = stepType === "approval";

          let agentId: number | null = null;
          if (!isApproval) {
            const slug = `${step.role}-${step.name.toLowerCase().replace(/[^a-z0-9_-]/g, "")}`;
            agentId = agentMap.get(slug) ?? null;
          }

          await tx.insert(pipelineSteps).values({
            projectId: input.projectId,
            stepOrder: i + 1,
            agentId,
            stepType,
            name: step.name,
            role: step.role,
            systemPrompt: step.systemPrompt,
            providerId: step.providerId ?? null,
            model: step.model ?? null,
            temperature: step.temperature ?? "0.7",
            maxTokens: step.maxTokens ?? 4096,
            ifConfig: step.ifConfig ?? null,
            whileConfig: step.whileConfig ?? null,
            isEnabled: step.isEnabled ?? true,
          });
        }
      });

      const saved = await db.select().from(pipelineSteps)
        .where(eq(pipelineSteps.projectId, input.projectId))
        .orderBy(asc(pipelineSteps.stepOrder));

      logger.info("pipeline.set saved steps", { projectId: input.projectId, count: saved.length, steps: saved.map((s) => `${s.stepOrder}.${s.name}(${s.role})[${s.stepType}]`) });

      return saved;
    }),

  // Create default pipeline (Standard Tier: Builder → Critic → Refiner → Polisher)
  createDefault: authedQuery
    .input(z.object({ projectId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();

      const existingAgents = await db
        .select()
        .from(customAgents)
        .where(and(eq(customAgents.userId, ctx.user.id), eq(customAgents.slug, "builder")))
        .limit(1);

      let builderId: number;
      if (!existingAgents[0]) {
        // Create default agents for user
        const defaults = [
          { name: "Builder", slug: "builder", role: "builder", systemPrompt: "You are a Builder agent. Create an initial, comprehensive response to the user's request. Focus on completeness and accuracy. Produce a well-structured draft.", description: "Creates the initial response/draft" },
          { name: "Critic", slug: "critic", role: "critic", systemPrompt: "You are a Critic agent. Review the provided output and identify weaknesses, errors, or areas for improvement. Be specific. End with Overall Assessment: PASS, NEEDS_WORK, or MAJOR_REVISIONS.", description: "Identifies weaknesses and errors" },
          { name: "Refiner", slug: "refiner", role: "refiner", systemPrompt: "You are a Refiner agent. Improve the provided output based on the feedback. Address each criticism systematically. Produce a significantly improved version.", description: "Improves output based on feedback" },
          { name: "Polisher", slug: "polisher", role: "polisher", systemPrompt: "You are a Polisher agent. Take the refined output and make it presentation-ready. Improve clarity, flow, formatting, and tone. This is the final quality check.", description: "Final quality check and polish" },
        ];

        // Wrap agent + step creation in a transaction for atomicity
        await db.transaction(async (tx) => {
          for (const def of defaults) {
            await tx.insert(customAgents).values({
              userId: ctx.user.id,
              ...def,
              temperature: "0.7",
              maxTokens: 4096,
            });
          }

          const allAgents = await tx
            .select()
            .from(customAgents)
            .where(eq(customAgents.userId, ctx.user.id));

          builderId = allAgents.find((a) => a.slug === "builder")?.id ?? 0;
          const criticId = allAgents.find((a) => a.slug === "critic")?.id ?? 0;
          const refinerId = allAgents.find((a) => a.slug === "refiner")?.id ?? 0;
          const polisherId = allAgents.find((a) => a.slug === "polisher")?.id ?? 0;

          const stepDefs = [
            { agentId: builderId, name: "Builder", role: "builder", systemPrompt: defaults[0].systemPrompt },
            { agentId: criticId, name: "Critic", role: "critic", systemPrompt: defaults[1].systemPrompt },
            { agentId: refinerId, name: "Refiner", role: "refiner", systemPrompt: defaults[2].systemPrompt },
            { agentId: polisherId, name: "Polisher", role: "polisher", systemPrompt: defaults[3].systemPrompt },
          ];

          for (let i = 0; i < stepDefs.length; i++) {
            const sd = stepDefs[i];
            await tx.insert(pipelineSteps).values({
              projectId: input.projectId,
              stepOrder: i + 1,
              agentId: sd.agentId,
              name: sd.name,
              role: sd.role,
              systemPrompt: sd.systemPrompt,
              temperature: "0.7",
              maxTokens: 4096,
              isEnabled: true,
            });
          }
        });
      } else {
        // Wrap step creation in a transaction for atomicity
        await db.transaction(async (tx) => {
          const userAgents = await tx
            .select()
            .from(customAgents)
            .where(eq(customAgents.userId, ctx.user.id));

          const defaultOrder = ["builder", "critic", "refiner", "polisher"];
          let order = 1;
          for (const roleSlug of defaultOrder) {
            const agent = userAgents.find((a) => a.slug === roleSlug);
            if (agent) {
              await tx.insert(pipelineSteps).values({
                projectId: input.projectId,
                stepOrder: order++,
                agentId: agent.id,
                name: agent.name,
                role: agent.role,
                systemPrompt: agent.systemPrompt,
                temperature: agent.temperature ?? "0.7",
                maxTokens: agent.maxTokens ?? 4096,
                isEnabled: true,
              });
            }
          }
        });
      }

      return db.select().from(pipelineSteps)
        .where(eq(pipelineSteps.projectId, input.projectId))
        .orderBy(asc(pipelineSteps.stepOrder));
    }),

  availableProviders: authedQuery.query(async ({ ctx }) => {
    return getDb()
      .select()
      .from(llmProviders)
      .where(eq(llmProviders.userId, ctx.user.id));
  }),
});
