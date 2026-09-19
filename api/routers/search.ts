import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { projects, swarmRuns, customAgents } from "@db/schema";
import { eq, and, sql, desc } from "drizzle-orm";

export const searchRouter = createRouter({
  // Search across projects, runs, and agents
  global: authedQuery
    .input(z.object({
      query: z.string().min(1).max(200),
      limit: z.number().min(1).max(50).default(10),
    }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      const q = `%${input.query}%`;
      
      // Search projects
      const projectResults = await db.select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
      }).from(projects)
        .where(and(
          eq(projects.userId, ctx.user.id),
          sql`(${projects.name} LIKE ${q} OR ${projects.description} LIKE ${q})`
        ))
        .limit(input.limit);

      // Search swarm runs by prompt content
      const runResults = await db.select({
        id: swarmRuns.id,
        projectId: swarmRuns.projectId,
        userPrompt: swarmRuns.userPrompt,
        status: swarmRuns.status,
        startedAt: swarmRuns.startedAt,
      }).from(swarmRuns)
        .where(and(
          eq(swarmRuns.userId, ctx.user.id),
          sql`${swarmRuns.userPrompt} LIKE ${q}`
        ))
        .orderBy(desc(swarmRuns.startedAt))
        .limit(input.limit);

      // Search custom agents
      const agentResults = await db.select({
        id: customAgents.id,
        name: customAgents.name,
        role: customAgents.role,
        description: customAgents.description,
      }).from(customAgents)
        .where(and(
          eq(customAgents.userId, ctx.user.id),
          sql`(${customAgents.name} LIKE ${q} OR ${customAgents.systemPrompt} LIKE ${q} OR ${customAgents.description} LIKE ${q})`
        ))
        .limit(input.limit);

      return {
        projects: projectResults,
        runs: runResults,
        agents: agentResults,
        totalResults: projectResults.length + runResults.length + agentResults.length,
      };
    }),
});
