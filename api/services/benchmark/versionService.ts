// Immutable workflow versions (offering redesign spec §6.1) — snapshot,
// materialize, and resolve candidate execution bindings. Reused by P2b
// (evaluation candidates) and P3 (protected execution + publication).
//
// A version snapshot is SELF-CONTAINED: agent defaults (provider/model) are
// resolved into the snapshot at capture time, so later edits to the mutable
// agent rows can never alter recorded history, and candidate model overrides
// apply to EVERY model-backed step including if/while gates (spec §4.2).

import { createHash } from "node:crypto";
import { asc, and, eq, inArray, isNull, sql } from "drizzle-orm";
import { customAgents, pipelineSteps, pipelineVersions, projects } from "@db/schema";
import type { ResolvedStep } from "../swarmService";
import { getDb } from "../../queries/connection";
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
  const hash = createHash("sha256").update(stableJson(definition)).digest("hex");
  const [res] = await db.insert(pipelineVersions).values({
    ownerId: userId,
    sourceProjectId: projectId,
    versionNumber: await nextVersionNumberFor(userId, projectId),
    definitionSchemaVersion: 1,
    definition: stableJson(definition),
    definitionHash: hash,
    designerMethod: opts?.designerMethod ?? "manual",
    designerProviderId: opts?.designerProviderId ?? null,
    designerModel: opts?.designerModel ?? null,
    designerPromptVersion: opts?.designerPromptVersion ?? null,
    parentVersionId: opts?.parentVersionId ?? null,
  });
  const versionId = Number((res as { insertId: number }).insertId);
  return { versionId, definition, hash };
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

function stableJson(value: unknown): string {
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
  const db = getDb();
  const hash = createHash("sha256").update(stableJson(overridden)).digest("hex");
  const [res] = await db.insert(pipelineVersions).values({
    ownerId: userId,
    sourceProjectId: version.sourceProjectId,
    versionNumber: await nextVersionNumberFor(userId, version.sourceProjectId ?? null),
    definitionSchemaVersion: 1,
    definition: stableJson(overridden),
    definitionHash: hash,
    designerMethod: version.designerMethod,
    designerProviderId: version.designerProviderId,
    designerModel: candidate.overrideModel ?? version.designerModel,
    designerPromptVersion: version.designerPromptVersion,
    parentVersionId: baseVersionId,
  });
  return Number((res as { insertId: number }).insertId);
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
