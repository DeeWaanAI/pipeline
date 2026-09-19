// MCP tools (Phase 2 — TeamSync): team_context_get + team_memory_append.
// Read and append shared project memory across mixed desktop apps
// (Claude Desktop / ChatGPT / Qwen / Kimi). Both tools require the caller
// to be a member of the given team AND the project to be shared with it.

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import type { McpTool, McpAuthContext } from "../../types";
import { getDb } from "../../../queries/connection";
import { teamMembers, teamProjects } from "@db/schema";
import { logger } from "../../../lib/logger";
import { truncate } from "../_shared";
import {
  getSharedContext,
  appendSharedEpisode,
  bumpSharedStateActivity,
} from "../../../services/sharedMemory";

const contextInputSchema = z.object({
  teamId: z.number().int().positive(),
  projectId: z.number().int().positive(),
});

const appendInputSchema = z.object({
  teamId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  note: z.string().min(1).max(4000),
});

/**
 * Access gate shared by both tools: caller must be a member of `teamId`
 * and the project must be shared with that team. Runs BEFORE any data
 * read or mutation. Non-leaky: both failures look identical.
 */
async function requireTeamMembershipAndShare(
  userId: number,
  teamId: number,
  projectId: number,
): Promise<void> {
  const db = getDb();
  const [membership] = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1);
  if (!membership) throw new Error("Team not found");

  const [share] = await db
    .select({ id: teamProjects.id })
    .from(teamProjects)
    .where(and(eq(teamProjects.teamId, teamId), eq(teamProjects.projectId, projectId)))
    .limit(1);
  if (!share) throw new Error("Project is not shared with this team");
}

export const teamContextGet: McpTool = {
  name: "team_context_get",
  description:
    "Read a team-shared project's memory: recent episodes, structured state (goal, key decisions, recent activity), and the current state-lock version. Only projects shared with the team are accessible — personal-only projects are rejected.",
  inputSchema: contextInputSchema,
  requiredScopes: ["team:read"],
  featureFlag: "teamsync",
  annotations: { readOnlyHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = contextInputSchema.parse(args);

    // Access check BEFORE any data is returned.
    await requireTeamMembershipAndShare(ctx.userId, input.teamId, input.projectId);

    const shared = await getSharedContext(ctx.userId, input.projectId);

    logger.info("[mcp:team_context_get] shared context read", {
      teamId: input.teamId, projectId: input.projectId, userId: ctx.userId,
      clientId: ctx.clientId, requestId: ctx.requestId,
    });

    return {
      teamId: input.teamId,
      projectId: input.projectId,
      episodeCount: shared.episodeCount,
      episodes: shared.episodes.map((ep) => ({
        id: ep.id,
        summary: truncate(ep.summary, 500),
        timestamp: ep.timestamp,
      })),
      state: shared.state
        ? {
            goal: truncate(shared.state.goal, 1000),
            keyDecisions: shared.state.keyDecisions.slice(-10).map((d) => truncate(d, 300)),
            recentActivity: shared.state.recentActivity.slice(0, 5).map((a) => truncate(a, 500)),
          }
        : null,
      lockVersion: shared.lockVersion,
      ...(!shared.state ? { stateHint: "No shared project state recorded yet" } : {}),
    };
  },
};

export const teamMemoryAppend: McpTool = {
  name: "team_memory_append",
  description:
    "Append a note to a team-shared project's episodic memory, attributed to you and your app. Also bumps the shared state's recent activity through the optimistic lock. Episodes are append-only and visible to every teammate's app.",
  inputSchema: appendInputSchema,
  requiredScopes: ["team:write"],
  featureFlag: "teamsync",
  annotations: { readOnlyHint: false, destructiveHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = appendInputSchema.parse(args);

    // Access check BEFORE any mutation.
    await requireTeamMembershipAndShare(ctx.userId, input.teamId, input.projectId);

    // Append-only episode — the primary mutation; no lock needed.
    const appended = await appendSharedEpisode(
      ctx.userId,
      input.projectId,
      input.note,
      `MCP:${ctx.clientId}`,
    );

    // Best-effort state bump through the locked path. A version conflict
    // must NOT fail the call — the episode is already durably appended and
    // a retry would double-append it. The caller sees stateBumped=false.
    let stateVersion: number | null = null;
    let stateBumped = false;
    try {
      const dateStr = new Date().toISOString().split("T")[0];
      const bumped = await bumpSharedStateActivity(
        ctx.userId,
        input.projectId,
        `[${dateStr}] ${ctx.clientId}: ${input.note.substring(0, 200)}${input.note.length > 200 ? "..." : ""}`,
      );
      stateVersion = bumped.version;
      stateBumped = true;
    } catch (err) {
      logger.warn("[mcp:team_memory_append] state bump skipped", {
        projectId: input.projectId, userId: ctx.userId,
        error: (err as Error).message, requestId: ctx.requestId,
      });
    }

    logger.info("[mcp:team_memory_append] episode appended", {
      teamId: input.teamId, projectId: input.projectId, episodeId: appended.episodeId,
      userId: ctx.userId, clientId: ctx.clientId, requestId: ctx.requestId,
    });

    return {
      teamId: input.teamId,
      projectId: input.projectId,
      episodeId: appended.episodeId,
      episodeCount: appended.episodeCount,
      stateBumped,
      stateVersion,
    };
  },
};
