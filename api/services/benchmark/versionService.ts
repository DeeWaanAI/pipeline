// Immutable workflow versions (offering redesign spec §6.1) — snapshot,
// materialize, and resolve candidate execution bindings. Reused by P2b
// (evaluation candidates) and P3 (protected execution + publication).
//
// A version snapshot is SELF-CONTAINED: agent defaults (provider/model) are
// resolved into the snapshot at capture time, so later edits to the mutable
// agent rows can never alter recorded history, and candidate model overrides
// apply to EVERY model-backed step including if/while gates (spec §4.2).

import { createHash } from "node:crypto";
import { asc, and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { customAgents, pipelineSteps, pipelineVersions, projects } from "@db/schema";
import type { ResolvedStep } from "../swarmService";
import { getDb } from "../../queries/connection";
import { inheritLineage, resolveVersionLineage } from "../workflowLineage";
import type { CandidateSpec, SnapshotStep, StepModelResolution, VersionDefinition } from "./benchmarkTypes";

/** Read-only snapshot of a project's enabled steps with agent/project defaults
 *  resolved in. Used by quoting and preflight, which must NEVER write a
 *  pipeline_versions row — only start freezes. */
export async function snapshotStepsFromProject(userId: number, projectId: number): Promise<{
  steps: SnapshotStep[]; sourceAgentIds: Array<number | null>;
}> {
  const db = getDb();
  const [project] = await db.select().from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId))).limit(1);
  if (!project) throw new Error("Project not found");

  const steps = await db.select().from(pipelineSteps)
    .where(and(eq(pipelineSteps.projectId, projectId), eq(pipelineSteps.isEnabled, true)))
    .orderBy(asc(pipelineSteps.stepOrder));
  if (steps.length === 0) throw new Error("Project has no enabled pipeline steps to version");

  const agentIds = steps.map((s) => s.agentId).filter((v): v is number => v != null);
  const agentDefaults = new Map<number, { providerId: number | null; model: string | null }>();
  if (agentIds.length > 0) {
    const rows = await db.select().from(customAgents).where(inArray(customAgents.id, agentIds));
    for (const a of rows) agentDefaults.set(a.id, { providerId: a.defaultProviderId ?? null, model: a.defaultModel ?? null });
  }

  const snapshot: SnapshotStep[] = steps.map((s) => {
    const defs = s.agentId ? agentDefaults.get(s.agentId) : null;
    return {
      stepOrder: s.stepOrder,
      name: s.name,
      role: s.role,
      systemPrompt: s.systemPrompt,
      stepType: s.stepType ?? "agent",
      providerId: s.providerId ?? defs?.providerId ?? project.defaultProviderId ?? null,
      model: s.model ?? defs?.model ?? null,
      temperature: s.temperature ?? "0.7",
      parameters: (s as { parameters?: Record<string, unknown> | null }).parameters ?? null, 
      maxTokens: s.maxTokens ?? 4096,
      ifConfig: (s.ifConfig as SnapshotStep["ifConfig"]) ?? null,
      whileConfig: (s.whileConfig as SnapshotStep["whileConfig"]) ?? null,
    };
  });
  return { steps: snapshot, sourceAgentIds: steps.map((s) => s.agentId ?? null) };
}

export async function captureVersionFromProject(userId: number, projectId: number, opts?: {
  designerMethod?: "manual" | "auto";
  designerProviderId?: number | null;
  designerModel?: string | null;
  designerPromptVersion?: string | null;
  parentVersionId?: number | null;
}): Promise<{ versionId: number; definition: VersionDefinition; hash: string }> {
  const db = getDb();
  const [project] = await db.select().from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId))).limit(1);
  if (!project) throw new Error("Project not found");
  const snapshot = await snapshotStepsFromProject(userId, projectId);

  const definition: VersionDefinition = {
    schemaVersion: 1,
    steps: snapshot.steps,
    pipelineConfig: project.pipelineConfig ?? null,
    sourceAgentIds: snapshot.sourceAgentIds,
  };
  // LINEAGE: a snapshot of a project that was itself cloned from someone else's
  // work records THAT account, not the account clicking "version". And when the
  // project already has a version, the earliest known one keeps being named, so
  // re-snapshotting a clone can never reset its provenance to the copier.
  // `origin_creator_id` NULL on both means "predates lineage", and readers fall
  // back to the owner — which is what keeps every pre-existing version
  // publishable by whoever created it.
  const [prior] = await db.select({ id: pipelineVersions.id }).from(pipelineVersions)
    .where(and(eq(pipelineVersions.ownerId, userId), eq(pipelineVersions.sourceProjectId, projectId)))
    .orderBy(desc(pipelineVersions.id)).limit(1);
  const inherited = inheritLineage(prior ? await resolveVersionLineage(prior.id) : null);
  const created = await createVersionRow({
    ownerId: userId, sourceProjectId: projectId, definition,
    designerMethod: opts?.designerMethod ?? "manual",
    designerProviderId: opts?.designerProviderId ?? null,
    designerModel: opts?.designerModel ?? null,
    designerPromptVersion: opts?.designerPromptVersion ?? null,
    parentVersionId: opts?.parentVersionId ?? null,
    originCreatorId: project.originCreatorId ?? inherited.originCreatorId ?? undefined,
    originVersionId: inherited.originVersionId ?? undefined,
  });
  return { versionId: created.versionId, definition, hash: created.definitionHash };
}

