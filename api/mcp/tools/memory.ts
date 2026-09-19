// MCP tools: memory_get + memory_append — project episodic memory and
// structured state summary. Persistence is disk-backed (see ./_memoryStore);
// retrieval/creation reuse api/services/memoryManager, state shape comes from
// api/services/stateSummarizer.

import { z } from "zod";
import type { McpTool, McpAuthContext } from "../types";
import { createEpisode, rotateEpisodes } from "../../services/memoryManager";
import { logger } from "../../lib/logger";
import { requireProjectAccess, truncate } from "./_shared";
import { loadEpisodes, saveEpisodes, loadState } from "./_memoryStore";

const getInputSchema = z.object({
  projectId: z.number().int().positive(),
});

const appendInputSchema = z.object({
  projectId: z.number().int().positive(),
  note: z.string().min(1).max(4000),
});

const MAX_EPISODES_RETURNED = 10;

export const memoryGet: McpTool = {
  name: "memory_get",
  description:
    "Read a project's episodic memory (recent past interactions) and structured state summary (goal, key decisions, recent activity).",
  inputSchema: getInputSchema,
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const { projectId } = getInputSchema.parse(args);

    // Access check BEFORE any data is returned.
    await requireProjectAccess(ctx.userId, projectId);

    const [episodes, state] = await Promise.all([
      loadEpisodes(projectId),
      loadState(projectId),
    ]);

    // Newest first, capped.
    const recent = [...episodes]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, MAX_EPISODES_RETURNED)
      .map((ep) => ({ id: ep.id, summary: truncate(ep.summary, 500), timestamp: ep.timestamp }));

    return {
      projectId,
      episodeCount: episodes.length,
      episodes: recent,
      state: state
        ? {
            goal: truncate(state.goal, 1000),
            keyDecisions: state.keyDecisions.slice(-10).map((d) => truncate(d, 300)),
            recentActivity: state.recentActivity.slice(0, 5).map((a) => truncate(a, 500)),
          }
        : null,
      ...(!state ? { stateHint: "No project state recorded yet" } : {}),
    };
  },
};

export const memoryAppend: McpTool = {
  name: "memory_append",
  description:
    "Append a note to a project's episodic memory so future pipeline runs and memory_get calls can recall it.",
  inputSchema: appendInputSchema,
  requiredScopes: ["mcp:write"],
  annotations: { readOnlyHint: false, destructiveHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const { projectId, note } = appendInputSchema.parse(args);

    // Access check BEFORE any mutation.
    await requireProjectAccess(ctx.userId, projectId);

    const existing = await loadEpisodes(projectId);
    // memoryManager.createEpisode has no role/source fields — the MCP origin
    // is encoded in the answer part of the episode summary instead.
    const episode = createEpisode(note, "User note recorded via MCP", existing);
    const updated = rotateEpisodes([episode, ...existing], 50);
    await saveEpisodes(projectId, updated);

    logger.info("[mcp:memory_append] episode added", {
      projectId, episodeId: episode.id, userId: ctx.userId,
      clientId: ctx.clientId, requestId: ctx.requestId,
    });

    return { projectId, episodeId: episode.id, episodeCount: updated.length };
  },
};
