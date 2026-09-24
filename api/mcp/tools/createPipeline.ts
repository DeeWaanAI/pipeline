// MCP tool: create_pipeline — create a project with an optional full step
// definition in one call. Every step type (agent / if / while / approval) is
// open to every signed-in account: there is no plan ladder (owner decision
// 2026-09-22). What IS enforced below is provider ownership.

import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import type { McpTool, McpAuthContext } from "../types";
import { getDb } from "../../queries/connection";
import { projects } from "@db/schema";
import { finalizePipelineCreation } from "../../services/pipelineCreationService";
import { insertProjectSteps, requireOwnedProviders } from "./_shared";
import {
  findWhileTargetErrors,
  pipelineConfigInputSchema,
  pipelineStepsInputSchema,
  stepsUseControlFlow,
} from "./pipelineValidation";

const inputSchema = z.object({
  name: z.string().trim().min(1).max(200).describe("Pipeline (project) name"),
  description: z.string().max(5000).nullish(),
  defaultModel: z.string().max(100).nullish().describe("Default LLM model for runs"),
  defaultProviderId: z.number().int().min(1).nullish().describe(
    "Project default provider (get_settings lists your ids). Each step can select its own providerId; otherwise normal agent/project provider fallback applies.",
  ),
  pipelineConfig: pipelineConfigInputSchema.nullish().describe("Execution settings"),
  steps: pipelineStepsInputSchema.nullish().describe(
    "Ordered agent chain. stepType agent/if/while/approval — every step type is available to every account.",
  ),
});

export const createPipeline: McpTool = {
  name: "create_pipeline",
  description:
    "Create a new pipeline project: name, optional description/model/execution settings, and optionally a full ordered step chain (agents run sequentially; if/while control-flow steps loop or branch until the output passes and are open to every account). Returns the new project id for run_pipeline.",
  inputSchema,
  requiredScopes: ["mcp:write"],
  annotations: { readOnlyHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = inputSchema.parse(args);

    if (input.steps) {
      const targetErrors = findWhileTargetErrors(input.steps);
      if (targetErrors.length > 0) throw new Error(targetErrors.join("; "));
    }

    const db = getDb();

    await requireOwnedProviders(ctx.userId, [input.defaultProviderId, ...(input.steps ?? []).map((s) => s.providerId)]);

    await db.insert(projects).values({
      userId: ctx.userId,
      name: input.name,
      description: input.description ?? null,
      defaultModel: input.defaultModel ?? null,
      defaultProviderId: input.defaultProviderId ?? null,
      pipelineConfig: input.pipelineConfig ?? null,
    });
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.userId, ctx.userId))
      .orderBy(desc(projects.id))
      .limit(1);
    if (!project) throw new Error("Project creation failed");

    if (input.steps && input.steps.length > 0) {
      await insertProjectSteps(project.id, input.steps);
      // Create customAgents and a reusable template so the project appears
      // in the web UI (My Pipelines / My Agents).
      await finalizePipelineCreation(
        ctx.userId,
        project.id,
        `${project.name} Pipeline`,
        input.description ?? `Pipeline with ${input.steps.length} steps`,
      );
    }

    return {
      id: project.id,
      name: project.name,
      stepCount: input.steps?.length ?? 0,
      controlFlow: input.steps ? stepsUseControlFlow(input.steps) : false,
      next: "Run it with run_pipeline, inspect with get_pipeline, adjust with update_pipeline.",
    };
  },
};