/** Versions are unique per (owner, source project, version number), so the
 *  next number is the MAX over exactly that scope — an unordered "any row"
 *  pick collides on the unique index once a project has several versions. */
async function nextVersionNumberFor(userId: number, projectId: number | null): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ m: sql<number>`coalesce(max(${pipelineVersions.versionNumber}), 0)` })
    .from(pipelineVersions)
    .where(and(
      eq(pipelineVersions.ownerId, userId),
      projectId == null ? isNull(pipelineVersions.sourceProjectId) : eq(pipelineVersions.sourceProjectId, projectId),
    ));
  return Number(rows[0]?.m ?? 0) + 1;
}

export interface NewVersion {
  ownerId: number;
  sourceProjectId: number | null;
  definition: VersionDefinition;
  designerMethod: "manual" | "auto";
  designerProviderId?: number | null;
  designerModel?: string | null;
  designerPromptVersion?: string | null;
  parentVersionId?: number | null;
  /**
   * LINEAGE (owner decision 2026-09-22): the account that ORIGINALLY created
   * the work this version is a snapshot of. Omit it only when the owner really
   * is the origin — when it is omitted and a `parentVersionId` is present, the
   * parent's lineage is inherited, so a materialized override or a re-snapshot
   * of a clone can never quietly launder provenance into the cloner's name.
   * The stored NULL means "predates lineage" and readers fall back to the
   * owner, which is what keeps every pre-existing version publishable.
   */
  originCreatorId?: number | null;
  /** The earliest known version of this work. Inherits the parent's origin
   *  version, so the pointer survives a chain of derivatives. */
  originVersionId?: number | null;
}

const VERSION_NUMBER_RETRIES = 8;

/** The ONLY writer of `pipeline_versions` rows. A benchmark materializes one
 *  version per candidate concurrently, so a read-then-insert of MAX+1 can hand
 *  two inserts the same number; the unique index catches it and we retry.
 *  Never silently reuse the colliding row — every version is a distinct,
 *  evidentiary snapshot. */
export async function createVersionRow(v: NewVersion): Promise<{ versionId: number; definitionHash: string; definition: VersionDefinition }> {
  const db = getDb();
  const definition = stableJson(v.definition);
  const definitionHash = createHash("sha256").update(definition).digest("hex");
  // Provenance is inherited, not re-decided: a derivative of a version whose
  // work belongs to another account keeps belonging to that account.
  const inherited = (v.originCreatorId === undefined || v.originVersionId === undefined) && v.parentVersionId
    ? await resolveVersionLineage(v.parentVersionId)
    : null;
  const originCreatorId = v.originCreatorId ?? inherited?.originCreatorId ?? null;
  const originVersionId = v.originVersionId ?? inherited?.originVersionId ?? null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < VERSION_NUMBER_RETRIES; attempt++) {
    const versionNumber = await nextVersionNumberFor(v.ownerId, v.sourceProjectId ?? null);
    try {
      const [res] = await db.insert(pipelineVersions).values({
        ownerId: v.ownerId,
        sourceProjectId: v.sourceProjectId,
        versionNumber,
        definitionSchemaVersion: 1,
        definition,
        definitionHash,
        designerMethod: v.designerMethod,
        designerProviderId: v.designerProviderId ?? null,
        designerModel: v.designerModel ?? null,
        designerPromptVersion: v.designerPromptVersion ?? null,
        parentVersionId: v.parentVersionId ?? null,
        // Written only when knowable: leaving it NULL keeps the documented
        // "owner is the original creator" fallback intact for rows that were
        // never part of a share or a clone.
        originCreatorId,
        originVersionId,
      });
      return { versionId: Number((res as { insertId: number }).insertId), definitionHash, definition: JSON.parse(definition) as VersionDefinition };
    } catch (err) {
      if ((err as { code?: string }).code !== "ER_DUP_ENTRY") throw err;
      lastError = err;
    }
  }
  throw lastError ?? new Error("Could not allocate a workflow version number");
}

