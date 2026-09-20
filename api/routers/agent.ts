import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { agents } from "@db/schema";
import { eq, asc, desc } from "drizzle-orm";
import { CreateAgentSchema, UpdateAgentSchema, DEFAULT_AGENT_PROMPTS } from "@contracts/index";
import { assertProjectVisible } from "../services/runAccess";

export const agentRouter = createRouter({
  list: authedQuery
    .input(z.object({ projectId: z.number() }))
    .query(async ({ input, ctx }) => {
      // Legacy agent rows carry system prompts, and this read took any
      // projectId with no check that the caller could see it (A12).
      await assertProjectVisible(ctx.user.id, input.projectId);
      return getDb()
        .select()
        .from(agents)
        .where(eq(agents.projectId, input.projectId))
        .orderBy(asc(agents.pipelineOrder));
    }),

  create: authedQuery
    .input(CreateAgentSchema)
    .mutation(async ({ input }) => {
      await getDb()
        .insert(agents)
        .values({
          projectId: input.projectId,
          name: input.name,
          slug: input.slug,
          role: input.role,
          systemPrompt: input.systemPrompt,
          providerId: input.providerId ?? null,
          model: input.model ?? null,
          temperature: input.temperature ?? "0.7",
          maxTokens: input.maxTokens ?? 4096,
          pipelineOrder: input.pipelineOrder ?? 0,
          maxIterations: input.maxIterations ?? 1,
        });

      const [agent] = await getDb()
        .select()
        .from(agents)
        .where(eq(agents.slug, input.slug))
        .orderBy(desc(agents.id))
        .limit(1);
      return agent;
    }),

  update: authedQuery
    .input(UpdateAgentSchema)
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      await getDb()
        .update(agents)
        .set(data)
        .where(eq(agents.id, id));

      const [agent] = await getDb()
        .select()
        .from(agents)
        .where(eq(agents.id, id));
      return agent;
    }),

  delete: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      await getDb().delete(agents).where(eq(agents.id, input.id));
      return { success: true };
    }),

  createDefaults: authedQuery
    .input(z.object({ projectId: z.number() }))
    .mutation(async ({ input }) => {
      const defaults = Object.values(DEFAULT_AGENT_PROMPTS);
      const created = [];

      for (const def of defaults) {
        await getDb()
          .insert(agents)
          .values({
            projectId: input.projectId,
            name: def.name,
            slug: def.slug,
            role: def.role,
            systemPrompt: def.systemPrompt,
            temperature: def.temperature,
            pipelineOrder: def.pipelineOrder,
          });

        const [agent] = await getDb()
          .select()
          .from(agents)
          .where(eq(agents.slug, def.slug))
          .orderBy(desc(agents.id))
          .limit(1);
        created.push(agent);
      }
      return created;
    }),
});
