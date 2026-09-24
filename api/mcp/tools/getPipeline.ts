// MCP tool: get_pipeline — full detail of one project: settings +
// pipeline_config + ordered steps. Read companion for create/update.

import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import type { McpTool, McpAuthContext } from "../types";
import { getDb } from "../../queries/connection";
import { pipelineSteps, projects } from "@db/schema";
import { requireProjectAccess, truncate } from "./_shared";

const inputSchema = z.object({
  id: z.number().int().min(1).describe("Project id (from list_pipelines)"),
});

export const getPipeline: McpTool = {
  name: "get_pipeline",
  description:
    "Get one pipeline project in full: name, description, default model, execution settings (pipeline_config), and its ordered steps (agent/if/while/approval) with prompts and configs. Use before update_pipeline.",
  inputSchema,
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const { id } = inputSchema.parse(args);
    await requireProjectAccess(ctx.userId, id);

    const db = getDb();
    const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (!project) throw new Error("Project not found");

    const steps = await db
      .select()
      .from(pipelineSteps)
      .where(eq(pipelineSteps.projectId, id))
      .orderBy(asc(pipelineSteps.stepOrder));

    return {
      id: project.id,
      name: project.name,
      description: truncate(project.description, 500),
      defaultModel: project.defaultModel,
      defaultProviderId: project.defaultProviderId,
      pipelineConfig: project.pipelineConfig ?? {},
      pipelineTemplateId: project.pipelineTemplateId,
      stepCount: steps.length,
      steps: steps.map((s) => ({
        order: s.stepOrder,
        name: s.name,
        role: s.role,
        stepType: s.stepType,
        systemPrompt: truncate(s.systemPrompt, 2000),
        model: s.model,
        providerId: s.providerId,
        temperature: s.temperature,
        maxTokens: s.maxTokens,
        ifConfig: s.ifConfig ?? null,
        whileConfig: s.whileConfig ?? null,
        isEnabled: s.isEnabled,
      })),
    };
  },
};
