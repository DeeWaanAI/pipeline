// MCP tools: Data portability (Batch B, auditor recommendation #7).
// No lock-in, from chat: export a pipeline, export everything you own, or
// push a pipeline backup to your connected GitHub repo. Local-folder saving
// needs nothing from us — the user's client-side filesystem tools write the
// returned JSON wherever they choose; the LLM orchestrates both in one ask.
//
// All three delegate to the real tRPC procedures via a server-side caller
// (chat-first rule: chat and web run identical logic).

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import type { McpTool, McpAuthContext } from "../types";
import { getDb } from "../../queries/connection";
import { projects, users } from "@db/schema";
import { logger } from "../../lib/logger";
import { appRouter } from "../../router";
import * as githubService from "../../services/githubService";

async function makeCaller(ctx: McpAuthContext) {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, ctx.userId)).limit(1);
  if (!user) throw new Error("User not found");
  return appRouter.createCaller({
    req: new Request("http://internal/mcp"),
    resHeaders: new Headers(),
    user,
    requestId: `mcp-${crypto.randomUUID()}`,
  });
}

// ═══════════════════════════════════════════════════════════════════
// 1. export_pipeline
// ═══════════════════════════════════════════════════════════════════

const ExportPipelineSchema = z.object({
  projectId: z.number().int().positive(),
});

export const exportPipeline: McpTool = {
  name: "export_pipeline",
  description:
    "Export one of your pipelines as portable JSON (ordered steps + full agent configs, including prompts). Ownership is verified. Hand the returned JSON to your client's filesystem tools to save it anywhere — your data is always exportable.",
  inputSchema: ExportPipelineSchema,
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true, destructiveHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = ExportPipelineSchema.parse(args);
    const caller = await makeCaller(ctx);
    const result = await caller.export.exportPipeline({ projectId: input.projectId });
    logger.info("MCP export_pipeline", { userId: ctx.userId, projectId: input.projectId });
    return {
      ...result,
      message: `Pipeline exported (${result.steps.length} steps). To save it locally, ask your chat client to write this JSON to a file.`,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════
// 2. export_my_data
// ═══════════════════════════════════════════════════════════════════

export const exportMyData: McpTool = {
  name: "export_my_data",
  description:
    "Export ALL your DeeWaanAI data as one portable JSON backup: projects, pipeline steps, custom agents (with prompts), templates, and preferences. No lock-in — this is everything, restorable via the app's import. For large accounts the JSON can be long; ask your client to write it straight to a file.",
  inputSchema: z.object({}),
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true, destructiveHint: false },
  handler: async (_args: unknown, ctx: McpAuthContext) => {
    const caller = await makeCaller(ctx);
    const result = await caller.export.exportAllUserData();
    logger.info("MCP export_my_data", {
      userId: ctx.userId,
      projects: result.projects.length,
      agents: result.customAgents.length,
      templates: result.pipelineTemplates.length,
    });
    return {
      ...result,
      message: `Full backup: ${result.projects.length} projects, ${result.pipelineSteps.length} steps, ${result.customAgents.length} agents, ${result.pipelineTemplates.length} templates. Ask your chat client to write this JSON to a file.`,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════
// 3. sync_to_github
// ═══════════════════════════════════════════════════════════════════

const SyncToGithubSchema = z.object({
  projectId: z.number().int().positive(),
  /** GitHub personal access token with repo write access. Used for this one
   *  call only — never stored, never logged. */
  token: z.string().min(1),
  /** Repo path for the backup file. Default: deewaanai/pipeline-<id>.json */
  path: z.string().max(255).optional(),
  message: z.string().max(200).optional(),
});

export const syncToGithub: McpTool = {
  name: "sync_to_github",
  description:
    "Back up a pipeline to the GitHub repo connected to its project (web app → Project Settings → GitHub). Exports the pipeline JSON and commits it as a file. Requires a GitHub token for this call only — it is never stored.",
  inputSchema: SyncToGithubSchema,
  requiredScopes: ["mcp:write"],
  annotations: { readOnlyHint: false, destructiveHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = SyncToGithubSchema.parse(args);
    const db = getDb();

    const [project] = await db.select().from(projects)
      .where(and(eq(projects.id, input.projectId), eq(projects.userId, ctx.userId)))
      .limit(1);
    if (!project) throw new Error("Project not found or not owned by you");
    if (!project.githubOwner || !project.githubRepo) {
      throw new Error("Project is not connected to GitHub. Connect it in the web app (Project Settings → GitHub) first.");
    }

    const caller = await makeCaller(ctx);
    const exported = await caller.export.exportPipeline({ projectId: input.projectId });

    const path = input.path ?? `deewaanai/pipeline-${input.projectId}.json`;
    const result = await githubService.createOrUpdateFile(
      input.token,
      project.githubOwner,
      project.githubRepo,
      path,
      JSON.stringify(exported, null, 2),
      input.message ?? `DeeWaanAI pipeline backup (project ${input.projectId})`,
      project.githubBranch ?? "main",
    );

    await db.update(projects)
      .set({ lastSyncedAt: new Date() })
      .where(eq(projects.id, input.projectId));

    logger.info("MCP sync_to_github", {
      userId: ctx.userId, projectId: input.projectId,
      repo: `${project.githubOwner}/${project.githubRepo}`, path,
    });
    return {
      success: true,
      repo: `${project.githubOwner}/${project.githubRepo}`,
      branch: project.githubBranch ?? "main",
      path,
      github: result,
      message: `Pipeline committed to ${project.githubOwner}/${project.githubRepo}:${path}. The token you provided was used for this call only.`,
    };
  },
};
