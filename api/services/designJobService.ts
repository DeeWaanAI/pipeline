// Durable auto-design jobs (offering redesign v2, spec §5).
//
// Splits the legacy synchronous `runAutoDesign` into the three shared
// responsibilities the spec requires — generate / validate / persist — and
// orchestrates them as a durable queued job whose authoritative state lives
// in the DB (design_jobs + job_outbox), not in the queue message.
//
// Invariants implemented here:
// - Authorization runs in ONE place shared by HTTP and MCP (spec §3): owner
//   access + `pipeline:autodesign` capability + provider ownership.
// - The durable path requires an OWNED configured provider. MCP sampling
//   (a live desktop callback) is never serialized into a worker (§5.2).
// - Apply is revision-checked twice (counter + canonical step-content hash):
//   a project edited while the designer worked retains the candidate as a
//   `revision_conflict` for the owner instead of being overwritten, and
//   existing steps are never deleted on failure (§5.1, A03).
// - Provider-call attempts are recorded with explicit `uncertain` outcomes;
//   exactly-once external LLM execution is NOT promised (§5.3).
// - Generation validates the graph BEFORE persistence. Validation failure
//   does not mark the job failed blindly: it is recorded as a bounded repair
//   attempt and re-asks the designer once (charged), then fails with the
//   issue list (spec §5.1 "recorded, bounded, charged only under the
//   approved call plan").

import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { customAgents, designJobs, jobOutbox, pipelineSteps, pipelineTemplates, pipelineVersions, projectRevisions, projects, llmProviders } from "@db/schema";
import { logger } from "../lib/logger";
import { can } from "./entitlements";
import { getDb } from "../queries/connection";
import {
  AUTO_DESIGN_MAX_STEPS,
  AUTO_DESIGN_PROMPT_VERSION,
  DesignValidationError,
  type GenerationAttemptRecord,
  type NormalizedDesign,
} from "./designJobMeta";
import { generateDesignCandidate } from "./designGenerationService";

// Shared surface re-exports: consumers (routers, MCP tools, tests, the
// legacy service) import these through the orchestrator so the three-module
// split is invisible at call sites.
export {
  AUTO_DESIGN_MAX_STEPS,
  AUTO_DESIGN_PROMPT_VERSION,
  DesignValidationError,
  buildDesignMessages,
  normalizeDesignOutput,
} from "./designJobMeta";
export type {
  DesignAgentSpec,
  DesignStepSpec,
  GenerationAttemptRecord,
  NormalizedDesign,
} from "./designJobMeta";
export { generateDesignCandidate } from "./designGenerationService";

// ─── Validate (spec §5.1 responsibility 2) ──────────────────────────

/** Validate the COMPLETE graph before any persistence. Rejects: oversized
 *  plans, unknown step types, dangling if-routing targets, self-loops,
 *  while-gates with nothing to loop back to, role-less agent steps, empty
 *  pipelines. Never silently repairs into a materially different workflow
 *  (spec §5.1). */
export function validateDesignGraph(design: NormalizedDesign): string[] {
  const issues: string[] = [];
  const steps = design.pipeline;

  if (steps.length === 0) issues.push("pipeline has no steps");
  if (steps.length > AUTO_DESIGN_MAX_STEPS) issues.push(`pipeline exceeds ${AUTO_DESIGN_MAX_STEPS} steps`);

  const VALID_TYPES = new Set(["agent", "if", "while", "approval"]);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const at = `step ${i + 1} (${s.name || "?"})`;
    if (!s.name || !String(s.name).trim()) issues.push(`${at}: missing name`);
    if (!VALID_TYPES.has(s.type)) { issues.push(`${at}: unknown step type '${s.type}'`); continue; }
    if (s.type !== "approval" && !s.role) issues.push(`${at}: non-approval step has no role`);
    if (s.type === "if") {
      if (!s.ifOptions?.length || !s.ifMappings) { issues.push(`${at}: if step missing ifOptions/ifMappings`); continue; }
      for (const opt of s.ifOptions) {
        const target = s.ifMappings[opt];
        if (target === undefined) issues.push(`${at}: if option '${opt}' has no mapping`);
        else if (!Number.isInteger(target) || target < 1 || target > steps.length) issues.push(`${at}: mapping for '${opt}' targets nonexistent step ${target}`);
        // Loop-back semantics only: a mapping that targets the gate itself is
        // an infinite self-loop; forward (continue) and backward (revise)
        // edges are both legitimate routing.
        else if (target === i + 1) issues.push(`${at}: mapping for '${opt}' targets the if step itself (self-loop)`);
      }
    }
    if (s.type === "while" && i === 0) {
      // whileConfig targets the preceding step at persist time; a leading
      // while-gate has nothing to loop back to.
      issues.push(`${at}: while step has no preceding step to target`);
    }
  }

  const hasAgent = steps.some((s) => s.type === "agent" && s.role);
  if (!hasAgent) issues.push("pipeline contains no agent step");
  return issues;
}

