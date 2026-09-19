/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SHARED MEMORY SERVICE (Phase 2 — TeamSync)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Team-scoped wrapper over the disk-backed MCP memory store
 * (api/mcp/tools/_memoryStore.ts) plus optimistic concurrency via the
 * `memory_locks` table (migration 012).
 *
 * Rules:
 * - Only TEAM-SHARED projects are readable/writable here — a project the
 *   caller merely owns (personal-only, not shared with any team they belong
 *   to) is rejected.
 * - Episodes are append-only: no lock needed.
 * - State writes use optimistic locking:
 *     UPDATE memory_locks SET version=version+1, last_writer_id=?
 *       WHERE project_id=? AND version=?
 *   affectedRows=0 → conflict (caller must re-read and retry). The lock row
 *   is inserted (version 1) on first use.
 */

import { eq, and, sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { memoryLocks, projects, teamMembers, teamProjects } from "@db/schema";
import { saveFile } from "./projectFilesDisk";
import { createEpisode, rotateEpisodes } from "./memoryManager";
import type { ProjectState } from "./stateSummarizer";
import { loadEpisodes, saveEpisodes, loadState } from "../mcp/tools/_memoryStore";
import { logger } from "../lib/logger";

const STATE_PATH = "memory/state.json";
const MAX_EPISODES = 50;
const MAX_RECENT_ACTIVITY = 5;

export interface SharedContext {
  projectId: number;
  episodeCount: number;
  episodes: Array<{ id: string; summary: string; timestamp: string }>;
  state: ProjectState | null;
  /** Current memory_locks version; null when no state write has happened yet. */
  lockVersion: number | null;
}

/**
 * A project is team-shared for this user when it is shared with at least one
 * team the user belongs to. Personal-only projects (owner access alone) do
 * NOT qualify — TeamSync memory is shared state, not private state.
 */
async function isTeamSharedProject(userId: number, projectId: number): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .innerJoin(teamProjects, eq(teamProjects.teamId, teamMembers.teamId))
    .where(and(
      eq(teamMembers.userId, userId),
      eq(teamProjects.projectId, projectId),
    ))
    .limit(1);
  return !!row;
}

/** Uniform, non-leaky rejection for non-shared projects. */
async function requireTeamSharedProject(userId: number, projectId: number): Promise<void> {
  const shared = await isTeamSharedProject(userId, projectId);
  if (!shared) {
    throw new Error("Project is not shared with any of your teams");
  }
}

/** Read the current lock version without creating the row. */
async function readLockVersion(projectId: number): Promise<number | null> {
  const db = getDb();
  const [row] = await db
    .select({ version: memoryLocks.version })
    .from(memoryLocks)
    .where(eq(memoryLocks.projectId, projectId))
    .limit(1);
  return row?.version ?? null;
}

/**
 * Read team-shared context: episodes (newest first, capped), structured
 * state, and the current optimistic-lock version for state writes.
 */
export async function getSharedContext(userId: number, projectId: number): Promise<SharedContext> {
  await requireTeamSharedProject(userId, projectId);

  const [episodes, state, lockVersion] = await Promise.all([
    loadEpisodes(projectId),
    loadState(projectId),
    readLockVersion(projectId),
  ]);

  return {
    projectId,
    episodeCount: episodes.length,
    episodes: [...episodes]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 20),
    state,
    lockVersion,
  };
}

/**
 * Append an episodic note to the shared project memory. Append-only — no
 * lock required. `origin` (e.g. the MCP clientId) is encoded in the episode
 * summary because the Episode shape has no dedicated source field.
 */
export async function appendSharedEpisode(
  userId: number,
  projectId: number,
  note: string,
  origin: string,
): Promise<{ episodeId: string; episodeCount: number }> {
  await requireTeamSharedProject(userId, projectId);

  const existing = await loadEpisodes(projectId);
  const episode = createEpisode(note, `Team note via ${origin}`, existing);
  const updated = rotateEpisodes([episode, ...existing], MAX_EPISODES);
  await saveEpisodes(projectId, updated);

  logger.info("[sharedMemory] episode appended", {
    projectId, episodeId: episode.id, userId, origin,
  });

  return { episodeId: episode.id, episodeCount: updated.length };
}

/**
 * Insert the lock row (version 1) on first use. Concurrent first-writers
 * race on the primary key — the loser swallows the duplicate-key error and
 * proceeds to the optimistic UPDATE, which then fails with a conflict for
 * exactly one of them.
 */
async function ensureLockRow(projectId: number, userId: number): Promise<number> {
  const db = getDb();
  const existing = await readLockVersion(projectId);
  if (existing !== null) return existing;
  try {
    await db.insert(memoryLocks).values({ projectId, version: 1, lastWriterId: userId });
  } catch {
    // Duplicate key from a racing insert — the row now exists; fall through.
  }
  const version = await readLockVersion(projectId);
  if (version === null) throw new Error("Failed to initialize shared state lock");
  return version;
}

/**
 * Bump shared state recentActivity through the optimistic-lock path:
 * acquire the next version first (UPDATE ... WHERE version=?), then write
 * the state file. affectedRows=0 means someone else wrote between the
 * caller's read and this write → conflict error telling the caller to
 * re-read and retry (never a silent lost write).
 */
export async function bumpSharedStateActivity(
  userId: number,
  projectId: number,
  activityLine: string,
  expectedVersion?: number,
): Promise<{ version: number }> {
  await requireTeamSharedProject(userId, projectId);

  const db = getDb();
  const expected = expectedVersion ?? await ensureLockRow(projectId, userId);

  const result = await db
    .update(memoryLocks)
    .set({ version: sql`${memoryLocks.version} + 1`, lastWriterId: userId })
    .where(and(
      eq(memoryLocks.projectId, projectId),
      eq(memoryLocks.version, expected),
    ));
  if (result[0].affectedRows === 0) {
    throw new Error(
      "Shared project state changed since your last read — re-read with team_context_get and retry",
    );
  }

  // Lock acquired (we own version expected+1) — write the state file.
  let state = await loadState(projectId);
  if (!state) {
    const [project] = await db
      .select({ name: projects.name, description: projects.description })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    state = {
      goal: project?.description || project?.name || "Shared team project",
      keyDecisions: [],
      recentActivity: [],
      openReferences: [],
      longTermSummaries: [],
    };
  }
  state.recentActivity = [activityLine, ...state.recentActivity].slice(0, MAX_RECENT_ACTIVITY);
  await saveFile(projectId, STATE_PATH, JSON.stringify(state, null, 2));

  logger.info("[sharedMemory] state activity bumped", {
    projectId, userId, version: expected + 1,
  });

  return { version: expected + 1 };
}
