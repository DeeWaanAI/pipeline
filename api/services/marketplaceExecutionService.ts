// Protected marketplace execution (offering redesign v2, spec §8.1–§8.3,
// §10.1 `marketplaceExecution.start/get/cancel`). A buyer runs the SELLER's
// immutable workflow version inside a restricted server context — the
// definition is never copied into a buyer-owned template, project, step or
// agent record, and the buyer's view is the final output plus sanitized
// progress.
//
// Admission order is §8.3's, and every check happens BEFORE anything is
// enqueued so a refusal costs no provider calls:
//   authenticate → resolve execution right + version → validate purpose,
//   payer and endpoint (§8.2) → (spend approval / trial reservation: not
//   enabled while v2Commercial is off) → persist the run → dispatch.
//
// The interpreter itself is NOT reimplemented: `swarmService` loads the
// snapshot through `loadAuthorizedSnapshotSteps` below, which re-checks the
// right at dispatch time. A grant revoked between "start" and "execute" stops
// the run there rather than being honored from a stale run_params blob.

import { and, desc, eq, sql } from "drizzle-orm";
import {
  agentResponses, agentRuns, executionGrants, llmProviders, marketplaceListings, marketplaceListingV2,
  marketplacePurchases, pipelineVersions, projects, swarmRuns,
} from "@db/schema";
import type { ExecutionPurpose } from "../../contracts/offeringV2";
import { getDb } from "../queries/connection";
import { logger } from "../lib/logger";
import { isFeatureEnabled } from "../plugins/featureFlags";
import { assertTrustedEgress, PROTECTED_EGRESS_POLICY_VERSION, PROTECTED_EGRESS_RESIDUAL_RISKS, type ApprovedEndpoint } from "./protectedEgress";
import type { ResolvedStep } from "./swarmService";

export const PROTECTED_EXECUTION_POLICY_VERSION = "v2-p3-exec-1";

/** What is written into `swarm_runs.run_params.protectedRun`. */
export interface ProtectedRunParams {
  listingId: number;
  sellerId: number;
  buyerId: number;
  workflowVersionId: number;
  grantId: number | null;
  purchaseId: number | null;
  providerId: number;
  purpose: ExecutionPurpose;
  endpoint: ApprovedEndpoint;
  idempotencyKey?: string;
  policyVersion: string;
}

export class ProtectedExecutionError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.name = "ProtectedExecutionError";
  }
}

/** The listing's currently-sold v2 version, plus the buyer's right to it.
 *  Legacy listings are deliberately NOT routed here: they have no immutable
 *  version to protect, so a v2 protected run cannot exist for them. */
export async function resolveProtectedExecutionRight(opts: {
  buyerId: number;
  listingId: number;
  purpose: ExecutionPurpose;
}): Promise<{
  listing: typeof marketplaceListings.$inferSelect;
  soldVersionId: number;
  sellerId: number;
  grant: typeof executionGrants.$inferSelect | null;
  purchase: typeof marketplacePurchases.$inferSelect | null;
}> {
  const db = getDb();
  const [listing] = await db.select().from(marketplaceListings)
    .where(eq(marketplaceListings.id, opts.listingId)).limit(1);
  if (!listing) throw new ProtectedExecutionError("not_found_or_not_authorized", "listing is not available");
  if (opts.purpose !== "buyer_execution" && opts.purpose !== "trial") {
    throw new ProtectedExecutionError("purpose_not_permitted", `'${opts.purpose}' is not a buyer execution purpose`);
  }
  // §10.2: a v2 listing is buyable only while it publishes evidence; the
  // "certifying" stage belongs to the legacy flow and grants nothing here.
  if (listing.status !== "published") {
    throw new ProtectedExecutionError("listing_not_published", "this listing is not currently available to run");
  }
  const [v2] = await db.select().from(marketplaceListingV2)
    .where(eq(marketplaceListingV2.listingId, listing.id)).limit(1);
  if (v2?.publicationMode !== "v2" || !v2.currentWorkflowVersionId) {
    throw new ProtectedExecutionError("not_a_v2_listing", "protected execution requires a listing published with a v2 workflow version and evidence");
  }
  const soldVersionId = v2.currentWorkflowVersionId;

  const [grant] = await db.select().from(executionGrants)
    .where(and(
      eq(executionGrants.subjectType, "user"),
      eq(executionGrants.subjectId, opts.buyerId),
      eq(executionGrants.listingId, listing.id),
      eq(executionGrants.state, "active"),
    ))
    .orderBy(desc(executionGrants.grantedAt)).limit(1);
  const [purchase] = await db.select().from(marketplacePurchases)
    .where(and(
      eq(marketplacePurchases.buyerId, opts.buyerId),
      eq(marketplacePurchases.listingId, listing.id),
      eq(marketplacePurchases.status, "active"),
    )).limit(1);
  const subscriptionLive = purchase?.isSubscription
    ? !!purchase.subscriptionEnd && new Date(purchase.subscriptionEnd).getTime() > Date.now()
    : true;

  if (!grant && !(purchase && subscriptionLive)) {
    throw new ProtectedExecutionError("not_entitled", "no active execution right for this listing");
  }
  // A grant that names a version must name THE version being sold: an old
  // purchase must not keep running a superseded workflow, and a revoked grant
  // (state != active above) never reaches here.
  if (grant?.workflowVersionId && grant.workflowVersionId !== soldVersionId) {
    throw new ProtectedExecutionError("version_superseded", "the version this right covers is no longer the one the listing sells");
  }
  if (grant?.expiresAt && new Date(grant.expiresAt).getTime() <= Date.now()) {
    throw new ProtectedExecutionError("right_expired", "the execution right has expired");
  }
  return { listing, soldVersionId, sellerId: listing.creatorId, grant: grant ?? null, purchase: purchase ?? null };
}