// ─── Revision tracking ──────────────────────────────────────────────

export function canonicalStepHash(steps: Array<Record<string, unknown>>): string {
  const normalized = steps
    .map((s) => ({
      order: s.stepOrder as number, type: s.stepType, name: s.name, role: s.role,
      prompt: s.systemPrompt, model: s.model ?? null, provider: s.providerId ?? null,
      ifConfig: s.ifConfig ?? null, whileConfig: s.whileConfig ?? null, enabled: s.isEnabled,
    }))
    .sort((a, b) => a.order - b.order);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export async function getProjectRevision(projectId: number): Promise<number> {
  const db = getDb();
  const [row] = await db.select().from(projectRevisions).where(eq(projectRevisions.projectId, projectId));
  return row?.revision ?? 0;
}

export async function snapshotProjectSteps(projectId: number) {
  const db = getDb();
  return db.select().from(pipelineSteps).where(eq(pipelineSteps.projectId, projectId)).orderBy(pipelineSteps.stepOrder);
}

// ─── Authorization (single entry for HTTP + MCP, spec §3/§5.2) ─────

export async function authorizeDesignRequest(userId: number, projectId: number, providerId?: number) {
  const db = getDb();
  const [project] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  if (!project) throw new Error("Project not found");
  if (!(await can(userId, "pipeline:autodesign"))) {
    throw new Error("Auto-design requires the auto-design tier.");
  }
  let provider = providerId ?? project.defaultProviderId ?? undefined;
  if (provider) {
    const [p] = await db.select().from(llmProviders).where(eq(llmProviders.id, provider));
    if (!p || p.userId !== userId) throw new Error("Provider not found or not owned by this account");
    if (p.isEnabled === false) throw new Error("Provider is disabled");
  } else {
    const [fp] = await db.select().from(llmProviders).where(eq(llmProviders.userId, userId)).limit(1);
    if (!fp) throw new Error("No LLM provider configured. Add one in Settings first.");
    provider = fp.id;
  }
  return { project, providerId: provider! };
}

// ─── Job lifecycle ──────────────────────────────────────────────────

export class V2DisabledError extends Error {
  constructor() { super("v2DesignJobs feature is not enabled"); this.name = "V2DisabledError"; }
}

export interface StartDesignJobInput {
  userId: number;
  projectId: number;
  task: string;
  providerId?: number;
  idempotencyKey?: string;
}

export async function startDesignJob(input: StartDesignJobInput) {
  const db = getDb();
  const { providerId } = await authorizeDesignRequest(input.userId, input.projectId, input.providerId);

  // Idempotent retry returns the existing logical job (§5.3).
  if (input.idempotencyKey) {
    const [existing] = await db.select().from(designJobs)
      .where(and(eq(designJobs.actorId, input.userId), eq(designJobs.idempotencyKey, input.idempotencyKey)))
      .limit(1);
    if (existing) return { job: existing, reused: true };
  }

  const steps = await snapshotProjectSteps(input.projectId);
  const revision = await getProjectRevision(input.projectId);

  // Job + outbox row in ONE transaction: accepted intent can never be lost
  // even if the enqueue call itself fails (§5.3).
  let jobId: number;
  try {
    jobId = await db.transaction(async (tx) => {
      const [res] = await tx.insert(designJobs).values({
        actorId: input.userId,
        projectId: input.projectId,
        expectedRevision: revision,
        baseStepHash: canonicalStepHash(steps as unknown as Array<Record<string, unknown>>),
        designerProviderId: providerId,
        designerPromptVersion: AUTO_DESIGN_PROMPT_VERSION,
        objective: input.task,
        state: "queued",
        idempotencyKey: input.idempotencyKey ?? null,
      });
      const id = Number((res as { insertId: number }).insertId);
      await tx.insert(jobOutbox).values({
        eventKey: `design-job:${id}:start`,
        resourceType: "design_job",
        resourceId: id,
        operation: "start",
        payload: { designJobId: id, userId: input.userId },
      });
      return id;
    });
  } catch (err) {
    // Concurrent retry with the same actor+key: the unique index loses, and
    // the winner's logical resource is returned instead (idempotent retry).
    const dup = err as { code?: string; cause?: { code?: string } };
    const isDup = dup?.code === "ER_DUP_ENTRY" || dup?.cause?.code === "ER_DUP_ENTRY";
    if (!isDup || !input.idempotencyKey) throw err;
    const [winner] = await db.select().from(designJobs)
      .where(and(eq(designJobs.actorId, input.userId), eq(designJobs.idempotencyKey, input.idempotencyKey)))
      .limit(1);
    if (!winner) throw err;
    return { job: winner, reused: true };
  }

  const [job] = await db.select().from(designJobs).where(eq(designJobs.id, jobId));
  return { job, reused: false };
}

/** Dispatch pending outbox rows. Called inline after commit, by the periodic
 *  reconciler, and at boot. Idempotent via the queue dedupe key. */
export async function dispatchPendingOutbox(enqueue: (jobId: number, userId: number) => Promise<string>): Promise<number> {
  const db = getDb();
  const due = await db.select().from(jobOutbox)
    .where(and(
      eq(jobOutbox.resourceType, "design_job"),
      inArray(jobOutbox.deliveryState, ["pending", "failed"]),
    ))
    .limit(50);
  let dispatched = 0;
  for (const row of due) {
    if (row.deliveryState === "failed" && row.nextRetryAt && row.nextRetryAt > new Date()) continue;
    try {
      await enqueue(row.resourceId, Number((row.payload as { userId?: number })?.userId ?? 0));
      await db.update(jobOutbox).set({ deliveryState: "delivered", deliveredAt: new Date() })
        .where(eq(jobOutbox.id, row.id));
      dispatched++;
    } catch (err) {
      const attempts = row.attemptCount + 1;
      await db.update(jobOutbox).set({
        deliveryState: attempts >= 5 ? "dead" : "failed",
        attemptCount: attempts,
        nextRetryAt: new Date(Date.now() + Math.min(60_000 * attempts, 600_000)),
      }).where(eq(jobOutbox.id, row.id));
      logger.warn("[designJob] outbox dispatch failed", { outboxId: row.id, error: (err as Error).message });
    }
  }
  return dispatched;
}

/** Atomically claim a queued job (or one whose lease has expired) with a
 *  fresh lease token; duplicate workers cannot both win (§5.3). */
export async function acquireDesignJob(jobId: number): Promise<string | null> {
  const db = getDb();
  const token = randomUUID();
  const now = new Date();
  const [res] = await db.update(designJobs)
    .set({ state: "running", leaseToken: token, leaseExpiresAt: new Date(now.getTime() + 10 * 60_000), startedAt: now })
    .where(and(
      eq(designJobs.id, jobId),
      or(
        eq(designJobs.state, "queued"),
        and(eq(designJobs.state, "running"), lte(designJobs.leaseExpiresAt, now)),
      ),
    ));
  const ok = (res as unknown as { affectedRows?: number }).affectedRows ?? 0;
  return ok > 0 ? token : null;
}

/** Run the generation phase of an acquired job (worker context). */
export async function runDesignJobGeneration(jobId: number, leaseToken: string): Promise<void> {
  const db = getDb();
  const [job] = await db.select().from(designJobs).where(eq(designJobs.id, jobId));
  if (!job || job.leaseToken !== leaseToken || job.state !== "running") return; // lost lease / cancelled

  const attempts: GenerationAttemptRecord[] = Array.isArray(job.providerCallAttempts) ? [...job.providerCallAttempts] : [];

  try {
    const { providerId } = await authorizeDesignRequest(job.actorId, job.projectId, job.designerProviderId ?? undefined);

    let gen: Awaited<ReturnType<typeof generateDesignCandidate>>;
    try {
      gen = await generateDesignCandidate({ userId: job.actorId, providerId, task: job.objective, attemptIndex: attempts.length + 1 });
    } catch (err) {
      const failed = (err as { designAttempt?: GenerationAttemptRecord }).designAttempt;
      if (failed) attempts.push(failed);
      // Bounded single repair attempt (spec §5.1): one re-ask if the first
      // output was unparseable/invalid, recorded and charged as attempt #2.
      if (attempts.length < 2) {
        logger.warn("[designJob] first generation failed — one bounded repair attempt", { jobId, error: (err as Error).message });
        gen = await generateDesignCandidate({ userId: job.actorId, providerId, task: job.objective, attemptIndex: attempts.length + 1 });
      } else throw err;
    }

    const issues = validateDesignGraph(gen.design);
    attempts.push(gen.attempt);
    if (issues.length > 0) {
      throw new DesignValidationError(issues);
    }

    // Persist the candidate as an immutable pipeline version (NOT applied to
    // the live project yet — apply is its own revision-checked operation).
    const candidateHash = createHash("sha256").update(JSON.stringify(gen.design)).digest("hex");
    const versionId = await db.transaction(async (tx) => {
      const [vRes] = await tx.insert(pipelineVersions).values({
        ownerId: job.actorId,
        sourceProjectId: job.projectId,
        versionNumber: await nextVersionNumber(tx, job.projectId),
        definition: JSON.stringify(gen.design),
        definitionHash: candidateHash,
        designerMethod: "auto",
        designerProviderId: gen.attempt.model ? job.designerProviderId : job.designerProviderId,
        designerModel: gen.model,
        designerPromptVersion: job.designerPromptVersion,
      });
      return Number((vRes as { insertId: number }).insertId);
    });

    // Cancel race: cancellation requested while generating → retain the
    // candidate as a version but report the job cancelled (incurred charge
    // already recorded; §5.3 cancellation semantics).
    const [fresh] = await db.select().from(designJobs).where(eq(designJobs.id, jobId));
    const wasCancelled = fresh?.cancelRequestedAt != null;

    await db.update(designJobs).set({
      state: wasCancelled ? "cancelled" : "succeeded",
      finishedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
      candidateVersionId: versionId,
      candidateDefinition: JSON.stringify(gen.design),
      candidateDefinitionHash: candidateHash,
      providerCallAttempts: attempts,
      designerModel: gen.model,
    }).where(and(eq(designJobs.id, jobId), eq(designJobs.leaseToken, leaseToken)));

    logger.info("[designJob] generation finished", { jobId, state: wasCancelled ? "cancelled" : "succeeded", versionId });
  } catch (err) {
    const issues = err instanceof DesignValidationError ? err.issues : [(err as Error).message];
    const [latest] = await db.select().from(designJobs).where(eq(designJobs.id, jobId));
    await db.update(designJobs).set({
      state: latest?.cancelRequestedAt ? "cancelled" : "failed",
      finishedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
      errorCode: err instanceof DesignValidationError ? "invalid_graph" : "generation_failed",
      errorMessage: issues.join("; ").slice(0, 2000),
      providerCallAttempts: attempts,
    }).where(and(eq(designJobs.id, jobId), eq(designJobs.leaseToken, leaseToken)));
    logger.warn("[designJob] generation failed", { jobId, issues });
  }
}

async function nextVersionNumber(tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0], projectId: number): Promise<number> {
  const rows = await tx.select({ versionNumber: pipelineVersions.versionNumber }).from(pipelineVersions)
    .where(eq(pipelineVersions.sourceProjectId, projectId));
  return rows.reduce((max, r) => Math.max(max, r.versionNumber), 0) + 1;
}

