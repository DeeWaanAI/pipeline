// Pipeline sharing (owner decisions, 2026-09-22): a per-object grant between
// TWO INDIVIDUAL ACCOUNTS — deliberately not a team, a group, a workspace or
// an org. Teams were deleted from this codebase (ticket #26) and nothing here
// reintroduces a `teamId` or a team scope. A share is one row of
// `pipeline_shares` saying "this account lets that named account use this one
// pipeline", in one of two modes:
//
//  * `run_only` — the recipient may RUN the workflow and keep the answer, and
//    may not read the step prompts, the system prompts or the workflow
//    definition. That is exactly the buyer's position in §8.1, so this module
//    reuses the buyer-facing machinery instead of inventing a second one: the
//    run is executed from an immutable snapshot of the GRANTOR's project
//    inside the recipient's own container, the step prompt columns are redacted
//    at the write (`restricted`), and `runAccess.isProtectedRun` recognizes the
//    run so every existing redacted read projection (response chain/byId/
//    byType, export run/backup, the run-control guards) covers it.
//  * `full` — the recipient may also READ the definition, and may edit it only
//    while the grant says `canModify`.
//
// Two invariants the whole design leans on:
//  1. A share never implies ownership. `projects.user_id` and every version's
//     `owner_id` stay with the grantor, and every read of a shared pipeline's
//     definition still passes through `api/services/runAccess`-style "not
//     found" semantics for an outsider.
//  2. A share never implies the right to SELL. Publishing is gated on LINEAGE
//     (`api/services/workflowLineage`), and cloning carries the original
//     creator forward as data, so a recipient — even `full` + `canModify` —
//     is refused at the publish boundary.
//
// Revocation is immediate: `loadAuthorizedSharedSnapshotSteps` re-reads the
// grant row at dispatch, so a share revoked after a run was queued never runs.

import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  agentRuns, agentResponses, llmProviders, pipelineShares, pipelineSteps, pipelineTemplates,
  pipelineVersions, projects, swarmRuns, users,
} from "@db/schema";
import { getDb } from "../queries/connection";
import { logger } from "../lib/logger";
import type { ResolvedStep } from "./swarmService";
import type { VersionDefinition } from "./benchmark/benchmarkTypes";
import type { SharedRunAccessParams } from "./runAccess";
import { resolveProjectLineage, resolveVersionLineage } from "./workflowLineage";

export const PIPELINE_SHARE_POLICY_VERSION = "v2-share-1";

export const SHARE_MODES = ["run_only", "full"] as const;
export type ShareMode = (typeof SHARE_MODES)[number];

export class PipelineShareError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.name = "PipelineShareError";
  }
}

/** What is written into `swarm_runs.run_params.sharedRun`. */
export type SharedRunParams = SharedRunAccessParams;
export const SHARED_RUN_PARAMS_VERSION = PIPELINE_SHARE_POLICY_VERSION;

// ─── Views ─────────────────────────────────────────────────────────

export interface ShareView {
  shareId: number;
  projectId: number;
  projectName: string;
  ownerId: number;
  granteeId: number;
  granteeEmail: string | null;
  mode: ShareMode;
  canModify: boolean;
  state: "active" | "revoked";
  grantedAt: Date;
  revokedAt: Date | null;
  note: string | null;
}

function shareView(row: typeof pipelineShares.$inferSelect, projectName: string, granteeEmail: string | null): ShareView {
  return {
    shareId: row.id,
    projectId: row.projectId,
    projectName,
    ownerId: row.ownerId,
    granteeId: row.granteeId,
    granteeEmail,
    mode: row.accessMode,
    canModify: row.canModify,
    state: row.state,
    grantedAt: row.grantedAt,
    revokedAt: row.revokedAt,
    note: row.note,
  };
}

// ─── Grant lifecycle ───────────────────────────────────────────────

export const sharePipelineInputSchema = z.object({
  projectId: z.number().int().positive().describe("A pipeline YOU own"),
  granteeId: z.number().int().positive().optional().describe("The one account to grant access to"),
  granteeEmail: z.string().email().max(320).optional().describe("…or name them by their exact account email (must match exactly one account)"),
  mode: z.enum(SHARE_MODES).default("run_only").describe("run_only = they can run it and keep the result, never read the prompts or the definition; full = they can also read the definition"),
  canModify: z.boolean().optional().describe("Only with mode='full': lets them edit THIS project. Never implies ownership or a right to publish"),
  note: z.string().max(500).optional(),
}).refine((v) => v.granteeId !== undefined || v.granteeEmail !== undefined, {
  message: "granteeId or granteeEmail is required",
});
export type SharePipelineInput = z.input<typeof sharePipelineInputSchema>;

/** Grant (or re-grant) one pipeline to one named account. Idempotent per
 *  (project, grantee): the pair is unique, so a second call updates the same
 *  grant instead of stacking a second row whose mode could disagree. */
