import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { projects, pipelineSteps, customAgents, llmProviders } from "@db/schema";
import { eq, and, desc, asc } from "drizzle-orm";
import { CreateProjectSchema, UpdateProjectSchema } from "@contracts/index";
import { validateToken, listRepos, createRepo, createOrUpdateFile, deleteFolder } from "../services/giteeService";
import * as disk from "../services/projectFilesDisk";
import { logger } from "../lib/logger";

export const projectRouter = createRouter({
  list: authedQuery.query(async ({ ctx }) => {
    const db = getDb();

    // Owner-only: team sharing was removed with ticket #26, so the project
    // list is exactly the projects this account owns.
    return await db
      .select()
      .from(projects)
      .where(eq(projects.userId, ctx.user.id))
      .orderBy(desc(projects.updatedAt));
  }),

  getById: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();

      // Owner-only (non-leaky: a project you do not own reads as missing).
      const [ownProject] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, input.id), eq(projects.userId, ctx.user.id)))
        .limit(1);

      return ownProject ?? null;
    }),

  create: authedQuery
    .input(CreateProjectSchema)
    .mutation(async ({ input, ctx }) => {
      let giteeOwner = input.giteeOwner ?? null;
      let giteeRepo = input.giteeRepo ?? null;
      let giteeError: string | undefined;

      // Auto-create Gitee folder if token is provided
      if (input.giteeToken) {
        try {
          const tokenValidation = await validateToken(input.giteeToken);
          if (!tokenValidation.valid || !tokenValidation.user) {
            throw new Error("Invalid Gitee token");
          }

          const repos = await listRepos(input.giteeToken, 1, 20);
          const existingRepo = repos.find((r) => r.name === "swarm-studio");

          if (existingRepo) {
            giteeOwner = (existingRepo.owner as { login: string }).login;
            giteeRepo = existingRepo.name as string;
          } else {
            const newRepo = await createRepo(input.giteeToken, "swarm-studio", "AI Swarm Studio projects");
            giteeOwner = newRepo.owner.login;
            giteeRepo = newRepo.name;
          }

          await createOrUpdateFile(
            input.giteeToken,
            giteeOwner!,
            giteeRepo!,
            `swarm_studio/${input.name}/README.md`,
            `# ${input.name}\n\nProject created via AI Swarm Studio.\n`,
            `init: create project "${input.name}"`,
            "master"
          );
        } catch (err: unknown) {
          giteeError = err instanceof Error ? err.message : String(err);
          logger.error("Gitee project folder creation failed", { error: giteeError });
        }
      }

      // Wrap all DB writes in a transaction for atomicity
      // (Gitee API calls above are external and stay outside the transaction)
      let project: typeof projects.$inferSelect;
      await getDb().transaction(async (tx) => {
        await tx
          .insert(projects)
          .values({
            userId: ctx.user.id,
            name: input.name,
            description: input.description ?? null,
            giteeOwner,
            giteeRepo,
            giteeBranch: "master",
            defaultProviderId: input.defaultProviderId ?? null,
            defaultModel: input.defaultModel ?? null,
          });

        [project] = await tx
          .select()
          .from(projects)
          .where(eq(projects.userId, ctx.user.id))
          .orderBy(desc(projects.id))
          .limit(1);

        // ─── Create default pipeline steps (Builder → Critic → Refiner → Polisher) ───
        try {
          // Check if user has the 4 default agents
          const userAgents = await tx
            .select()
            .from(customAgents)
            .where(eq(customAgents.userId, ctx.user.id));

          const hasAllDefaults = ["builder", "critic", "refiner", "polisher"].every((slug) =>
            userAgents.some((a) => a.slug === slug)
          );

          let agentIds: Record<string, number> = {};

          if (!hasAllDefaults) {
            // Create missing default agents
            const defaults = [
              { name: "Builder", slug: "builder", role: "builder", systemPrompt: "You are a Builder agent. Create an initial, comprehensive response to the user's request. Focus on completeness and accuracy. Produce a well-structured draft.", description: "Creates the initial response/draft" },
              { name: "Critic", slug: "critic", role: "critic", systemPrompt: "You are a Critic agent. Review the provided output and identify weaknesses, errors, or areas for improvement. Be specific. End with Overall Assessment: PASS, NEEDS_WORK, or MAJOR_REVISIONS.", description: "Identifies weaknesses and errors" },
              { name: "Refiner", slug: "refiner", role: "refiner", systemPrompt: "You are a Refiner agent. Improve the provided output based on the feedback. Address each criticism systematically. Produce a significantly improved version.", description: "Improves output based on feedback" },
              { name: "Polisher", slug: "polisher", role: "polisher", systemPrompt: "You are a Polisher agent. Take the refined output and make it presentation-ready. Improve clarity, flow, formatting, and tone. This is the final quality check.", description: "Final quality check and polish" },
            ];

            for (const def of defaults) {
              const existing = userAgents.find((a) => a.slug === def.slug);
              if (existing) {
                agentIds[def.slug] = existing.id;
              } else {
                await tx.insert(customAgents).values({
                  userId: ctx.user.id,
                  ...def,
                  temperature: "0.7",
                  maxTokens: 4096,
                });
                const [created] = await tx
                  .select()
                  .from(customAgents)
                  .where(and(eq(customAgents.userId, ctx.user.id), eq(customAgents.slug, def.slug)))
                  .limit(1);
                if (created) agentIds[def.slug] = created.id;
              }
            }
          } else {
            for (const slug of ["builder", "critic", "refiner", "polisher"]) {
              const a = userAgents.find((ua) => ua.slug === slug);
              if (a) agentIds[slug] = a.id;
            }
          }

          // Create pipeline steps for this project
          const stepDefs = [
            { slug: "builder", name: "Builder", role: "builder", systemPrompt: "You are a Builder agent. Create an initial, comprehensive response to the user's request. Focus on completeness and accuracy. Produce a well-structured draft." },
            { slug: "critic", name: "Critic", role: "critic", systemPrompt: "You are a Critic agent. Review the provided output and identify weaknesses, errors, or areas for improvement. Be specific. End with Overall Assessment: PASS, NEEDS_WORK, or MAJOR_REVISIONS." },
            { slug: "refiner", name: "Refiner", role: "refiner", systemPrompt: "You are a Refiner agent. Improve the provided output based on the feedback. Address each criticism systematically. Produce a significantly improved version." },
            { slug: "polisher", name: "Polisher", role: "polisher", systemPrompt: "You are a Polisher agent. Take the refined output and make it presentation-ready. Improve clarity, flow, formatting, and tone. This is the final quality check." },
          ];

          for (let i = 0; i < stepDefs.length; i++) {
            const sd = stepDefs[i];
            const agentId = agentIds[sd.slug];
            if (agentId) {
              await tx.insert(pipelineSteps).values({
                projectId: project.id,
                stepOrder: i + 1,
                agentId,
                name: sd.name,
                role: sd.role,
                systemPrompt: sd.systemPrompt,
                temperature: "0.7",
                maxTokens: 4096,
                isEnabled: true,
              });
            }
          }
        } catch (pipelineErr) {
          logger.error("Pipeline failed to create default pipeline", { error: (pipelineErr as Error).message });
          // Non-critical: project is still created
        }
      });

      return { ...project!, giteeError };
    }),

  update: authedQuery
    .input(UpdateProjectSchema)
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      await getDb()
        .update(projects)
        .set(data)
        .where(and(eq(projects.id, id), eq(projects.userId, ctx.user.id)));

      const [project] = await getDb()
        .select()
        .from(projects)
        .where(and(eq(projects.id, id), eq(projects.userId, ctx.user.id)));
      return project;
    }),

  delete: authedQuery
    .input(z.object({ id: z.number(), giteeToken: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      const [project] = await getDb()
        .select()
        .from(projects)
        .where(and(eq(projects.id, input.id), eq(projects.userId, ctx.user.id)));

      if (project) {
        // Clean up Gitee
        if (input.giteeToken && project.giteeOwner && project.giteeRepo) {
          try {
            await deleteFolder(
              input.giteeToken,
              project.giteeOwner,
              project.giteeRepo,
              `swarm_studio/${project.name}`,
              project.giteeBranch ?? "master"
            );
            // Also clean up project-source ZIP on Gitee
            await deleteFolder(
              input.giteeToken,
              project.giteeOwner,
              project.giteeRepo,
              "project-source",
              project.giteeBranch ?? "master"
            );
          } catch { /* non-critical */ }
        }

        // Clean up local disk files
        try {
          await disk.deleteProjectFiles(input.id);
        } catch { /* non-critical */ }

        await getDb()
          .delete(projects)
          .where(and(eq(projects.id, input.id), eq(projects.userId, ctx.user.id)));
      }

      return { success: true };
    }),

  // ─── Pipeline Config (now reads from pipeline_steps) ───

  getPipelineConfig: authedQuery
    .input(z.object({ projectId: z.number() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      const [project] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.userId, ctx.user.id)));
      if (!project) return null;

      const steps = await db
        .select()
        .from(pipelineSteps)
        .where(eq(pipelineSteps.projectId, input.projectId))
        .orderBy(asc(pipelineSteps.stepOrder));

      // Get available providers for LLM assignment
      const providers = await db
        .select()
        .from(llmProviders)
        .where(eq(llmProviders.userId, ctx.user.id));

      return {
        steps: steps.map((s) => ({
          id: s.id,
          stepOrder: s.stepOrder,
          name: s.name,
          role: s.role,
          systemPrompt: s.systemPrompt,
          isEnabled: s.isEnabled,
          providerId: s.providerId,
          model: s.model,
          temperature: s.temperature,
          maxTokens: s.maxTokens,
          stepType: s.stepType,
          ifConfig: s.ifConfig,
          whileConfig: s.whileConfig,
        })),
        providers: providers.map((p) => ({ id: p.id, name: p.name, slug: p.slug })),
        projectDefaultProviderId: project.defaultProviderId,
      };
    }),

  updatePipelineConfig: authedQuery
    .input(
      z.object({
        projectId: z.number(),
        steps: z.array(z.object({
          id: z.number(),
          isEnabled: z.boolean().optional(),
          systemPrompt: z.string().optional(),
          providerId: z.number().nullable().optional(),
          model: z.string().nullable().optional(),
          temperature: z.string().optional(),
          maxTokens: z.number().optional(),
        })),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();

      const [project] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.userId, ctx.user.id)));
      if (!project) throw new Error("Project not found");

      // Validate: max 3 unique providers
      const providerIds = input.steps
        .map((s) => s.providerId)
        .filter((p): p is number => p !== undefined && p !== null);
      const uniqueProviders = new Set(providerIds);
      if (uniqueProviders.size > 3) {
        throw new Error("A pipeline can use at most 3 different LLM providers — point the extra steps at one you already use.");
      }

      for (const step of input.steps) {
        const { id, ...updates } = step;
        await db.update(pipelineSteps)
          .set(updates)
          .where(and(eq(pipelineSteps.id, id), eq(pipelineSteps.projectId, input.projectId)));
      }

      const steps = await db
        .select()
        .from(pipelineSteps)
        .where(eq(pipelineSteps.projectId, input.projectId))
        .orderBy(asc(pipelineSteps.stepOrder));

      return { steps, providerCount: uniqueProviders.size };
    }),
});