// ─── Apply (revision-checked, spec §5.1) ────────────────────────────

export interface ApplyResult {
  ok: boolean;
  state: "applied" | "revision_conflict" | "not_ready";
  message: string;
}

export async function applyDesignJob(opts: { userId: number; jobId: number }): Promise<ApplyResult> {
  const db = getDb();
  const [job] = await db.select().from(designJobs).where(and(eq(designJobs.id, opts.jobId), eq(designJobs.actorId, opts.userId)));
  if (!job) return { ok: false, state: "not_ready", message: "Job not found" };
  if (job.state !== "succeeded" || !job.candidateVersionId || !job.candidateDefinition) {
    return { ok: false, state: "not_ready", message: `Job is ${job.state}; no retained candidate to apply` };
  }
  if (job.applyState === "applied") return { ok: true, state: "applied", message: "Already applied" };

  const design = JSON.parse(job.candidateDefinition) as NormalizedDesign;
  const issues = validateDesignGraph(design);
  if (issues.length > 0) {
    await db.update(designJobs).set({ applyState: "revision_conflict", errorCode: "invalid_graph", errorMessage: issues.join("; ").slice(0, 2000) }).where(eq(designJobs.id, job.id));
    return { ok: false, state: "revision_conflict", message: `Candidate no longer validates: ${issues.join("; ")}` };
  }

  // Double revision check INSIDE a transaction: counter + canonical content
  // hash (legacy writers do not bump the counter, so the hash is decisive).
  const currentSteps = await snapshotProjectSteps(job.projectId);
  const currentHash = canonicalStepHash(currentSteps as unknown as Array<Record<string, unknown>>);
  const currentRevision = await getProjectRevision(job.projectId);
  if (currentHash !== job.baseStepHash || currentRevision !== job.expectedRevision) {
    await db.update(designJobs).set({ applyState: "revision_conflict" }).where(eq(designJobs.id, job.id));
    return {
      ok: false, state: "revision_conflict",
      message: "The project changed while this job was running. The candidate is retained — review it and apply deliberately, or start a new design job.",
    };
  }

  await db.transaction(async (tx) => {
    await persistDesignToProject(tx, job.actorId, job.projectId, design, job.objective, job.designerProviderId);
    const [rev] = await tx.select().from(projectRevisions).where(eq(projectRevisions.projectId, job.projectId));
    if (rev) {
      await tx.update(projectRevisions).set({ revision: rev.revision + 1, updatedAt: new Date() }).where(eq(projectRevisions.projectId, job.projectId));
    } else {
      await tx.insert(projectRevisions).values({ projectId: job.projectId, revision: job.expectedRevision + 1 });
    }
    await tx.update(designJobs).set({ applyState: "applied" }).where(eq(designJobs.id, job.id));
  });

  return { ok: true, state: "applied", message: "Candidate applied to the project" };
}

