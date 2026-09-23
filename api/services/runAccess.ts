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
// The rule is stated in ONE place so the remaining surfaces cannot each invent
// their own: a project (and its runs and responses) is visible to its OWNER
// only. Team sharing was the second arm and was removed with the team features
// (ticket #26); the marketplace purchase arm lives in
// api/services/entitlementSync.ts + api/routers/marketplaceExecution.ts, which
// authorize by entitlement (`pipeline:run:<listingId>`), not by project id.
// The THIRD arm is a per-object pipeline share between two individual accounts
// (api/services/pipelineSharing.ts): it grants a run, and for a `full` share a
// definition read, on ONE named project — it is honoured in that service and
// by `isProtectedRun` below, never by widening owner-only project visibility,
// which would hand a `run_only` recipient the definition too.
// Failures report "not found", never "forbidden", so a caller cannot probe
// which ids exist.

import { eq } from "drizzle-orm";
import { agentResponses, projects, swarmRuns } from "@db/schema";
import { getDb } from "../queries/connection";

export class NotVisibleError extends Error {
  constructor(kind = "resource") {
    super(`not_found_or_not_authorized: ${kind} is not visible to this account`);
    this.name = "NotVisibleError";
  }
}

/** Owner-only visibility. No ownership ⇒ no visibility, even for a known id. */
export async function canAccessProject(userId: number, projectId: number): Promise<boolean> {
  const db = getDb();
  const [project] = await db.select({ userId: projects.userId }).from(projects)
    .where(eq(projects.id, projectId)).limit(1);
  return !!project && project.userId === userId;
}

export async function assertProjectVisible(userId: number, projectId: number): Promise<void> {
  if (!(await canAccessProject(userId, projectId))) throw new NotVisibleError("project");
}

/** A run is visible to its owning user, or to the owner of its project. */
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

/**
 * The `run_params.sharedRun` blob written by `api/services/pipelineSharing.ts`
 * for a run of a PIPELINE ONE ACCOUNT SHARED WITH ANOTHER. Typed structurally
 * here, and not imported, on purpose: this module is the leaf every read
 * surface depends on, and it must not gain a dependency on the sharing service
 * (which depends on it).
 */
export interface SharedRunAccessParams {
  shareId: number;
  /** The shared project, owned by `ownerId` — the recipient's container is
   *  where the run itself lives. */
  projectId: number;
  ownerId: number;
  granteeId: number;
  workflowVersionId: number;
  mode: "run_only" | "full";
  /** The RECIPIENT's own provider, pinned into every step at dispatch so the
   *  grantor's stored binding is never the billable route. */
  providerId: number;
  idempotencyKey?: string;
  policyVersion: string;
}

function runParamsOf(run: { runParams: unknown } | null | undefined): {
  protectedRun?: unknown; sharedRun?: Partial<SharedRunAccessParams> | null;
} {
  return (run?.runParams ?? {}) as { protectedRun?: unknown; sharedRun?: Partial<SharedRunAccessParams> | null };
}

/** §8.1: a protected (buyer) run is executed by the marketplace service and
 *  read through its buyer projection. The ordinary run-control procedures must
 *  not resume, approve or re-enqueue it, because that path rebuilds run_params
 *  and would lose — and therefore bypass — the protected context.
 *
 *  The SAME rule and the SAME projection apply to a `run_only` pipeline share:
 *  the recipient runs another account's workflow and is entitled to the answer
 *  plus sanitized progress, never to the definition. Recognizing it HERE is
 *  what makes every existing redacted surface (response chain/byId/byType,
 *  export run and project backup, the run-control guards) protect a shared run
 *  automatically, instead of a second, forgetable copy of that logic.
 *  A `full` share is NOT redacted: that recipient is entitled to the prompts. */
export function isProtectedRun(run: { runParams: unknown } | null | undefined): boolean {
  const params = runParamsOf(run);
  if (params.protectedRun) return true;
  return params.sharedRun?.mode === "run_only";
}

/** The share context of a run, when it has one. */
export function sharedRunOf(run: { runParams: unknown } | null | undefined): SharedRunAccessParams | null {
  const shared = runParamsOf(run).sharedRun;
  return shared && typeof shared.shareId === "number" ? shared as SharedRunAccessParams : null;
}

export function assertRunControlAllowed(run: { runParams: unknown } | null | undefined): void {
  if (!isProtectedRun(run)) return;
  if (sharedRunOf(run)) {
    // Same code as the marketplace refusal, because it is the same rule: this
    // run's definition belongs to another account and rebuilding its
    // run_params from the run endpoints would drop the protection.
    throw new Error(
      "protected_run_read_only: a shared pipeline run executes through pipelineSharing.run and is observed through pipelineSharing.runStatus — it cannot be resumed, approved or re-run from the run endpoints",
    );
  }
  throw new Error(
    "protected_run_read_only: a marketplace run executes through marketplaceExecution.start and is observed through marketplaceExecution.get — it cannot be resumed, approved or re-run from the run endpoints",
  );
}

/** Columns that must never be returned for a protected run, whichever surface
 *  asks. Used by the tests as the explicit list of what "no leakage" means. */
export const PROMPT_BEARING_RUN_COLUMNS = [
  "systemPrompt", "userPrompt", "contextInput",
] as const;

/** Which model each step pins is part of the workflow definition, not part of
 *  the answer — so a `run_only` recipient must not read it off a step row.
 *  `full` shares and marketplace buyer runs are deliberately NOT covered: a
 *  buyer's own manifest discloses which models ran their input. */
export const MODEL_BEARING_RUN_COLUMNS = ["modelUsed"] as const;

export function withholdsModel(run: { runParams: unknown } | null | undefined): boolean {
  return sharedRunOf(run)?.mode === "run_only";
}