export async function sharePipeline(actorId: number, input: SharePipelineInput): Promise<ShareView> {
  const db = getDb();
  const [project] = await db.select({
    id: projects.id, ownerId: projects.userId, name: projects.name,
  }).from(projects).where(eq(projects.id, input.projectId)).limit(1);
  // Same refusal for "no such project" and "not yours": a share is issued by
  // the owner, and an outsider must not learn the id exists.
  if (!project || project.ownerId !== actorId) throw new PipelineShareError("not_found_or_not_authorized", "pipeline is not available to this account");

  const granteeId = await resolveGrantee(input.granteeId, input.granteeEmail);
  if (granteeId === actorId) throw new PipelineShareError("cannot_share_with_self", "you already own this pipeline — a share is for another account");

  const mode = input.mode ?? "run_only";
  const canModify = input.canModify === true;
  if (mode === "run_only" && canModify) {
    // Refuse instead of silently dropping a privilege the caller asked for:
    // "run it without seeing it" and "rewrite it" are opposite intents.
    throw new PipelineShareError("run_only_cannot_modify", "canModify requires mode='full' — a run_only grant never lets anyone edit or read the definition");
  }

  const [existing] = await db.select().from(pipelineShares)
    .where(and(eq(pipelineShares.projectId, project.id), eq(pipelineShares.granteeId, granteeId)))
    .limit(1);
  if (existing) {
    await db.update(pipelineShares).set({
      accessMode: mode,
      canModify,
      state: "active",
      note: input.note ?? existing.note,
      revokedAt: null,
    }).where(eq(pipelineShares.id, existing.id));
    const [row] = await db.select().from(pipelineShares).where(eq(pipelineShares.id, existing.id)).limit(1);
    logger.info("pipeline share updated", { shareId: row.id, projectId: row.projectId, ownerId: actorId, granteeId, mode, canModify });
    return shareView(row, project.name, await emailOf(granteeId));
  }

  const [inserted] = await db.insert(pipelineShares).values({
    projectId: project.id, ownerId: actorId, granteeId,
    accessMode: mode, canModify, state: "active", note: input.note ?? null,
  });
  const [row] = await db.select().from(pipelineShares)
    .where(eq(pipelineShares.id, Number((inserted as { insertId: number }).insertId))).limit(1);
  logger.info("pipeline share granted", { shareId: row.id, projectId: row.projectId, ownerId: actorId, granteeId, mode, canModify });
  return shareView(row, project.name, await emailOf(granteeId));
}

/** The grantee is one NAMED account: an id, or an email that matches exactly
 *  one account. Never a fuzzy or by-title lookup. */
async function resolveGrantee(granteeId?: number, granteeEmail?: string): Promise<number> {
  const db = getDb();
  if (granteeId !== undefined) {
    const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, granteeId)).limit(1);
    if (!row) throw new PipelineShareError("grantee_not_found", "no account has that id — a share names one real account");
    return row.id;
  }
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, granteeEmail as string)).limit(2);
  if (rows.length === 0) throw new PipelineShareError("grantee_not_found", "no account has that email — a share names one real account");
  if (rows.length > 1) throw new PipelineShareError("grantee_ambiguous", "that email matches more than one account — name the account by its id instead");
  return rows[0].id;
}

async function emailOf(userId: number): Promise<string | null> {
  const [row] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.email ?? null;
}

export const revokeShareInputSchema = z.object({
  shareId: z.number().int().positive(),
});

/** Take the grant back. The row is FLIPPED, not deleted: it stays as the record
 *  that access was given, and every later read filters on `state`. */
export async function revokeShare(actorId: number, input: { shareId: number }): Promise<ShareView & { meaning: string }> {
  const db = getDb();
  const [share] = await db.select().from(pipelineShares).where(eq(pipelineShares.id, input.shareId)).limit(1);
  if (!share || share.ownerId !== actorId) throw new PipelineShareError("not_found_or_not_authorized", "grant is not available to this account");
  if (share.state === "revoked") {
    const [project] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, share.projectId)).limit(1);
    return {
      ...shareView(share, project?.name ?? "", await emailOf(share.granteeId)),
      meaning: "Already revoked — nothing changed, and the grant row is kept as the record that access existed.",
    };
  }
  await db.update(pipelineShares).set({ state: "revoked", revokedAt: new Date() })
    .where(eq(pipelineShares.id, share.id));
  const [row] = await db.select().from(pipelineShares).where(eq(pipelineShares.id, share.id)).limit(1);
  const [project] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, row.projectId)).limit(1);
  logger.info("pipeline share revoked", { shareId: row.id, projectId: row.projectId, granteeId: row.granteeId });
  return {
    ...shareView(row, project?.name ?? "", await emailOf(row.granteeId)),
    meaning: "Access ends now: the grant is re-read at dispatch, so a run that was already queued stops before its first provider call.",
  };
}

export const listSharesInputSchema = z.object({
  projectId: z.number().int().positive().optional(),
});

/** What I shared out, and what was shared with me. A revoked grant is listed
 *  (it is history the user should be able to see) but grants nothing. */
