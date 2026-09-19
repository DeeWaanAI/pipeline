import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { pipelineTemplates, pipelineSteps, customAgents, projects } from "@db/schema";
import { eq, and, desc, asc } from "drizzle-orm";

export const templateRouter = createRouter({
  // ─── List all templates for the user ───────────────────────────────
  list: authedQuery.query(async ({ ctx }) => {
    const db = getDb();
    const templates = await db.select().from(pipelineTemplates)
      .where(eq(pipelineTemplates.userId, ctx.user.id))
      .orderBy(desc(pipelineTemplates.createdAt));

    // Count usage: how many projects reference each template
    const allProjects = await db.select({
      id: projects.id,
      pipelineTemplateId: projects.pipelineTemplateId,
    }).from(projects).where(eq(projects.userId, ctx.user.id));

    const usageMap = new Map<number, number>();
    for (const p of allProjects) {
      if (p.pipelineTemplateId) {
        usageMap.set(p.pipelineTemplateId, (usageMap.get(p.pipelineTemplateId) ?? 0) + 1);
      }
    }

    return templates.map((t) => ({
      ...t,
      usageCount: usageMap.get(t.id) ?? 0,
    }));
  }),

  // ─── Get a single template ────────────────────────────────────────
  getById: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      const [template] = await db.select().from(pipelineTemplates)
        .where(and(eq(pipelineTemplates.id, input.id), eq(pipelineTemplates.userId, ctx.user.id)));
      return template ?? null;
    }),

  // ─── Update template steps ────────────────────────────────────────
  update: authedQuery
    .input(z.object({
      id: z.number(),
      name: z.string().min(1),
      description: z.string().optional(),
      steps: z.array(z.object({
        name: z.string(),
        role: z.string(),
        systemPrompt: z.string(),
        stepType: z.string().optional(),
        ifConfig: z.object({
          options: z.array(z.string()),
          mappings: z.record(z.string(), z.number()),
        }).nullable().optional(),
        whileConfig: z.object({
          targetStep: z.number(),
          maxIterations: z.number(),
        }).nullable().optional(),
        providerId: z.number().nullable().optional(),
        model: z.string().nullable().optional(),
        temperature: z.string().optional(),
        maxTokens: z.number().optional(),
      })),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [existing] = await db.select().from(pipelineTemplates)
        .where(and(eq(pipelineTemplates.id, input.id), eq(pipelineTemplates.userId, ctx.user.id)));
      if (!existing) throw new Error("Template not found");

      await db.update(pipelineTemplates).set({
        name: input.name,
        description: input.description,
        steps: input.steps,
      }).where(eq(pipelineTemplates.id, input.id));

      return { success: true };
    }),

  // ─── Create empty template ────────────────────────────────────────
  createEmpty: authedQuery
    .input(z.object({ name: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [result] = await db.insert(pipelineTemplates).values({
        userId: ctx.user.id,
        name: input.name,
        description: "Custom designed pipeline",
        steps: [{ name: "Builder", role: "builder", systemPrompt: "You are a Builder agent. Create comprehensive initial drafts based on the request.", stepType: "agent", providerId: null, model: null, temperature: "0.7", maxTokens: 4096 }],
        isAuto: false,
      });
      return { id: Number(result.insertId) };
    }),

  // ─── Create template from current pipeline steps ───────────────────
  createFromPipeline: authedQuery
    .input(z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      projectId: z.number(),
      isAuto: z.boolean().default(false),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();

      // Verify project ownership
      const [project] = await db.select().from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.userId, ctx.user.id)));
      if (!project) throw new Error("Project not found");

      // Get pipeline steps
      const steps = await db.select().from(pipelineSteps)
        .where(eq(pipelineSteps.projectId, input.projectId))
        .orderBy(asc(pipelineSteps.stepOrder));

      if (steps.length === 0) throw new Error("No pipeline steps to save");

      // Build template steps
      const templateSteps = steps.map((s) => ({
        name: s.name,
        role: s.role,
        systemPrompt: s.systemPrompt,
        stepType: s.stepType ?? "agent",
        ifConfig: s.ifConfig ?? null,
        whileConfig: s.whileConfig ?? null,
        providerId: s.providerId,
        model: s.model,
        temperature: s.temperature ?? "0.7",
        maxTokens: s.maxTokens ?? 4096,
      }));

      const [result] = await db.insert(pipelineTemplates).values({
        userId: ctx.user.id,
        name: input.name,
        description: input.description ?? `Pipeline with ${steps.length} steps`,
        steps: templateSteps,
        isAuto: input.isAuto,
        sourceProjectId: input.projectId,
      });

      const templateId = Number(result.insertId);

      // Update project to reference the template
      await db.update(projects)
        .set({ pipelineTemplateId: templateId })
        .where(eq(projects.id, input.projectId));

      return { id: templateId, name: input.name, stepCount: steps.length };
    }),

  // ─── Delete a template ────────────────────────────────────────────
  delete: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      await db.delete(pipelineTemplates)
        .where(and(eq(pipelineTemplates.id, input.id), eq(pipelineTemplates.userId, ctx.user.id)));
      return { success: true };
    }),

  // ─── Duplicate a template ─────────────────────────────────────────
  duplicate: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [original] = await db.select().from(pipelineTemplates)
        .where(and(eq(pipelineTemplates.id, input.id), eq(pipelineTemplates.userId, ctx.user.id)));
      if (!original) throw new Error("Template not found");

      const [result] = await db.insert(pipelineTemplates).values({
        userId: ctx.user.id,
        name: `${original.name} (Copy)`,
        description: original.description,
        steps: original.steps,
        isAuto: false,
        sourceProjectId: original.sourceProjectId,
      });

      return { id: Number(result.insertId) };
    }),

  // ─── Apply template to a project ──────────────────────────────────
  useInProject: authedQuery
    .input(z.object({
      templateId: z.number(),
      projectId: z.number(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();

      // Verify ownership
      const [template] = await db.select().from(pipelineTemplates)
        .where(and(eq(pipelineTemplates.id, input.templateId), eq(pipelineTemplates.userId, ctx.user.id)));
      if (!template) throw new Error("Template not found");

      const [project] = await db.select().from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.userId, ctx.user.id)));
      if (!project) throw new Error("Project not found");

      // Delete existing steps
      await db.delete(pipelineSteps).where(eq(pipelineSteps.projectId, input.projectId));

      // Insert template steps
      for (let i = 0; i < template.steps.length; i++) {
        const s = template.steps[i];
        // Resolve agent if needed (find by name+role)
        let agentId: number | null = null;
        if (s.stepType !== "approval") {
          const [existing] = await db.select().from(customAgents)
            .where(and(
              eq(customAgents.userId, ctx.user.id),
              eq(customAgents.name, s.name),
              eq(customAgents.role, s.role),
            )).limit(1);
          if (existing) {
            agentId = existing.id;
          } else {
            // Create agent
            const slug = `${s.role}-${s.name.toLowerCase().replace(/[^a-z0-9_-]/g, "").substring(0, 30)}`;
            const [agentResult] = await db.insert(customAgents).values({
              userId: ctx.user.id,
              name: s.name,
              slug,
              role: s.role,
              systemPrompt: s.systemPrompt,
              description: `From template: ${template.name}`,
              defaultProviderId: s.providerId ?? project.defaultProviderId,
              temperature: s.temperature ?? "0.7",
              maxTokens: s.maxTokens ?? 4096,
            });
            agentId = Number(agentResult.insertId);
          }
        }

        await db.insert(pipelineSteps).values({
          projectId: input.projectId,
          stepOrder: i + 1,
          agentId,
          stepType: s.stepType ?? "agent",
          name: s.name,
          role: s.role,
          systemPrompt: s.systemPrompt,
          providerId: s.providerId ?? null,
          model: s.model ?? null,
          temperature: s.temperature ?? "0.7",
          maxTokens: s.maxTokens ?? 4096,
          ifConfig: s.ifConfig ?? null,
          whileConfig: s.whileConfig ?? null,
          isEnabled: true,
        });
      }

      // Update project to reference the template
      await db.update(projects)
        .set({ pipelineTemplateId: input.templateId })
        .where(eq(projects.id, input.projectId));

      return { applied: template.steps.length };
    }),
});
