// MCP tool: design_pipeline — the auto designer. The user states an
// objective; the platform's LLM designer generates the optimal pipeline
// (agents + steps + template) into a freshly created project the caller owns.
// Open to every signed-in account (no plan ladder, owner decision 2026-09-22);
// the designer's LLM calls are billed on the caller's OWN provider.

import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import type { McpTool, McpAuthContext } from "../types";
import { getDb } from "../../queries/connection";
import { projects } from "@db/schema";
import { runAutoDesign } from "../../services/autoDesignService";
import { isFeatureEnabled } from "../../plugins/featureFlags";

const inputSchema = z.object({
  name: z.string().trim().min(1).max(200).describe("Name for the new pipeline project"),
  task: z.string().trim().min(1).max(5000).describe("The objective the pipeline should accomplish"),
  description: z.string().max(5000).nullish(),
  providerId: z.number().int().min(1).optional().describe("LLM provider to design with (defaults to the user's first configured provider)"),
});

interface CreateMessageResultLike {
  content?: { type?: string; text?: string };
}

export const designPipeline: McpTool = {
  name: "design_pipeline",
  description:
    "Auto-design a pipeline from a plain-language objective: the platform designs the optimal agent chain (roles, prompts, if/while quality gates, human approvals), creates the project, agents, steps and a reusable template. Available to every account. Uses your desktop app's own LLM when it supports MCP sampling, otherwise a configured LLM provider you own (Settings) — the calls are billed on your own key.",
  inputSchema,
  requiredScopes: ["mcp:write"],
  annotations: { readOnlyHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = inputSchema.parse(args);

    // Create the target project, then let the shared designer fill it.
    const db = getDb();
    await db.insert(projects).values({
      userId: ctx.userId,
      name: input.name,
      description: input.description ?? `Auto-designed for: ${input.task.substring(0, 200)}`,
    });
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.userId, ctx.userId))
      .orderBy(desc(projects.id))
      .limit(1);
    if (!project) throw new Error("Project creation failed");

    // Prefer the connected desktop app's own LLM (MCP sampling) when the
    // flag is on and the client supports it — no API key involved. Falls
    // back to the configured-provider path otherwise.
    const samplingOn = await isFeatureEnabled("mcp_sampling", ctx.userId);
    const chatFn = samplingOn && ctx.runtime?.samplingSupported?.() && ctx.runtime.sample
      ? async (messages: Array<{ role: string; content: unknown }>) => {
        const res = (await ctx.runtime!.sample!({
          messages: messages.map((m) => ({
            role: m.role === "system" ? "user" : m.role,
            content: {
              type: "text",
              text: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
            },
          })),
          maxTokens: 4096,
        })) as CreateMessageResultLike;
        return { content: res.content?.text ?? "" };
      }
      : undefined;

    const design = await runAutoDesign(ctx.userId, project.id, input.task, input.providerId, chatFn ? { chatFn } : undefined);

    return {
      id: project.id,
      name: project.name,
      ...design,
      next: "Review with get_pipeline, adjust with update_pipeline, then run_pipeline.",
    };
  },
};