export async function listShares(actorId: number, input: { projectId?: number } = {}): Promise<{
  outgoing: ShareView[];
  incoming: Array<ShareView & { originCreatorId: number }>;
}> {
  const db = getDb();
  const outgoingRows = await db.select().from(pipelineShares)
    .where(and(
      eq(pipelineShares.ownerId, actorId),
      input.projectId ? eq(pipelineShares.projectId, input.projectId) : undefined,
    ))
    .orderBy(desc(pipelineShares.id));
  const incoming = await db.select().from(pipelineShares)
    .where(and(eq(pipelineShares.granteeId, actorId), eq(pipelineShares.state, "active")))
    .orderBy(desc(pipelineShares.id));

  const projectIds = [...new Set([...outgoingRows, ...incoming].map((r) => r.projectId))];
  const granteeIds = [...new Set(outgoingRows.map((r) => r.granteeId))];
  const [projectRows, granteeRows] = await Promise.all([
    projectIds.length
      ? db.select({ id: projects.id, name: projects.name, ownerId: projects.userId, originCreatorId: projects.originCreatorId })
        .from(projects).where(inArray(projects.id, projectIds))
      : Promise.resolve([]),
    granteeIds.length
      ? db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, granteeIds))
      : Promise.resolve([]),
  ]);
  const names = new Map(projectRows.map((p) => [p.id, p.name]));
  const origins = new Map(projectRows.map((p) => [p.id, p.originCreatorId ?? p.ownerId]));
  const emails = new Map(granteeRows.map((g) => [g.id, g.email]));
  return {
    outgoing: outgoingRows.map((r) => shareView(r, names.get(r.projectId) ?? "", emails.get(r.granteeId) ?? null)),
    incoming: incoming.map((r) => ({
      // The grantee of an incoming row is the caller, so their email is not
      // information worth echoing back.
      ...shareView(r, names.get(r.projectId) ?? "", null),
      // Whose work this is, so a recipient can see plainly that a lent
      // pipeline is a loan: publishing stays with that account.
      originCreatorId: origins.get(r.projectId) ?? r.ownerId,
    })),
  };
}

// ─── Access resolution ─────────────────────────────────────────────

export interface GrantAccess {
  project: { id: number; name: string; ownerId: number };
  share: typeof pipelineShares.$inferSelect | null;
  isOwner: boolean;
  mode: ShareMode | "owner";
  /** Entitled to the DEFINITION (prompts, models, gates). A `run_only`
   *  recipient has this false and gets the redacted projection instead. */
  canReadDefinition: boolean;
  canModify: boolean;
  canRun: boolean;
}

/** The ONE place that decides what a share grants. Returns rather than throws
 *  so callers can pick the right refusal for their verb. */