/**
 * The buyer's run container. `swarm_runs.project_id` is NOT NULL and the
 * interpreter is project-scoped, so a protected run needs one — but it holds no
 * copy of the seller's definition: no steps, no template, no agent rows are
 * created for it, and the snapshot branch never reads project steps.
 */
async function ensureRunContainer(buyerId: number, listingTitle: string) {
  const db = getDb();
  const containerName = `Marketplace runs — ${listingTitle}`.slice(0, 200);
  const [existing] = await db.select().from(projects)
    .where(and(eq(projects.userId, buyerId), eq(projects.name, containerName))).limit(1);
  if (existing) return existing;
  await db.insert(projects).values({
    userId: buyerId, name: containerName,
    description: "Container for protected marketplace runs. Contains no workflow definition: each run executes the seller's immutable published version.",
  });
  const [created] = await db.select().from(projects)
    .where(and(eq(projects.userId, buyerId), eq(projects.name, containerName)))
    .orderBy(desc(projects.id)).limit(1);
  if (!created) throw new ProtectedExecutionError("container_unavailable", "could not prepare the buyer-side run container");
  return created;
}

export interface ProtectedRunReceipt {
  swarmRunId: number;
  state: string;
  reused: boolean;
  protectionClass: "standard" | "reduced";
  endpointClass: "first_party" | "approved_proxy";
  loggingDisclosure: string;
  egressPolicyVersion: string;
  policyVersion: string;
  residualRisks: readonly string[];
  returns: string;
}

/** §10.1 `marketplaceExecution.start`. Buyer BYOK: the payer is always the
 *  buyer, and the endpoint must be approved for protected use. */
