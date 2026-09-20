// Run/project read authorization (offering redesign v2, spec §8.1 A12).
//
// The A12 audit is not only about marketplace runs. Enumerating the read
// surfaces found procedures that take a `swarmRunId`, `responseId` or
// `projectId` and query by that id ALONE — so any authenticated user could read
// (or in two cases, WRITE) another tenant's run data. With protected execution
// that becomes a seller-prompt leak: a buyer run stores its step prompts under
// the BUYER's project, and an unguarded `debug.list(runId)` would show them to
// anyone.
//
// The rule is the one `swarm.getPipeline` already used (owner, or a team the
// project is shared with), stated in ONE place so the remaining surfaces cannot
// each invent their own. Failures report "not found", never "forbidden", so a
// caller cannot probe which ids exist.

import { and, eq } from "drizzle-orm";
import { agentResponses, projects, swarmRuns, teamMembers, teamProjects } from "@db/schema";
import { getDb } from "../queries/connection";

export class NotVisibleError extends Error {
  constructor(kind = "resource") {
    super(`not_found_or_not_authorized: ${kind} is not visible to this account`);
    this.name = "NotVisibleError";
  }
}

/** Same access rule as the pipeline editor: owner, or a team the project was
 *  shared with. No membership ⇒ no visibility, even for a known id. */
export async function canAccessProject(userId: number, projectId: number): Promise<boolean> {
  const db = getDb();
  const [project] = await db.select({ userId: projects.userId }).from(projects)
    .where(eq(projects.id, projectId)).limit(1);
  if (!project) return false;
  if (project.userId === userId) return true;

  const [shared] = await db.select({ id: teamProjects.id })
    .from(teamProjects)
    .innerJoin(teamMembers, eq(teamMembers.teamId, teamProjects.teamId))
    .where(and(eq(teamProjects.projectId, projectId), eq(teamMembers.userId, userId)))
    .limit(1);
  return !!shared;
}

export async function assertProjectVisible(userId: number, projectId: number): Promise<void> {
  if (!(await canAccessProject(userId, projectId))) throw new NotVisibleError("project");
}

/** A run is visible to its owning user or to anyone who can see its project. */
export async function canAccessRun(userId: number, swarmRunId: number): Promise<boolean> {
  const db = getDb();
  const [run] = await db.select({
    userId: swarmRuns.userId, projectId: swarmRuns.projectId,
  }).from(swarmRuns).where(eq(swarmRuns.id, swarmRunId)).limit(1);
  if (!run) return false;
  if (run.userId === userId) return true;
  return canAccessProject(userId, run.projectId);
}

export async function assertRunVisible(userId: number, swarmRunId: number): Promise<void> {
  if (!(await canAccessRun(userId, swarmRunId))) throw new NotVisibleError("run");
}

export async function assertResponseVisible(userId: number, responseId: number): Promise<void> {
  const db = getDb();
  const [row] = await db.select({ projectId: agentResponses.projectId })
    .from(agentResponses).where(eq(agentResponses.id, responseId)).limit(1);
  if (!row) throw new NotVisibleError("response");
  await assertProjectVisible(userId, row.projectId);
}

/** §8.1: a protected (buyer) run is executed by the marketplace service and
 *  read through its buyer projection. The ordinary run-control procedures must
 *  not resume, approve or re-enqueue it, because that path rebuilds run_params
 *  and would lose — and therefore bypass — the protected context. */
export function isProtectedRun(run: { runParams: unknown } | null | undefined): boolean {
  const params = (run?.runParams ?? {}) as { protectedRun?: unknown };
  return !!params.protectedRun;
}

export function assertRunControlAllowed(run: { runParams: unknown } | null | undefined): void {
  if (isProtectedRun(run)) {
    throw new Error(
      "protected_run_read_only: a marketplace run executes through marketplaceExecution.start and is observed through marketplaceExecution.get — it cannot be resumed, approved or re-run from the run endpoints",
    );
  }
}

/** Columns that must never be returned for a protected run, whichever surface
 *  asks. Used by the tests as the explicit list of what "no leakage" means. */
export const PROMPT_BEARING_RUN_COLUMNS = [
  "systemPrompt", "userPrompt", "contextInput",
] as const;
