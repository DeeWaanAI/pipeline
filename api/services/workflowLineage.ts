// Workflow LINEAGE — who ORIGINALLY created this work (owner decision
// 2026-09-22).
//
// Why this module exists: the tier capability gate that used to stand in front
// of marketplace publishing was deleted with the tier ladder, and that left the
// MCP publish surface with NO gate at all (desktop-pass finding 25: "a
// paid-plan boundary that the MCP surface simply does not enforce"). The
// replacement is not a plan check, it is a provenance check: sharing,
// importing and cloning hand out the right to USE a workflow, never the right
// to SELL it, so publishing evidence or listing a version requires the caller
// to be the account that originally created the work it derives from.
//
// "Original" is DATA, never a lookup by name: `projects.origin_creator_id` and
// `pipeline_versions.origin_creator_id` record an account id, and
// `pipeline_versions.origin_version_id` records the earliest known version of
// the work. Copying a pipeline's steps into a new project carries the pair
// forward. Nothing here compares titles, prompts or hashes for similarity.
//
// EXISTING ROWS: both columns are NULL on everything written before this
// existed, and NULL means "this row's own owner is the original creator". That
// fallback is deliberate — it keeps the benchmarks, versions and the listing
// already in the local database publishable by whoever created them instead of
// newly blocking data nobody migrated.

import { and, desc, eq } from "drizzle-orm";
import { pipelineTemplates, pipelineVersions, projects } from "@db/schema";
import { getDb } from "../queries/connection";

type Db = ReturnType<typeof getDb>;

/** The plain code every lineage refusal carries, so a client can branch on it
 *  without matching prose. */
export const PUBLISH_ORIGIN_CODE = "publish_origin_required";

/** Refusal at the LEGACY listing boundary (`publish_to_marketplace`,
 *  `marketplace.create`): house style is `<code>: <reason> — <what to do
 *  instead>`, the same shape as the eligibility refusals in
 *  `api/services/evidenceService.ts`. */
export function publishOriginListingRefusal(originCreatorId: number): string {
  return `${PUBLISH_ORIGIN_CODE}: only the account that originally created a workflow may list it on the marketplace, `
    + `and this pipeline derives from work originally created by another account (${originCreatorId}) — `
    + `keep running it under the access you were given, and ask that account to publish it themselves.`;
}

/** Refusal at the v2 evidence/version boundary (`publish_evidence_version`,
 *  `marketplace.publishVersion`). */
export function publishOriginVersionRefusal(workflowVersionId: number, originCreatorId: number): string {
  return `${PUBLISH_ORIGIN_CODE}: only the account that originally created a workflow may sell version ${workflowVersionId}, `
    + `and this version derives from work originally created by another account (${originCreatorId}) — `
    + `leave it as a private evaluation, or ask that account to publish it themselves.`;
}

export interface VersionLineage {
  versionId: number;
  ownerId: number;
  /** Whose work this is, resolved: the recorded origin, or the version's own
   *  owner when nothing was recorded (every pre-lineage row). */
  originCreatorId: number;
  /** The earliest known version of this work, or `versionId` itself. */
  originVersionId: number;
  /** True when the row carried no origin data and the owner fallback was used. */
  inferredFromOwner: boolean;
}

/** Pure read of a version row's lineage, with the documented NULL fallback. */
export function lineageOfVersion(version: {
  id: number; ownerId: number; originCreatorId: number | null; originVersionId: number | null;
}): VersionLineage {
  return {
    versionId: version.id,
    ownerId: version.ownerId,
    originCreatorId: version.originCreatorId ?? version.ownerId,
    originVersionId: version.originVersionId ?? version.id,
    inferredFromOwner: version.originCreatorId === null,
  };
}

/** Read a version's lineage, or null when the version does not exist. */
export async function resolveVersionLineage(
  versionId: number,
  executor: Db = getDb(),
): Promise<VersionLineage | null> {
  const [row] = await executor.select({
    id: pipelineVersions.id,
    ownerId: pipelineVersions.ownerId,
    originCreatorId: pipelineVersions.originCreatorId,
    originVersionId: pipelineVersions.originVersionId,
  }).from(pipelineVersions).where(eq(pipelineVersions.id, versionId)).limit(1);
  return row ? lineageOfVersion(row) : null;
}

export interface ProjectLineage {
  projectId: number;
  ownerId: number;
  originCreatorId: number;
  originVersionId: number | null;
  inferredFromOwner: boolean;
  /** The most recent immutable version captured from this project, if any. */
  latestVersionId: number | null;
}

/**
 * A project's lineage: the recorded `origin_creator_id`, or — when it predates
 * lineage — the origin recorded on the newest version captured from it, or
 * finally the project's own owner. The middle arm matters: a project whose
 * versions were written with provenance (by the benchmark/start path, which
 * does not always stamp the project row) still resolves to the true original.
 */