export async function startProtectedRun(opts: {
  buyerId: number;
  listingId: number;
  input: string;
  providerId: number;
  purpose?: ExecutionPurpose;
  idempotencyKey?: string;
  dispatch?: (swarmRunId: number, buyerId: number) => Promise<void>;
}): Promise<ProtectedRunReceipt> {
  const db = getDb();
  const purpose: ExecutionPurpose = opts.purpose ?? "buyer_execution";
  if (!(await isFeatureEnabled("v2ProtectedExecution", opts.buyerId))) {
    throw new ProtectedExecutionError("protected_execution_disabled", "the v2ProtectedExecution flag is off for this account");
  }
  if (purpose === "trial" && !(await isFeatureEnabled("v2Commercial", opts.buyerId))) {
    // P4 (trial policy) is unresolved and `v2Commercial` is OFF by policy:
    // trials must not be quietly enabled by an execution refactor.
    throw new ProtectedExecutionError("trial_policy_unresolved", "trial execution needs the approved commercial policy (P4)");
  }
  const trimmed = opts.input.trim();
  if (!trimmed) throw new ProtectedExecutionError("input_required", "the run needs an input");
  if (trimmed.length > 200_000) throw new ProtectedExecutionError("input_too_large", "the input exceeds the permitted size");

  const right = await resolveProtectedExecutionRight({ buyerId: opts.buyerId, listingId: opts.listingId, purpose });
  const [version] = await db.select({ id: pipelineVersions.id, ownerId: pipelineVersions.ownerId })
    .from(pipelineVersions).where(eq(pipelineVersions.id, right.soldVersionId)).limit(1);
  if (!version || version.ownerId !== right.sellerId) {
    throw new ProtectedExecutionError("version_unavailable", "the published version is not resolvable");
  }

  const [provider] = await db.select().from(llmProviders)
    .where(and(eq(llmProviders.id, opts.providerId), eq(llmProviders.userId, opts.buyerId))).limit(1);
  if (!provider) throw new ProtectedExecutionError("not_found_or_not_authorized", "provider is not available to this account");
  // §8.2 — resolved server-side, never trusted from the caller's URL alone.
  const endpoint = await assertTrustedEgress({ provider, payerId: opts.buyerId });

  // Idempotent replay: the same operation key returns the run it already made.
  if (opts.idempotencyKey) {
    const [prior] = await db.select({ id: swarmRuns.id, status: swarmRuns.status }).from(swarmRuns)
      .where(and(
        eq(swarmRuns.userId, opts.buyerId),
        sql`JSON_UNQUOTE(JSON_EXTRACT(${swarmRuns.runParams}, '$.protectedRun.idempotencyKey')) = ${opts.idempotencyKey}`,
      )).orderBy(desc(swarmRuns.id)).limit(1);
    if (prior) {
      return {
        swarmRunId: prior.id, state: prior.status, reused: true,
        protectionClass: endpoint.protectionClass, endpointClass: endpoint.endpointClass,
        loggingDisclosure: endpoint.loggingDisclosure, egressPolicyVersion: PROTECTED_EGRESS_POLICY_VERSION,
        policyVersion: PROTECTED_EXECUTION_POLICY_VERSION, residualRisks: PROTECTED_EGRESS_RESIDUAL_RISKS,
        returns: "Replayed from the same idempotencyKey — nothing was spent twice.",
      };
    }
  }

  const container = await ensureRunContainer(opts.buyerId, right.listing.title);
  const protectedRun: ProtectedRunParams = {
    listingId: right.listing.id, sellerId: right.sellerId, buyerId: opts.buyerId,
    workflowVersionId: right.soldVersionId, grantId: right.grant?.id ?? null,
    purchaseId: right.purchase?.id ?? null, providerId: provider.id, purpose,
    endpoint, idempotencyKey: opts.idempotencyKey, policyVersion: PROTECTED_EXECUTION_POLICY_VERSION,
  };
  const [inserted] = await db.insert(swarmRuns).values({
    projectId: container.id,
    userId: opts.buyerId,
    userPrompt: trimmed,
    status: "pending",
    currentStep: "protected_queue",
    // `swarm_runs.pipeline_version` is varchar(20): "protected-v1" fits,
    // "protected-snapshot-v1" silently failed the insert.
    pipelineVersion: "protected-v1",
    // No attachments, no gitee token, no project files, no memory: a
    // protected run carries ONLY the input and the snapshot pointer (§8.1).
    runParams: {
      source: "execute", prompt: trimmed, snapshotVersionId: right.soldVersionId, protectedRun,
      // `stateless` is what keeps the interpreter from loading the buyer's
      // previous outputs in this container as "[PREVIOUS WORK]" context.
      stateless: true, memoryMode: "conservative", includeProjectFiles: false,
    },
  });
  const swarmRunId = Number((inserted as { insertId: number }).insertId);
  logger.info("protected run created", {
    swarmRunId, listingId: right.listing.id, buyerId: opts.buyerId, sellerId: right.sellerId,
    versionId: right.soldVersionId, endpointId: endpoint.endpointId, protectionClass: endpoint.protectionClass,
  });

  const dispatch = opts.dispatch ?? (async (runId: number, buyerId: number) => {
    const { enqueueSwarmRun } = await import("../workers/swarmWorker");
    await enqueueSwarmRun(runId, buyerId);
  });
  try {
    await dispatch(swarmRunId, opts.buyerId);
  } catch (err) {
    // The run row is the record; a dispatch failure leaves it pending for the
    // reconciler/worker rather than pretending the call happened.
    logger.error("protected run dispatch failed", { swarmRunId, error: (err as Error).message });
  }

  return {
    swarmRunId, state: "pending", reused: false,
    protectionClass: endpoint.protectionClass, endpointClass: endpoint.endpointClass,
    loggingDisclosure: endpoint.loggingDisclosure, egressPolicyVersion: PROTECTED_EGRESS_POLICY_VERSION,
    policyVersion: PROTECTED_EXECUTION_POLICY_VERSION, residualRisks: PROTECTED_EGRESS_RESIDUAL_RISKS,
    returns: "Poll marketplace_run_status: a buyer sees the final output and sanitized step progress — never the workflow definition.",
  };
}

/**
 * The authorized snapshot loader `swarmService` calls for a buyer run
 * (§8.1). Re-validates against CURRENT rows instead of trusting run_params,
 * then pins every step's provider binding to the buyer's own approved provider
 * so a seller's stored providerId can never be the billable route (A14), and
 * strips anything that could reach seller-side tools or files.
 */