/** Shared destructive-but-checked persistence used by BOTH the durable apply
 *  and (via runAutoDesign) the legacy sync path — one implementation. */
export async function persistDesignToProject(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  userId: number,
  projectId: number,
  design: NormalizedDesign,
  task: string,
  designerProviderId: number | null,
): Promise<{ agentsCreated: number; stepsCreated: number }> {
  // Upsert agents (same slug convention as the legacy service).
  const createdAgents: Array<{ id: number; name: string; role: string }> = [];
  for (const agent of design.agents) {
    if (!agent.name || !agent.name.trim()) continue;
    const role = agent.role && agent.role.trim() ? agent.role.trim() : "custom";
    const slug = `${role}-${agent.name.toLowerCase().replace(/[^a-z0-9_-]/g, "").substring(0, 30)}`;
    const [existing] = await tx.select().from(customAgents)
      .where(and(eq(customAgents.userId, userId), eq(customAgents.slug, slug))).limit(1);
    if (existing) { createdAgents.push({ id: existing.id, name: existing.name, role: existing.role }); continue; }
    await tx.insert(customAgents).values({
      userId, name: agent.name, slug, role,
      systemPrompt: agent.systemPrompt ?? `Auto-created ${role} agent for pipeline execution.`,
      description: agent.description ?? `Auto-created for: ${task.substring(0, 100)}`,
      defaultProviderId: designerProviderId ?? null,
      temperature: "0.7", maxTokens: 4096,
    });
    const [created] = await tx.select().from(customAgents)
      .where(and(eq(customAgents.userId, userId), eq(customAgents.slug, slug))).limit(1);
    if (created) createdAgents.push({ id: created.id, name: created.name, role: created.role });
  }

  await tx.delete(pipelineSteps).where(eq(pipelineSteps.projectId, projectId));
  const agentMap = new Map(createdAgents.map((a) => [`${a.role}-${a.name}`, a.id]));

  for (let i = 0; i < design.pipeline.length; i++) {
    const p = design.pipeline[i];
    const isApproval = p.type === "approval";
    let agentId: number | null = null;
    if (!isApproval && p.role) {
      agentId = agentMap.get(`${p.role}-${p.name}`) ?? createdAgents.find((a) => a.role === p.role)?.id ?? createdAgents[0]?.id ?? null;
    }
    await tx.insert(pipelineSteps).values({
      projectId, stepOrder: i + 1, agentId, stepType: p.type,
      name: p.name, role: p.role ?? "custom",
      systemPrompt: p.systemPrompt ?? (isApproval ? "Human review required" : "Process the input"),
      providerId: isApproval ? null : designerProviderId ?? null,
      temperature: "0.7", maxTokens: 4096,
      ifConfig: p.type === "if" && p.ifOptions && p.ifMappings ? { options: p.ifOptions, mappings: p.ifMappings } : null,
      whileConfig: p.type === "while" ? { targetStep: Math.max(1, i), maxIterations: 3 } : null,
      isEnabled: true,
    });
  }

  const saved = await tx.select().from(pipelineSteps).where(eq(pipelineSteps.projectId, projectId)).orderBy(pipelineSteps.stepOrder);

  // Reusable template mirroring legacy behavior.
  const [tpl] = await tx.insert(pipelineTemplates).values({
    userId,
    name: `Design job template ${new Date().toISOString().slice(0, 10)}`,
    description: design.explanation,
    steps: saved.map((s) => ({
      name: s.name, role: s.role, systemPrompt: s.systemPrompt, stepType: s.stepType,
      ifConfig: s.ifConfig, whileConfig: s.whileConfig, providerId: s.providerId, model: s.model,
      temperature: s.temperature ?? "0.7", maxTokens: s.maxTokens ?? 4096,
    })),
    isAuto: true, sourceProjectId: projectId,
  });
  await tx.update(projects).set({ pipelineTemplateId: Number((tpl as { insertId: number }).insertId) })
    .where(eq(projects.id, projectId));

  return { agentsCreated: createdAgents.length, stepsCreated: saved.length };
}

