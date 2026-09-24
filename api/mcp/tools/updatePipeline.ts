// MCP tool: update_pipeline — modify settings and/or replace the step chain
// of a project the caller OWNS (owner-only edit is the real authorization
// check here). IF/WHILE steps are open to every account, same as create:
// there is no plan ladder (owner decision 2026-09-22).

import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import type { McpTool, McpAuthContext } from "../types";
import { getDb } from "../../queries/connection";
import { pipelineSteps, projects } from "@db/schema";
import { finalizePipelineCreation } from "../../services/pipelineCreationService";
import { insertProjectSteps, requireOwnedProviders } from "./_shared";
import {
  findWhileTargetErrors,
  pipelineConfigInputSchema,
  pipelineStepsInputSchema,
  stepsUseControlFlow,
} from "./pipelineValidation";

const inputSchema = z.object({
  id: z.number().int().min(1).describe("Project id (from list_pipelines)"),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).nullish(),
  defaultModel: z.string().max(100).nullish(),
  defaultProviderId: z.number().int().min(1).nullish().describe(
    "Which of your configured providers runs the steps (get_settings lists ids); null clears it.",
  ),
  pipelineConfig: pipelineConfigInputSchema.nullish(),
  steps: pipelineStepsInputSchema
    .nullish()
    .describe("Full replacement step chain (existing steps are deleted first)"),
});

export const updatePipeline: McpTool = {
  name: "update_pipeline",
  description:
    "Update a pipeline project you own: rename, change description/default model/execution settings, and/or replace the whole step chain (existing steps are replaced atomically per call). IF/WHILE control-flow steps are open to every account. Use get_pipeline first to inspect current state.",
  inputSchema,
  requiredScopes: ["mcp:write"],
  annotations: { readOnlyHint: false, destructiveHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = inputSchema.parse(args);
    const db = getDb();

    // Owner-only modification (non-leaky: same error as missing).
    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, input.id), eq(projects.userId, ctx.userId)))
      .limit(1);
    if (!project) throw new Error("Project not found");

    if (input.steps) {
      const targetErrors = findWhileTargetErrors(input.steps);
      if (targetErrors.length > 0) throw new Error(targetErrors.join("; "));
    }

    await requireOwnedProviders(ctx.userId, [input.defaultProviderId, ...(input.steps ?? []).map((s) => s.providerId)]);

    // Settings patch (only provided fields)
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description ?? null;
    if (input.defaultModel !== undefined) patch.defaultModel = input.defaultModel ?? null;
    if (input.defaultProviderId !== undefined) {
      patch.defaultProviderId = input.defaultProviderId ?? null;
    }
    if (input.pipelineConfig !== undefined && input.pipelineConfig !== null) {
      patch.pipelineConfig = input.pipelineConfig;
    }
    if (Object.keys(patch).length > 0) {
      await db.update(projects).set(patch).where(eq(projects.id, input.id));
    }

    // Step-chain replacement
    let stepCount: number | undefined;
    if (input.steps) {
      await db.delete(pipelineSteps).where(eq(pipelineSteps.projectId, input.id));
      await insertProjectSteps(input.id, input.steps);
      // Re-create agents and template so the web UI stays in sync.
      await finalizePipelineCreation(
        ctx.userId,
        input.id,
        `${input.name ?? project.name} Pipeline`,
        input.description ?? project.description ?? `Updated pipeline with ${input.steps.length} steps`,
      );
      stepCount = input.steps.length;
    } else {
      const existing = await db
        .select({ id: pipelineSteps.id })
        .from(pipelineSteps)
        .where(eq(pipelineSteps.projectId, input.id))
        .orderBy(asc(pipelineSteps.stepOrder));
      stepCount = existing.length;
    }

    return {
      id: input.id,
      updated: Object.keys(patch),
      stepCount,
      controlFlow: input.steps ? stepsUseControlFlow(input.steps) : undefined,
    };
  },
};