/** Canonical form: keys sorted at every depth, so the same definition always
 *  hashes to the same hex string. Exported because delivery recomputes the hash
 *  of what it is about to write and must use the identical canonical form. */
export function stableJson(value: unknown): string {
  const sortDeep = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortDeep((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(sortDeep(value));
}

export async function loadVersionDefinition(versionId: number): Promise<{ version: typeof pipelineVersions.$inferSelect; definition: VersionDefinition }> {
  const db = getDb();
  const [version] = await db.select().from(pipelineVersions).where(eq(pipelineVersions.id, versionId)).limit(1);
  if (!version) throw new Error("Workflow version not found");
  const definition = JSON.parse(String(version.definition)) as VersionDefinition;
  return { version, definition };
}

/** Materialize a model-override variant of an existing snapshot (used when a
 *  candidate overrides every model-backed step, spec §4.2). Returns a NEW
 *  immutable version; the base version is untouched. */
export async function materializeOverrideVersion(userId: number, baseVersionId: number, candidate: CandidateSpec): Promise<number> {
  if (!candidate.overrideModel && !candidate.overrideProviderId) return baseVersionId;
  const { version, definition } = await loadVersionDefinition(baseVersionId);
  if (version.ownerId !== userId) throw new Error("Workflow version not found");

  const overridden: VersionDefinition = {
    ...definition,
    steps: definition.steps.map((s) => s.stepType === "approval"
      ? s
      : { ...s, model: candidate.overrideModel ?? s.model, providerId: candidate.overrideProviderId ?? s.providerId }),
  };
  const created = await createVersionRow({
    ownerId: userId,
    sourceProjectId: version.sourceProjectId ?? null,
    definition: overridden,
    designerMethod: version.designerMethod === "auto" ? "auto" : "manual",
    designerProviderId: version.designerProviderId,
    designerModel: candidate.overrideModel ?? version.designerModel,
    designerPromptVersion: version.designerPromptVersion,
    parentVersionId: baseVersionId,
  });
  return created.versionId;
}

/** Resolve snapshot steps into the engine's ResolvedStep shape. */
export function resolveSnapshotSteps(definition: VersionDefinition): ResolvedStep[] {
  return definition.steps.map((s) => ({
    stepId: -(s.stepOrder), // negative synthetic IDs: never collide with live pipeline_steps rows
    stepOrder: s.stepOrder,
    name: s.name,
    role: s.role,
    systemPrompt: s.systemPrompt,
    providerId: s.providerId,
    model: s.model,
    temperature: s.temperature,
    maxTokens: s.maxTokens,
    parameters: s.parameters ?? null,
    agentId: null, // snapshot execution is side-effect-free; agent refs live in sourceAgentIds
    stepType: s.stepType,
    ifConfig: s.ifConfig,
    whileConfig: s.whileConfig,
  }));
}

export function stepResolutionsFromSnapshot(definition: VersionDefinition): StepModelResolution[] {
  return definition.steps
    .filter((s) => s.stepType !== "approval")
    .map((s) => ({ stepOrder: s.stepOrder, requestedModel: s.model }));
}

/**
 * The snapshot's one (provider, model) pair, or null when it is not single-routed.
 * A generation child is ledgered as ONE row carrying the summed usage of all its
 * steps, so a dollar figure on that row is only true if every call in it was
 * billed at the same rate — a mixed pipeline stays UNKNOWN rather than being
 * priced at an average that matches no invoice (spec §9).
 *
 * Call-performing steps are every step but `approval` (`stepsToLlmCallCount`
 * uses the same set), and a step with no model runs on the project default we
 * cannot attribute here — either case makes the aggregate unpriceable.
 */
export function singleRouteOfSnapshot(definition: VersionDefinition): { providerRefId: number; model: string } | null {
  const llmSteps = definition.steps.filter((s) => s.stepType !== "approval");
  if (!llmSteps.length) return null;
  const [first] = llmSteps;
  if (typeof first.providerId !== "number" || !first.model) return null;
  if (llmSteps.some((s) => s.providerId !== first.providerId || s.model !== first.model)) return null;
  return { providerRefId: first.providerId, model: first.model };
}