export async function resolveAccess(userId: number, projectId: number): Promise<GrantAccess | null> {
  const db = getDb();
  const [project] = await db.select({
    id: projects.id, name: projects.name, ownerId: projects.userId,
  }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return null;
  if (project.ownerId === userId) {
    return {
      project, share: null, isOwner: true, mode: "owner",
      canReadDefinition: true, canModify: true, canRun: true,
    };
  }
  const [share] = await db.select().from(pipelineShares)
    .where(and(
      eq(pipelineShares.projectId, project.id),
      eq(pipelineShares.granteeId, userId),
      eq(pipelineShares.state, "active"),
    )).limit(1);
  if (!share) return null;
  return {
    project, share, isOwner: false, mode: share.accessMode,
    canReadDefinition: share.accessMode === "full",
    canModify: share.accessMode === "full" && share.canModify,
    canRun: true,
  };
}

/** Reads of a shared pipeline: an outsider gets "not found" (no existence
 *  probe), a `run_only` recipient gets the REDACTED projection below rather
 *  than an error — visible but not readable is the buyer-facing pattern. */
async function requireAccess(userId: number, projectId: number): Promise<GrantAccess> {
  const access = await resolveAccess(userId, projectId);
  if (!access) throw new PipelineShareError("not_found_or_not_authorized", "pipeline is not available to this account");
  return access;
}

// ─── Definition reads and edits ────────────────────────────────────

export const getSharedWorkflowInputSchema = z.object({
  projectId: z.number().int().positive(),
});

export interface SharedWorkflowView {
  projectId: number;
  projectName: string;
  access: ShareMode | "owner";
  canModify: boolean;
  /** The grantor keeps ownership; this is a projection, not a transfer. */
  ownerId: number;
  originCreatorId: number;
  steps: Array<{
    stepOrder: number; name: string; role: string; stepType: string; isEnabled: boolean;
    /** Present only for `full` (and for the owner): the definition itself. */
    systemPrompt?: string;
    model?: string | null;
    temperature?: string | null;
    maxTokens?: number | null;
    ifConfig?: unknown;
    whileConfig?: unknown;
  }>;
  withheld: string | null;
}

/** Read a pipeline someone shared with me. A `run_only` grant sees step
 *  IDENTITY only — the same shape a buyer's progress view has: name, role,
 *  order, enabled. No prompt, no model, no provider reference. */
export async function getSharedWorkflow(userId: number, input: { projectId: number }): Promise<SharedWorkflowView> {
  const access = await requireAccess(userId, input.projectId);
  const db = getDb();
  const steps = await db.select().from(pipelineSteps)
    .where(eq(pipelineSteps.projectId, access.project.id))
    .orderBy(asc(pipelineSteps.stepOrder));
  const lineage = await resolveProjectLineage(access.project.id, db);
  const readable = access.canReadDefinition;

  if (!readable) {
    return {
      projectId: access.project.id,
      projectName: access.project.name,
      access: access.mode,
      canModify: false,
      ownerId: access.project.ownerId,
      originCreatorId: lineage?.originCreatorId ?? access.project.ownerId,
      steps: steps.map((s) => ({
        stepOrder: s.stepOrder, name: s.name, role: s.role, stepType: s.stepType, isEnabled: Boolean(s.isEnabled),
      })),
      withheld: "This pipeline was shared with you to run, not to read: the step prompts, the system prompts, the models and the workflow definition stay with their owner. Ask them for a full share if you need to see it, or run it with run_shared_pipeline and keep the result.",
    };
  }
  return {
    projectId: access.project.id,
    projectName: access.project.name,
    access: access.mode,
    canModify: access.canModify,
    ownerId: access.project.ownerId,
    originCreatorId: lineage?.originCreatorId ?? access.project.ownerId,
    steps: steps.map((s) => ({
      stepOrder: s.stepOrder, name: s.name, role: s.role, stepType: s.stepType, isEnabled: Boolean(s.isEnabled),
      systemPrompt: s.systemPrompt,
      model: s.model,
      temperature: s.temperature,
      maxTokens: s.maxTokens,
      ifConfig: s.ifConfig,
      whileConfig: s.whileConfig,
    })),
    withheld: null,
  };
}

export const sharedStepSchema = z.object({
  name: z.string().min(1).max(100),
  role: z.string().min(1).max(50),
  systemPrompt: z.string().min(1),
  stepType: z.string().max(20).optional(),
  model: z.string().max(100).nullable().optional(),
  temperature: z.string().max(10).optional(),
  maxTokens: z.number().int().positive().optional(),
  isEnabled: z.boolean().optional(),
  ifConfig: z.object({ options: z.array(z.string()), mappings: z.record(z.string(), z.number()) }).nullable().optional(),
  whileConfig: z.object({ targetStep: z.number().int().positive(), maxIterations: z.number().int().positive() }).nullable().optional(),
});

export const updateSharedWorkflowInputSchema = z.object({
  projectId: z.number().int().positive(),
  steps: z.array(sharedStepSchema).min(1).max(30),
});

/**
 * Edit a pipeline someone shared with you — only while the grant says
 * `canModify`, and only the shared project's steps. The write lands on the
 * OWNER's project (that is what editing a shared object means); ownership is
 * not transferred, and the project's `origin_creator_id` is left exactly as it
 * was, so improving borrowed work can never turn it into sellable work.
 */
export async function updateSharedWorkflow(userId: number, input: {
  projectId: number; steps: z.infer<typeof sharedStepSchema>[];
}): Promise<{ projectId: number; stepCount: number; steps: SharedWorkflowView["steps"] }> {
  const access = await requireAccess(userId, input.projectId);
  if (access.mode === "run_only") {
    throw new PipelineShareError("run_only_cannot_modify", "this pipeline was shared with you to run — editing needs a full share with canModify, which only its owner can grant");
  }
  if (!access.canModify) {
    throw new PipelineShareError("share_is_read_only", "this full share lets you read the definition but not change it — ask the owner to turn on canModify");
  }
  const db = getDb();
  const steps = input.steps.map((s) => ({ ...s, stepType: s.stepType ?? "agent" }));
  // Same shape as `pipeline.set`: the project's step rows ARE the mutable
  // definition and are replaced inside one transaction. Immutable versions,
  // runs, responses, purchases and grants are never touched by this.
  await db.transaction(async (tx) => {
    await tx.delete(pipelineSteps).where(eq(pipelineSteps.projectId, access.project.id));
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      await tx.insert(pipelineSteps).values({
        projectId: access.project.id,
        stepOrder: i + 1,
        agentId: null,
        stepType: s.stepType,
        name: s.name,
        role: s.role,
        systemPrompt: s.systemPrompt,
        // The grantee's OWN providers are not the owner's, and a step may not
        // reference a provider its caller does not control: model-only edits.
        providerId: null,
        model: s.model ?? null,
        temperature: s.temperature ?? "0.7",
        maxTokens: s.maxTokens ?? 4096,
        ifConfig: s.ifConfig ?? null,
        whileConfig: s.whileConfig ?? null,
        isEnabled: s.isEnabled ?? true,
      });
    }
  });
  logger.info("shared pipeline edited under a canModify grant", {
    projectId: access.project.id, ownerId: access.project.ownerId, editorId: userId, steps: steps.length,
  });
  const view = await getSharedWorkflow(userId, { projectId: access.project.id });
  return { projectId: access.project.id, stepCount: view.steps.length, steps: view.steps };
}