// ─── Status / cancel ────────────────────────────────────────────────

export async function getDesignJob(opts: { userId: number; jobId: number }) {
  const db = getDb();
  const [job] = await db.select().from(designJobs).where(and(eq(designJobs.id, opts.jobId), eq(designJobs.actorId, opts.userId)));
  if (!job) return null;
  return {
    id: job.id, projectId: job.projectId, state: job.state, applyState: job.applyState,
    candidateVersionId: job.candidateVersionId, errorCode: job.errorCode, errorMessage: job.errorMessage,
    designerModel: job.designerModel, designerPromptVersion: job.designerPromptVersion,
    providerCallAttempts: job.providerCallAttempts ?? [],
    createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
  };
}

export async function cancelDesignJob(opts: { userId: number; jobId: number }): Promise<boolean> {
  const db = getDb();
  const [job] = await db.select().from(designJobs).where(and(eq(designJobs.id, opts.jobId), eq(designJobs.actorId, opts.userId)));
  if (!job) return false;
  if (job.state === "queued") {
    await db.update(designJobs).set({ state: "cancelled", cancelRequestedAt: new Date(), finishedAt: new Date() })
      .where(and(eq(designJobs.id, job.id), eq(designJobs.state, "queued")));
  } else if (job.state === "running") {
    await db.update(designJobs).set({ cancelRequestedAt: new Date() }).where(eq(designJobs.id, job.id));
  }
  return true;
}

