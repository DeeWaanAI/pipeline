// MCP tool: run_pipeline — enqueue a new pipeline run for a project.
// Mirrors api/routers/swarm.ts `execute` (run-row creation) and
// api/routers/template.ts applyTemplate (optional templateId materialization),
// then hands off to the swarm worker via enqueueSwarmRun.

import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import type { McpTool, McpAuthContext } from "../types";
import { getDb } from "../../queries/connection";
import { swarmRuns, projects, pipelineSteps, pipelineTemplates, customAgents } from "@db/schema";
import { enqueueSwarmRun } from "../../workers/swarmWorker";
import { logger } from "../../lib/logger";
import { requireProjectAccess } from "./_shared";

const inputSchema = z.object({
  projectId: z.number().int().positive(),
  input: z.string().min(1).max(20000),
  templateId: z.number().int().positive().optional(),
  stateless: z.boolean().optional(),
  chain: z.object({
    targetProjectId: z.number().int().positive(),
    inputTemplate: z.string().max(500).optional(),
  }).optional(),
});

/**
 * Materialize a template's steps into pipeline_steps so the worker's
 * loadPipelineSteps() picks them up. Mirrors template.ts applyTemplate.
 * Owner-only: mutating a shared project's pipeline is not allowed for
 * team members (same policy as the tRPC mutation).
 */
async function applyTemplateToProject(userId: number, projectId: number, templateId: number): Promise<void> {
  const db = getDb();

  const [template] = await db.select().from(pipelineTemplates)
    .where(and(eq(pipelineTemplates.id, templateId), eq(pipelineTemplates.userId, userId)));
  if (!template) throw new Error("Template not found");

  const [project] = await db.select().from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  if (!project) throw new Error("Only the project owner can apply a template");

  await db.delete(pipelineSteps).where(eq(pipelineSteps.projectId, projectId));

  for (let i = 0; i < template.steps.length; i++) {
    const s = template.steps[i];
    let agentId: number | null = null;
    if (s.stepType !== "approval") {
      const [existing] = await db.select().from(customAgents)
        .where(and(
          eq(customAgents.userId, userId),
          eq(customAgents.name, s.name),
          eq(customAgents.role, s.role),
        )).limit(1);
      if (existing) {
        agentId = existing.id;
      } else {
        const slug = `${s.role}-${s.name.toLowerCase().replace(/[^a-z0-9_-]/g, "").substring(0, 30)}`;
        const [agentResult] = await db.insert(customAgents).values({
          userId,
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
      projectId,
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

  await db.update(projects)
    .set({ pipelineTemplateId: templateId })
    .where(eq(projects.id, projectId));
}

export const runPipeline: McpTool = {
  name: "run_pipeline",
  description:
    "Start a new AI pipeline run on a project. Creates the run, enqueues it for the pipeline worker, and returns immediately — poll run_status for progress and the final response.",
  inputSchema,
  requiredScopes: ["mcp:run"],
  annotations: { readOnlyHint: false, destructiveHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = inputSchema.parse(args);

    // Access check BEFORE any data is returned (bearer-credential safety).
    await requireProjectAccess(ctx.userId, input.projectId);

    const db = getDb();
    const [project] = await db.select().from(projects)
      .where(eq(projects.id, input.projectId)).limit(1);
    if (!project) throw new Error("Project not found");

    if (input.templateId !== undefined) {
      await applyTemplateToProject(ctx.userId, input.projectId, input.templateId);
    }

    // Mirror execute mutation: atomic insert + id re-read (MySQL has no RETURNING).
    // The worker derives pipelineVersion/agentsUsed itself; seed them here anyway.
    let runId = 0;
    await db.transaction(async (tx) => {
      await tx.insert(swarmRuns).values({
        projectId: input.projectId,
        userId: ctx.userId,
        userPrompt: input.input,
        status: "pending",
        pipelineVersion: project.pipelineTemplateId ? "custom-v2" : "cascade-v1",
        agentsUsed: [],
        runParams: {
          source: "execute", prompt: input.input, memoryMode: "balanced",
          stateless: input.stateless,
          chain: input.chain ? {
            targetProjectId: input.chain.targetProjectId,
            inputTemplate: input.chain.inputTemplate,
            depth: 0,
            lineage: [runId],
          } : undefined,
        },
      });
      const [run] = await tx.select().from(swarmRuns)
        .where(eq(swarmRuns.userId, ctx.userId))
        .orderBy(desc(swarmRuns.id)).limit(1);
      runId = run.id;
    });

    await enqueueSwarmRun(runId, ctx.userId);
    logger.info("[mcp:run_pipeline] run queued", {
      runId, projectId: input.projectId, userId: ctx.userId,
      clientId: ctx.clientId, requestId: ctx.requestId,
    });

    return { runId, status: "queued", streamHint: "poll run_status" };
  },
};