// ─── Running a shared pipeline ─────────────────────────────────────

export interface SharedRunReceipt {
  swarmRunId: number;
  state: string;
  workflowVersionId: number;
  mode: ShareMode;
  definitionVisibility: "redacted_run_only" | "visible_full";
  returns: string;
}

export const runSharedPipelineInputSchema = z.object({
  projectId: z.number().int().positive(),
  input: z.string().min(1).max(200_000),
  providerId: z.number().int().positive().describe("ONE OF YOUR OWN providers — you pay for your own calls, and the owner's stored provider is never the route"),
  idempotencyKey: z.string().min(1).max(120).optional(),
});

/** The container project that holds the recipient's shared runs. Like the
 *  marketplace buyer container, it stores NO copy of the definition: no steps,
 *  no template, no agent rows. */
async function ensureRunContainer(granteeId: number, projectName: string) {
  const db = getDb();
  const containerName = `Shared pipeline runs — ${projectName}`.slice(0, 200);
  const [existing] = await db.select({ id: projects.id }).from(projects)
    .where(and(eq(projects.userId, granteeId), eq(projects.name, containerName))).limit(1);
  if (existing) return existing.id;
  await db.insert(projects).values({
    userId: granteeId, name: containerName,
    description: "Container for runs of pipelines shared with this account. Contains no workflow definition: each run executes an immutable snapshot owned by the account that shared it.",
  });
  const [created] = await db.select({ id: projects.id }).from(projects)
    .where(and(eq(projects.userId, granteeId), eq(projects.name, containerName)))
    .orderBy(desc(projects.id)).limit(1);
  if (!created) throw new PipelineShareError("container_unavailable", "could not prepare the run container for this shared pipeline");
  return created.id;
}

/** Snapshot the project's current enabled steps and reuse the newest immutable
 *  version with the same definition hash, so repeated runs of an unchanged
 *  pipeline do not each mint a new version row. */
async function snapshotVersionFor(db: ReturnType<typeof getDb>, ownerId: number, projectId: number) {
  const { snapshotStepsFromProject } = await import("./benchmark/versionService");
  const snapshot = await snapshotStepsFromProject(ownerId, projectId);
  const [project] = await db.select({ pipelineConfig: projects.pipelineConfig }).from(projects)
    .where(eq(projects.id, projectId)).limit(1);
  const definition = {
    schemaVersion: 1,
    steps: snapshot.steps,
    pipelineConfig: project?.pipelineConfig ?? null,
    sourceAgentIds: snapshot.sourceAgentIds,
  };
  const canonical = canonicalJson(definition);
  const hash = createHash("sha256").update(canonical).digest("hex");
  const [match] = await db.select({ id: pipelineVersions.id }).from(pipelineVersions)
    .where(and(eq(pipelineVersions.ownerId, ownerId), eq(pipelineVersions.definitionHash, hash)))
    .orderBy(desc(pipelineVersions.id)).limit(1);
  if (match) return match.id;

  const { createVersionRow } = await import("./benchmark/versionService");
  const lineage = await resolveProjectLineage(projectId, db);
  const created = await createVersionRow({
    ownerId,
    sourceProjectId: projectId,
    definition: JSON.parse(canonical),
    designerMethod: "manual",
    // LINEAGE FORWARD, as data: this snapshot is a copy of the project's steps,
    // so it records whoever originally created that work — which is NOT
    // necessarily the account running it, and not necessarily the owner either.
    originCreatorId: lineage?.originCreatorId ?? ownerId,
  });
  return created.versionId;
}