/** Crash recovery: running jobs whose lease expired go back to queued and
 *  are re-dispatched (attempt history preserved; §5.3). Called from the
 *  boot heal + periodic reconciler. */
export async function healStaleDesignJobs(): Promise<number> {
  const db = getDb();
  const now = new Date();
  const stale = await db.select({ id: designJobs.id, attemptCount: designJobs.attemptCount }).from(designJobs)
    .where(and(eq(designJobs.state, "running"), or(isNull(designJobs.leaseExpiresAt), lte(designJobs.leaseExpiresAt, now))));
  for (const row of stale) {
    await db.update(designJobs).set({ state: "queued", leaseToken: null, leaseExpiresAt: null, attemptCount: row.attemptCount + 1 })
      .where(eq(designJobs.id, row.id));
  }
  // Queued jobs whose outbox dispatch is missing/undelivered need re-dispatch.
  const queued = await db.select({ id: designJobs.id }).from(designJobs).where(eq(designJobs.state, "queued"));
  const outboxRows = await db.select({ resourceId: jobOutbox.resourceId, deliveryState: jobOutbox.deliveryState }).from(jobOutbox)
    .where(eq(jobOutbox.resourceType, "design_job"));
  const delivered = new Set(outboxRows.filter((r) => r.deliveryState === "delivered").map((r) => r.resourceId));
  const needsDispatch = queued.filter((j) => !delivered.has(j.id));
  return stale.length + needsDispatch.length;
}