export async function loadAuthorizedSnapshotSteps(args: {
  runRow: typeof swarmRuns.$inferSelect;
  callerId: number;
  params: ProtectedRunParams;
  versionId: number;
}): Promise<{ steps: ResolvedStep[]; endpoint: ApprovedEndpoint; sellerId: number }> {
  const db = getDb();
  const { params, callerId, versionId } = args;
  if (callerId !== params.buyerId) {
    throw new ProtectedExecutionError("not_found_or_not_authorized", "run is not available to this account");
  }
  if (params.workflowVersionId !== versionId) {
    throw new ProtectedExecutionError("version_mismatch", "the run's snapshot pointer does not match its protected context");
  }
  const right = await resolveProtectedExecutionRight({ buyerId: callerId, listingId: params.listingId, purpose: params.purpose });

  const [provider] = await db.select().from(llmProviders)
    .where(and(eq(llmProviders.id, params.providerId), eq(llmProviders.userId, callerId))).limit(1);
  if (!provider) throw new ProtectedExecutionError("provider_unavailable", "the buyer's provider binding is gone");
  // Re-checked at dispatch: an endpoint can be withdrawn from the allowlist
  // after a run was queued.
  const endpoint = await assertTrustedEgress({ provider, payerId: callerId });
  if (endpoint.endpointId !== params.endpoint.endpointId || endpoint.baseUrl !== params.endpoint.baseUrl) {
    throw new ProtectedExecutionError("endpoint_changed", "the approved endpoint for this run changed after it was queued");
  }

  const { loadVersionDefinition, resolveSnapshotSteps } = await import("./benchmark/versionService");
  const { version, definition } = await loadVersionDefinition(versionId);
  if (version.ownerId !== right.sellerId || version.id !== right.soldVersionId) {
    throw new ProtectedExecutionError("version_unavailable", "the published version no longer matches the listing");
  }
  const steps = resolveSnapshotSteps(definition).map((s) => ({
    ...s,
    providerId: provider.id,
    agentId: null, // never resolve a seller-owned customAgent record
  }));
  return { steps, endpoint, sellerId: right.sellerId };
}

/** §8.1: the buyer-visible view. Final output plus per-step metadata only —
 *  `agentRuns.systemPrompt`/`userPrompt`/`contextInput` are summaries that
 *  still describe the seller's prompts, so they are never selected here. */
export async function getProtectedRunView(opts: { buyerId: number; swarmRunId: number }): Promise<{
  swarmRunId: number;
  listingId: number;
  status: string;
  finalOutput: string | null;
  progress: Array<{ step: number; name: string; role: string; status: string; tokensUsed: number | null; latencyMs: number | null }>;
  totals: { tokensUsed: number | null; latencyMs: number | null };
  protectionClass: "standard" | "reduced" | null;
  error: string | null;
} | null> {
  const db = getDb();
  const [run] = await db.select().from(swarmRuns)
    .where(and(eq(swarmRuns.id, opts.swarmRunId), eq(swarmRuns.userId, opts.buyerId))).limit(1);
  if (!run) return null;
  const params = (run.runParams ?? {}) as { protectedRun?: ProtectedRunParams };
  if (!params.protectedRun) return null; // a non-protected run is read through the normal endpoints

  const [finalRow] = run.finalResponseId
    ? await db.select({ content: agentResponses.content }).from(agentResponses).where(eq(agentResponses.id, run.finalResponseId)).limit(1)
    : [];
  // Per-step METADATA only. The columns that describe the seller's prompts
  // (`systemPrompt`, `userPrompt`, `contextInput`) are not selected at all, so
  // there is nothing for this read to accidentally redact.
  const steps = await db.select({
    step: agentRuns.pipelineStep,
    name: agentRuns.agentName,
    role: agentRuns.agentRole,
    status: agentRuns.status,
    tokensUsed: agentRuns.tokensUsed,
    latencyMs: agentRuns.latencyMs,
  }).from(agentRuns).where(eq(agentRuns.swarmRunId, opts.swarmRunId)).orderBy(agentRuns.id);

  return {
    swarmRunId: run.id,
    listingId: params.protectedRun.listingId,
    status: run.status,
    finalOutput: run.status === "completed" ? (finalRow?.content ?? null) : null,
    progress: steps.map((r) => ({
      step: Number(r.step), name: r.name, role: r.role, status: String(r.status),
      tokensUsed: r.tokensUsed === null ? null : Number(r.tokensUsed),
      latencyMs: r.latencyMs === null ? null : Number(r.latencyMs),
    })),
    totals: { tokensUsed: run.totalTokensUsed ?? null, latencyMs: run.totalLatencyMs ?? null },
    protectionClass: params.protectedRun.endpoint?.protectionClass ?? null,
    error: run.error ?? null,
  };
}