function canonicalJson(value: unknown): string {
  const sortDeep = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortDeep((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(sortDeep(value));
}

/**
 * Run a pipeline someone shared with you. The definition never lands in your
 * own records: an immutable snapshot owned by the GRANTOR is executed inside
 * your container, on YOUR provider, and (for `run_only`) the run is marked
 * restricted so the prompts are redacted at the write.
 */
export async function startSharedRun(input: {
  granteeId: number; projectId: number; input: string; providerId: number; idempotencyKey?: string;
  dispatch?: (swarmRunId: number, granteeId: number) => Promise<void>;
}): Promise<SharedRunReceipt> {
  const db = getDb();
  const trimmed = input.input.trim();
  if (!trimmed) throw new PipelineShareError("input_required", "the run needs an input");
  if (trimmed.length > 200_000) throw new PipelineShareError("input_too_large", "the input exceeds the permitted size");

  const access = await requireAccess(input.granteeId, input.projectId);
  if (!access.canRun || !access.share) {
    // The owner's own runs go through the normal endpoints, which know the
    // project; this entry point exists for a grantee.
    throw new PipelineShareError("not_shared_with_you", "this pipeline is not shared with your account — run your own projects with the ordinary run endpoints");
  }
  const mode = access.share.accessMode;

  const [provider] = await db.select({ id: llmProviders.id }).from(llmProviders)
    .where(and(eq(llmProviders.id, input.providerId), eq(llmProviders.userId, input.granteeId))).limit(1);
  if (!provider) throw new PipelineShareError("not_found_or_not_authorized", "provider is not available to this account");

  const versionId = await snapshotVersionFor(db, access.project.ownerId, access.project.id);
  const containerId = await ensureRunContainer(input.granteeId, access.project.name);

  // Idempotent replay: the same operation key returns the run it already made,
  // so a retry after a dropped connection cannot spend the recipient's credits
  // twice.
  if (input.idempotencyKey) {
    const [prior] = await db.select({ id: swarmRuns.id, status: swarmRuns.status }).from(swarmRuns)
      .where(and(
        eq(swarmRuns.userId, input.granteeId),
        eq(swarmRuns.projectId, containerId),
        sql`JSON_UNQUOTE(JSON_EXTRACT(${swarmRuns.runParams}, '$.sharedRun.idempotencyKey')) = ${input.idempotencyKey}`,
      )).orderBy(desc(swarmRuns.id)).limit(1);
    if (prior) {
      return {
        swarmRunId: prior.id, state: prior.status, workflowVersionId: versionId, mode,
        definitionVisibility: mode === "run_only" ? "redacted_run_only" : "visible_full",
        returns: "Replayed from the same idempotencyKey — nothing was spent twice.",
      };
    }
  }

  const sharedRun: SharedRunParams = {
    shareId: access.share.id, projectId: access.project.id, ownerId: access.project.ownerId,
    granteeId: input.granteeId, workflowVersionId: versionId, mode, providerId: provider.id,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    policyVersion: SHARED_RUN_PARAMS_VERSION,
  };
  const [inserted] = await db.insert(swarmRuns).values({
    projectId: containerId,
    userId: input.granteeId,
    userPrompt: trimmed,
    status: "pending",
    currentStep: "share_queue",
    pipelineVersion: "share-v1",
    runParams: {
      source: "execute", prompt: trimmed, snapshotVersionId: versionId, sharedRun,
      // The recipient's previous outputs in this container must not become
      // "[PREVIOUS WORK]" context for someone else's workflow (same reason the
      // buyer run is stateless).
      stateless: true, memoryMode: "conservative", includeProjectFiles: false,
    },
  });
  const swarmRunId = Number((inserted as { insertId: number }).insertId);
  logger.info("shared pipeline run created", {
    swarmRunId, projectId: access.project.id, ownerId: access.project.ownerId,
    granteeId: input.granteeId, mode, versionId,
  });

  const dispatch = input.dispatch ?? (async (runId: number, granteeId: number) => {
    const { enqueueSwarmRun } = await import("../workers/swarmWorker");
    await enqueueSwarmRun(runId, granteeId);
  });
  try {
    await dispatch(swarmRunId, input.granteeId);
  } catch (err) {
    logger.error("shared pipeline run dispatch failed", { swarmRunId, error: (err as Error).message });
  }
  return {
    swarmRunId, state: "pending", workflowVersionId: versionId, mode,
    definitionVisibility: mode === "run_only" ? "redacted_run_only" : "visible_full",
    returns: mode === "run_only"
      ? "Poll shared_run_status: you get the final output and sanitized progress — never the owner's prompts or the workflow definition."
      : "Poll shared_run_status, or read the run normally: your full share entitles you to the definition.",
  };
}

/**
 * The engine's loader for a shared run (the mirror of
 * `loadAuthorizedSnapshotSteps`). It re-validates against CURRENT rows instead
 * of trusting run_params, so revoking a grant stops an already-queued run
 * before its first provider call, and it pins every step to the recipient's own
 * provider so the grantor's stored binding can never bill them.
 */
export async function loadAuthorizedSharedSnapshotSteps(args: {
  runRow: typeof swarmRuns.$inferSelect;
  callerId: number;
  params: SharedRunParams;
  versionId: number;
}): Promise<{ steps: ResolvedStep[] }> {
  const db = getDb();
  const { params, callerId, versionId } = args;
  // The blob the engine handed us must be the blob on the run row: a caller who
  // passed a hand-built `params` alongside someone else's run gets nothing.
  const onRow = (args.runRow.runParams ?? {}) as { sharedRun?: SharedRunParams };
  if (onRow.sharedRun?.shareId !== params.shareId || onRow.sharedRun?.workflowVersionId !== params.workflowVersionId) {
    throw new PipelineShareError("not_found_or_not_authorized", "run is not available to this account");
  }
  if (callerId !== params.granteeId) {
    throw new PipelineShareError("not_found_or_not_authorized", "run is not available to this account");
  }
  if (params.workflowVersionId !== versionId) {
    throw new PipelineShareError("version_mismatch", "the run's snapshot pointer does not match its share context");
  }
  const [share] = await db.select().from(pipelineShares)
    .where(and(eq(pipelineShares.id, params.shareId), eq(pipelineShares.granteeId, callerId))).limit(1);
  if (!share) throw new PipelineShareError("not_found_or_not_authorized", "grant is not available to this account");
  // The revocation check that makes "immediate" true rather than nominal.
  if (share.state !== "active") {
    throw new PipelineShareError("share_revoked", "the grant for this pipeline was revoked — the run stops before any provider call");
  }
  if (share.projectId !== params.projectId || share.accessMode !== params.mode) {
    throw new PipelineShareError("grant_changed", "the grant behind this run changed after it was queued");
  }
  const [project] = await db.select({ id: projects.id, ownerId: projects.userId }).from(projects)
    .where(eq(projects.id, params.projectId)).limit(1);
  if (!project || project.ownerId !== share.ownerId) {
    throw new PipelineShareError("not_found_or_not_authorized", "pipeline is not available to this account");
  }

  const [provider] = await db.select({ id: llmProviders.id }).from(llmProviders)
    .where(and(eq(llmProviders.id, params.providerId), eq(llmProviders.userId, callerId))).limit(1);
  if (!provider) throw new PipelineShareError("provider_unavailable", "this account's provider binding is gone");

  const [version] = await db.select({
    id: pipelineVersions.id, ownerId: pipelineVersions.ownerId, definition: pipelineVersions.definition,
  }).from(pipelineVersions).where(eq(pipelineVersions.id, versionId)).limit(1);
  if (!version || version.ownerId !== share.ownerId) {
    throw new PipelineShareError("version_unavailable", "the snapshotted version is no longer resolvable to its owner");
  }
  const { resolveSnapshotSteps } = await import("./benchmark/versionService");
  const definition = JSON.parse(String(version.definition)) as VersionDefinition;
  // The recipient runs the workflow on THEIR credential, so the model that
  // serves it is theirs too: the grantor's pinned model name is dropped here
  // exactly as their provider binding is, and the engine resolves the
  // recipient's own default. Sending a grantor-chosen model name to an endpoint
  // the recipient controls would both fail on any host that does not serve that
  // id and disclose a step of the grantor's design.
  const steps = resolveSnapshotSteps(definition).map((s) => ({
    ...s,
    providerId: provider.id,
    model: null,
    agentId: null, // never resolve a grantor-owned customAgent record
  }));
  return { steps };
}

export const sharedRunStatusInputSchema = z.object({ swarmRunId: z.number().int().positive() });

export interface SharedRunView {
  swarmRunId: number;
  projectId: number;
  projectName: string;
  mode: ShareMode;
  status: string;
  finalOutput: string | null;
  progress: Array<{ step: number; name: string; role: string; status: string; tokensUsed: number | null; latencyMs: number | null }>;
  totals: { tokensUsed: number | null; latencyMs: number | null };
  error: string | null;
  visibility: string;
}

/** The recipient's projection of their shared run. Step PROMPT columns are not
 *  selected at all, so there is nothing here to accidentally leak — the same
 *  two bars the buyer view uses (redacted at the write, not read at all here). */
export async function getSharedRunView(opts: { userId: number; swarmRunId: number }): Promise<SharedRunView | null> {
  const db = getDb();
  const [run] = await db.select().from(swarmRuns)
    .where(and(eq(swarmRuns.id, opts.swarmRunId), eq(swarmRuns.userId, opts.userId))).limit(1);
  if (!run) return null;
  const params = (run.runParams ?? {}) as { sharedRun?: SharedRunParams };
  if (!params.sharedRun) return null; // an ordinary run is read through the normal endpoints
  const shared = params.sharedRun;

  const [project] = await db.select({ id: projects.id, name: projects.name }).from(projects)
    .where(eq(projects.id, shared.projectId)).limit(1);
  const [finalRow] = run.finalResponseId
    ? await db.select({ content: agentResponses.content }).from(agentResponses).where(eq(agentResponses.id, run.finalResponseId)).limit(1)
    : [];
  const stepRows = await db.select({
    step: agentRuns.pipelineStep, name: agentRuns.agentName, role: agentRuns.agentRole,
    status: agentRuns.status, tokensUsed: agentRuns.tokensUsed, latencyMs: agentRuns.latencyMs,
  }).from(agentRuns).where(eq(agentRuns.swarmRunId, run.id)).orderBy(agentRuns.id);

  const redacted = shared.mode === "run_only";
  return {
    swarmRunId: run.id,
    projectId: shared.projectId,
    projectName: project?.name ?? "",
    mode: shared.mode,
    status: run.status,
    finalOutput: run.status === "completed" ? (finalRow?.content ?? null) : null,
    progress: stepRows.map((r) => ({
      step: Number(r.step), name: r.name, role: r.role, status: String(r.status),
      tokensUsed: r.tokensUsed === null ? null : Number(r.tokensUsed),
      latencyMs: r.latencyMs === null ? null : Number(r.latencyMs),
    })),
    totals: { tokensUsed: run.totalTokensUsed ?? null, latencyMs: run.totalLatencyMs ?? null },
    error: run.error
      ? redacted
        // The provider's message can quote the request, and on a run_only share
        // that request is the owner's workflow. Category, not text (§8.1).
        ? `shared_run_error: the provider's message is withheld on a run_only share because it can quote the owner's workflow (raw length ${run.error.length}).`
        : run.error
      : null,
    visibility: redacted
      ? "run_only: step prompts, system prompts and the workflow definition were never stored on this run and are not part of this projection."
      : "full: your share entitles you to the definition, so this run is also readable through the ordinary run surfaces.",
  };
}

// ─── Cloning (the path that must not launder provenance) ───────────

export const cloneSharedPipelineInputSchema = z.object({
  projectId: z.number().int().positive().describe("A pipeline shared with you in mode 'full'"),
  name: z.string().min(1).max(200).optional().describe("Name for your copy (defaults to '<source> (copy)')"),
});

export interface CloneResult {
  projectId: number;
  projectName: string;
  templateId: number;
  workflowVersionId: number;
  originCreatorId: number;
  originVersionId: number;
  meaning: string;
}

/**
 * Copy a shared pipeline into your own project. This is the case lineage exists
 * for: the copy is yours to run and to improve, and it is NOT yours to sell —
 * the new project and its first immutable version both record the account that
 * ORIGINALLY created the work, resolved from the source project's own lineage
 * (data, never a title or prompt match).
 */
export async function cloneSharedPipeline(userId: number, input: {
  projectId: number; name?: string;
}): Promise<CloneResult> {
  const access = await requireAccess(userId, input.projectId);
  if (access.mode === "run_only") {
    throw new PipelineShareError("run_only_cannot_clone", "a run_only share lets you run this pipeline, not copy it — cloning needs a full share");
  }
  const db = getDb();
  const [source] = await db.select().from(projects).where(eq(projects.id, access.project.id)).limit(1);
  if (!source) throw new PipelineShareError("not_found_or_not_authorized", "pipeline is not available to this account");
  const sourceLineage = await resolveProjectLineage(source.id, db);
  const originCreatorId = sourceLineage?.originCreatorId ?? source.userId;

  const steps = await db.select().from(pipelineSteps)
    .where(eq(pipelineSteps.projectId, source.id)).orderBy(asc(pipelineSteps.stepOrder));
  if (steps.length === 0) throw new PipelineShareError("nothing_to_clone", "this pipeline has no enabled steps to copy");

  const name = (input.name ?? `${source.name} (copy)`).slice(0, 200);
  const [inserted] = await db.insert(projects).values({
    userId, name, description: source.description,
    // PROVENANCE, as data: whoever originally made this work stays named here
    // even though the project row is owned by the account that copied it.
    originCreatorId,
  });
  const newProjectId = Number((inserted as { insertId: number }).insertId);
  for (const s of steps) {
    await db.insert(pipelineSteps).values({
      projectId: newProjectId,
      stepOrder: s.stepOrder,
      agentId: null, // the source's agent rows belong to another account
      stepType: s.stepType,
      name: s.name,
      role: s.role,
      systemPrompt: s.systemPrompt,
      providerId: null, // ditto for provider bindings
      model: s.model,
      temperature: s.temperature,
      maxTokens: s.maxTokens,
      ifConfig: s.ifConfig,
      whileConfig: s.whileConfig,
      isEnabled: s.isEnabled,
    });
  }
  const [template] = await db.insert(pipelineTemplates).values({
    userId,
    name: `${name} template`.slice(0, 200),
    description: `Template cloned from project ${source.id}`,
    isAuto: false,
    sourceProjectId: newProjectId,
    steps: steps.map((s) => ({
      name: s.name, role: s.role, systemPrompt: s.systemPrompt, stepType: s.stepType,
      ifConfig: s.ifConfig ?? null, whileConfig: s.whileConfig ?? null,
      providerId: null, model: s.model ?? null, temperature: s.temperature ?? "0.7", maxTokens: s.maxTokens ?? 4096,
    })),
  });
  const templateId = Number((template as { insertId: number }).insertId);
  // Link the copy to its template the way a saved pipeline normally is, so the
  // recipient's clone is a complete, runnable object — and so a publish attempt
  // on it reaches the LINEAGE gate instead of dead-ending on a missing template.
  await db.update(projects).set({ pipelineTemplateId: templateId }).where(eq(projects.id, newProjectId));

  const { captureVersionFromProject } = await import("./benchmark/versionService");
  const { versionId } = await captureVersionFromProject(userId, newProjectId);
  const lineage = await resolveVersionLineage(versionId, db);

  return {
    projectId: newProjectId,
    projectName: name,
    templateId,
    workflowVersionId: versionId,
    originCreatorId: lineage?.originCreatorId ?? originCreatorId,
    originVersionId: lineage?.originVersionId ?? versionId,
    meaning: `Your copy runs and reads like your own pipeline, and it stays attributed to account ${lineage?.originCreatorId ?? originCreatorId}: publishing is refused for anyone but that account. A share is a loan, not a licence to sell.`,
  };
}