export async function resolveProjectLineage(
  projectId: number,
  executor: Db = getDb(),
): Promise<ProjectLineage | null> {
  const [project] = await executor.select({
    id: projects.id,
    ownerId: projects.userId,
    originCreatorId: projects.originCreatorId,
  }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return null;

  const [latest] = await executor.select({
    id: pipelineVersions.id,
    ownerId: pipelineVersions.ownerId,
    originCreatorId: pipelineVersions.originCreatorId,
    originVersionId: pipelineVersions.originVersionId,
  }).from(pipelineVersions)
    .where(and(eq(pipelineVersions.sourceProjectId, projectId), eq(pipelineVersions.ownerId, project.ownerId)))
    .orderBy(desc(pipelineVersions.id)).limit(1);

  if (project.originCreatorId !== null) {
    return {
      projectId, ownerId: project.ownerId, originCreatorId: project.originCreatorId,
      originVersionId: latest ? (lineageOfVersion(latest).originVersionId) : null,
      inferredFromOwner: false, latestVersionId: latest?.id ?? null,
    };
  }
  if (latest && latest.originCreatorId !== null && latest.originCreatorId !== project.ownerId) {
    return {
      projectId, ownerId: project.ownerId, originCreatorId: latest.originCreatorId,
      originVersionId: lineageOfVersion(latest).originVersionId,
      inferredFromOwner: false, latestVersionId: latest.id,
    };
  }
  return {
    projectId, ownerId: project.ownerId, originCreatorId: project.ownerId,
    originVersionId: latest ? lineageOfVersion(latest).originVersionId : null,
    inferredFromOwner: true, latestVersionId: latest?.id ?? null,
  };
}

/**
 * Who originally created the work behind a would-be listing, from the data the
 * listing is actually built from. `publish_to_marketplace` knows the project;
 * the web `marketplace.create` only knows the template, and a template points
 * at its source project when it was saved from one.
 *
 * Returns the ORIGIN, not the caller: an unresolvable project/template falls
 * back to the account that owns the row it could read, which is exactly the
 * documented pre-lineage behaviour and never a name-based guess.
 */
export async function resolveListingOrigin(opts: {
  userId: number;
  projectId?: number | null;
  templateId: number;
  executor?: Db;
}): Promise<{
  originCreatorId: number; originVersionId: number | null;
  resolvedFrom: "project" | "template_source_project" | "template_owner";
}> {
  const executor = opts.executor ?? getDb();
  const [template] = await executor.select({
    id: pipelineTemplates.id, userId: pipelineTemplates.userId,
    sourceProjectId: pipelineTemplates.sourceProjectId,
  }).from(pipelineTemplates).where(eq(pipelineTemplates.id, opts.templateId)).limit(1);
  if (!template) throw new Error("not_found_or_not_authorized");
  // The ownership check is applied HERE as well as at the call sites, rather
  // than being a promise about how the caller behaves. Without it, a stranger
  // naming someone else's template id was refused with
  // `publish_origin_required: … created by another account (7)` — a refusal that
  // both confirms the row exists and names its creator. The comment below could
  // only ever be a comment; this line is a check.
  if (template.userId !== opts.userId) throw new Error("not_found_or_not_authorized");

  const projectRef = opts.projectId ?? template.sourceProjectId ?? null;
  if (projectRef !== null) {
    const lineage = await resolveProjectLineage(projectRef, executor);
    if (lineage) {
      return {
        originCreatorId: lineage.originCreatorId,
        originVersionId: lineage.originVersionId,
        resolvedFrom: opts.projectId != null ? "project" : "template_source_project",
      };
    }
  }
  return { originCreatorId: template.userId, originVersionId: null, resolvedFrom: "template_owner" };
}

/**
 * THE LISTING GATE: refuse a publish whose caller is not the original creator.
 * The call sites still run their own ownership checks first (this only ever
 * adds a refusal), and the gate repeats the ownership test itself — see
 * `resolveListingOrigin` — so a stranger naming an id it does not own gets the
 * same answer as a non-existent one, whatever the call site forgot to do.
 */
export async function assertOriginalCreatorMayList(opts: {
  userId: number;
  templateId: number;
  projectId?: number | null;
  executor?: Db;
}): Promise<{ originCreatorId: number }> {
  const origin = await resolveListingOrigin(opts);
  if (origin.originCreatorId !== opts.userId) {
    throw new Error(publishOriginListingRefusal(origin.originCreatorId));
  }
  return { originCreatorId: origin.originCreatorId };
}

/**
 * THE VERSION GATE, used by the v2 evidence publication boundary. Same rule:
 * the caller must be the account named by the version's lineage.
 */
export async function assertOriginalCreatorMaySellVersion(opts: {
  userId: number;
  workflowVersionId: number;
  executor?: Db;
}): Promise<VersionLineage> {
  const lineage = await resolveVersionLineage(opts.workflowVersionId, opts.executor);
  if (!lineage) throw new Error("not_found_or_not_authorized");
  // Same hardening as the listing gate: not owning the version is answered
  // exactly like it not existing, so the origin refusal can never be used to
  // confirm somebody else's row or learn who created it.
  if (lineage.ownerId !== opts.userId) throw new Error("not_found_or_not_authorized");
  if (lineage.originCreatorId !== opts.userId) {
    throw new Error(publishOriginVersionRefusal(opts.workflowVersionId, lineage.originCreatorId));
  }
  return lineage;
}

/**
 * Lineage a new version should carry, derived from the parent version and the
 * project row. `createVersionFromProject` in
 * `api/services/benchmark/versionService.ts` is its only caller: without this,
 * the second snapshot of a clone would name the cloner as its origin.
 */
export function inheritLineage(parent: VersionLineage | null | undefined): {
  originCreatorId: number | null; originVersionId: number | null;
} {
  if (!parent) return { originCreatorId: null, originVersionId: null };
  return { originCreatorId: parent.originCreatorId, originVersionId: parent.originVersionId };
}
