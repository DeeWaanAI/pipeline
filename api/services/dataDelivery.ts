// D14 — deliver work data to the client's folder, then sweep the server copy.
//
// The decision (DeeWaanAI-Next/OFFERING-REDESIGN-TECH-SPECS.md, D14, resolves
// P8) shapes everything below: execution stays server-side, the user's work
// data is delivered to a folder they choose and WRITTEN BY THEIR CHAT CLIENT,
// and then swept from the platform. Because the client does the writing, the
// server's job is exactly two calls:
//
//   deliverWorkData()     ONE complete bundle (the D14 groundwork measurement in
//                         V2-CHECKPOINT.md sized it at ~180 KB per account, so it
//                         fits a single response — no pagination, no streaming
//                         job, no worker), plus a sha256 of the canonical JSON so
//                         a client can answer "is this the copy I wrote to disk?"
//                         and notice when it just re-wrote identical bytes.
//   sweepDeliveredData()  the user's explicit instruction to clear the server
//                         copy of EXACTLY what that receipt delivered.
//
// "Our servers are a workspace, not an archive" is only true if the sweep
// exists, so retention is a feature here rather than a cleanup job — but a
// feature with a hard boundary. Device-primary (sweepable) is CONTENT: the run
// input text, the step prompts and outputs, the response bodies, the private
// benchmark body. Server-authoritative (never touched under any scope) is the
// RECORD: published versions, evidence manifests, purchases and execution
// rights, the cost ledger, consent and withdrawal records. A sweep therefore
// strips content columns and NEVER deletes a row: ids, timestamps,
// token/latency/cost numbers and hashes stay so the ledger and any published
// evidence still reconcile to a run that happened (design rule 4).
//
// The safety rules, in order of how much they cost to get wrong:
//  1. Deliver first, sweep second, and never sweep what was not delivered. The
//     sweep takes the signed receipt the delivery returned (which carries the
//     scope, the bundle hash and the account it was minted for) plus an
//     explicit confirmation phrase, then RE-DERIVES that scope and refuses
//     unless the content hash still matches. No receipt, no confirmation, or a
//     server copy that moved since delivery ⇒ nothing is deleted.
//  2. Ownership is per row, through the caller's own user id on the owning row
//     (`swarm_runs.user_id`, `benchmarks.owner_id`, `projects.user_id`), never
//     through an id the caller supplies alone. Unknown and unowned answer
//     identically, so nothing here can be probed for existence.
//  3. A run that involves someone else's interest is not sweepable — and not
//     even deliverable as content: a protected marketplace (buyer) run and a
//     shared-pipeline run both carry a seller's or grantor's definition and
//     evidence. Recognized ONLY through `api/services/runAccess`
//     (`isProtectedRun`, `sharedRunOf`), which is where that rule lives; this
//     module never re-derives a mode out of `run_params`.
//  4. `swarm_runs.run_params` keeps existing. It holds the share/protection
//     context runAccess reads to keep enforcing rule 3, so blanking the column
//     would silently weaken the privacy invariant. Only its `prompt` key — a
//     verbatim duplicate of the delivered `user_prompt` — is replaced in place.
//     `attachments` and `giteeTokenEnc` are deliberately untouched: the bundle
//     carries no attachment bytes, so rule 1 forbids sweeping them.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, count, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  agentResponses, agentRuns, benchmarkCandidates, benchmarkCases, benchmarkJudgments,
  benchmarkRuns, benchmarks, callAttempts, evidencePublications, executionGrants,
  marketplacePurchases, pipelineVersions, projects, spendApprovals, swarmRuns,
  userPrivacyConsent,
} from "@db/schema";
import { getDb } from "../queries/connection";
import { logger } from "../lib/logger";
import { env } from "../lib/env";
import { canonicalJson } from "./auditExport";
import { benchmarkLedgerTotals } from "./benchmark/benchmarkLedger";
import { assertProjectVisible, isProtectedRun, sharedRunOf } from "./runAccess";

type Db = ReturnType<typeof getDb>;

/** Bumped when the bundle's SHAPE changes, so a client can tell an old folder
 *  layout from a new one instead of silently merging the two. */
export const DATA_DELIVERY_BUNDLE_VERSION = 1;

/** The confirmation a caller must repeat. A phrase rather than a boolean so a
 *  UI cannot default it to true on the user's behalf. */
export const SWEEP_CONFIRM_PHRASE = "delete-server-copy" as const;

/** What a swept content column holds afterwards. NOT NULL columns cannot be
 *  emptied, so they carry the marker with the bundle hash in it: a row on the
 *  server then names which delivered copy replaced its content. */
export const SWEPT_MARKER_PREFIX = "[swept by D14 delivery: this content was handed to the account's device, bundle sha256=";
export const SWEPT_MARKER_SUFFIX = "]";

/** Receipt token prefix — versioned, so a future format can never be mistaken
 *  for this one by a client holding an old token. */
const RECEIPT_PREFIX = "dwd1";

export class DataDeliveryError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.name = "DataDeliveryError";
  }
}

/**
 * Everything a sweep writes, named in ONE place so the bundle, the receipt and
 * the tests talk about the same list. `mode` says what the column holds
 * afterwards: `null` is provably gone to any reader, `marker` is the NOT NULL
 * compromise.
 */
export const SWEEPABLE_CONTENT_COLUMNS = [
  { table: "swarm_runs", column: "user_prompt", mode: "marker" },
  // The approval-pause rehydration payload: `chain[].content` and
  // `pendingApproval.lastOutput` are verbatim copies of step outputs, so
  // leaving them would keep the work data on the server behind a claim that it
  // was swept. Dropped whole rather than partially rewritten — everything it
  // holds is either content or execution bookkeeping for a run that can no
  // longer be resumed.
  { table: "swarm_runs", column: "execution_state", mode: "null" },
  { table: "swarm_runs", column: "error", mode: "null" },
  // IN PLACE, not blanked (design rule 4): `prompt` duplicates the delivered
  // `user_prompt`, so this is the one key of the JSON document that is content.
  { table: "swarm_runs", column: "run_params.prompt", mode: "marker" },
  { table: "agent_runs", column: "system_prompt", mode: "null" },
  { table: "agent_runs", column: "user_prompt", mode: "marker" },
  { table: "agent_runs", column: "context_input", mode: "null" },
  { table: "agent_responses", column: "content", mode: "marker" },
  { table: "agent_responses", column: "human_notes", mode: "null" },
  { table: "benchmark_cases", column: "input_text", mode: "null" },
  { table: "benchmark_cases", column: "expected_output", mode: "null" },
  { table: "benchmark_cases", column: "provenance_notes", mode: "null" },
  { table: "benchmark_candidates", column: "baseline_prompt", mode: "null" },
  { table: "benchmark_runs", column: "output_text", mode: "null" },
  { table: "benchmark_judgments", column: "rationale", mode: "null" },
] as const;

/** Never swept, under any scope — the server-authoritative record from D14.
 *  Counted whole-table before and after every sweep, so the receipt's promise is
 *  measured rather than asserted. `rows` is a whole-table COUNT: "the caller's
 *  rows are unchanged" would be a weaker claim than the one the offering makes.
 */
const NEVER_SWEPT_TABLES: ReadonlyArray<{ table: string; rows: () => Promise<number> }> = [
  { table: "pipeline_versions", rows: async () => (await getDb().select({ total: count() }).from(pipelineVersions))[0]?.total ?? 0 },
  { table: "evidence_publications", rows: async () => (await getDb().select({ total: count() }).from(evidencePublications))[0]?.total ?? 0 },
  { table: "marketplace_purchases", rows: async () => (await getDb().select({ total: count() }).from(marketplacePurchases))[0]?.total ?? 0 },
  { table: "execution_grants", rows: async () => (await getDb().select({ total: count() }).from(executionGrants))[0]?.total ?? 0 },
  { table: "call_attempts", rows: async () => (await getDb().select({ total: count() }).from(callAttempts))[0]?.total ?? 0 },
  { table: "spend_approvals", rows: async () => (await getDb().select({ total: count() }).from(spendApprovals))[0]?.total ?? 0 },
  { table: "user_privacy_consent", rows: async () => (await getDb().select({ total: count() }).from(userPrivacyConsent))[0]?.total ?? 0 },
];

/** The swept tables, counted the same way: a sweep removes CONTENT, never a
 *  row, so these numbers must be identical before and after as well. */
const ROWS_NEVER_DELETED: ReadonlyArray<{ table: string; rows: () => Promise<number> }> = [
  { table: "swarm_runs", rows: async () => (await getDb().select({ total: count() }).from(swarmRuns))[0]?.total ?? 0 },
  { table: "agent_runs", rows: async () => (await getDb().select({ total: count() }).from(agentRuns))[0]?.total ?? 0 },
  { table: "agent_responses", rows: async () => (await getDb().select({ total: count() }).from(agentResponses))[0]?.total ?? 0 },
  { table: "benchmarks", rows: async () => (await getDb().select({ total: count() }).from(benchmarks))[0]?.total ?? 0 },
  { table: "benchmark_cases", rows: async () => (await getDb().select({ total: count() }).from(benchmarkCases))[0]?.total ?? 0 },
  { table: "benchmark_candidates", rows: async () => (await getDb().select({ total: count() }).from(benchmarkCandidates))[0]?.total ?? 0 },
  { table: "benchmark_runs", rows: async () => (await getDb().select({ total: count() }).from(benchmarkRuns))[0]?.total ?? 0 },
  { table: "benchmark_judgments", rows: async () => (await getDb().select({ total: count() }).from(benchmarkJudgments))[0]?.total ?? 0 },
  { table: "projects", rows: async () => (await getDb().select({ total: count() }).from(projects))[0]?.total ?? 0 },
];

// ─── scope ───────────────────────────────────────────────────────────

export type DeliveryScope =
  | { kind: "project"; projectId: number }
  | { kind: "run"; swarmRunId: number }
  | { kind: "benchmark"; benchmarkId: number }
  | { kind: "account" };

export interface DeliverWorkDataInput {
  projectId?: number;
  swarmRunId?: number;
  benchmarkId?: number;
  accountWide?: boolean;
}

export const deliverWorkDataInputSchema = z.object({
  projectId: z.number().int().positive().optional()
    .describe("Every sweepable run in ONE project of yours"),
  swarmRunId: z.number().int().positive().optional()
    .describe("One run of yours"),
  benchmarkId: z.number().int().positive().optional()
    .describe("One private evaluation benchmark of yours: case inputs, outputs, judge rationales"),
  accountWide: z.boolean().optional()
    .describe("Everything: all your projects' runs plus all your benchmarks. Provide exactly one of these four"),
});

export const sweepDeliveredDataInputSchema = z.object({
  receipt: z.string().max(4096).optional()
    .describe("The exact `receipt` string a delivery returned, unchanged"),
  confirmation: z.string().max(200).optional()
    .describe(`Must be the literal phrase "${SWEEP_CONFIRM_PHRASE}"`),
});

export type SweepDeliveredDataInput = z.infer<typeof sweepDeliveredDataInputSchema>;

function normalizeScope(input: DeliverWorkDataInput): DeliveryScope {
  const named = [input.projectId, input.swarmRunId, input.benchmarkId]
    .filter((v) => v !== undefined).length;
  if (named + (input.accountWide ? 1 : 0) !== 1) {
    // A vague scope is the one thing a destructive second call cannot have.
    throw new DataDeliveryError(
      "scope_required",
      "name exactly one of projectId, swarmRunId, benchmarkId, or set accountWide:true — a sweep can only cover a scope a delivery covered",
    );
  }
  if (input.accountWide) return { kind: "account" };
  if (input.projectId !== undefined) return { kind: "project", projectId: input.projectId };
  if (input.swarmRunId !== undefined) return { kind: "run", swarmRunId: input.swarmRunId };
  return { kind: "benchmark", benchmarkId: input.benchmarkId as number };
}

// ─── bundle shape ────────────────────────────────────────────────────

interface BundleStep {
  agentRunId: number;
  agentName: string;
  agentRole: string;
  pipelineStep: number;
  iteration: number | null;
  status: string;
  modelUsed: string | null;
  providerUsed: string | null;
  tokensUsed: number | null;
  latencyMs: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  systemPrompt: string | null;
  userPrompt: string | null;
  contextInput: string | null;
}

interface BundleResponse {
  responseId: number;
  agentRunId: number;
  parentResponseId: number | null;
  responseType: string;
  isFinal: boolean;
  model: string | null;
  provider: string | null;
  tokensUsed: number | null;
  latencyMs: number | null;
  createdAt: Date | null;
  humanReviewed: boolean | null;
  humanNotes: string | null;
  content: string;
}

interface BundleRun {
  swarmRunId: number;
  projectId: number;
  status: string;
  currentStep: string | null;
  pipelineVersion: string | null;
  isTestRun: boolean | null;
  finalResponseId: number | null;
  totalTokensUsed: number | null;
  totalLatencyMs: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
  userPrompt: string | null;
  steps: BundleStep[];
  responses: BundleResponse[];
}

interface BundleBenchmark {
  benchmarkId: number;
  executionMode: string;
  state: string;
  aggregateAvailability: string;
  rubricRef: string | null;
  planHash: string | null;
  totalEstimatedCost: string | null;
  totalObservedCost: string | null;
  costCompleteness: string | null;
  createdAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** A notice, not content. The manifest lives in `evidence_publications` and
   *  is never swept, but someone clearing the raw material behind a published
   *  claim is owed the fact that the claim exists. */
  linkedEvidencePublications: number;
  cases: Array<{
    caseId: number; stableCaseId: string; caseOrder: number; origin: string;
    contentHash: string; inputArtifactRef: string | null;
    inputText: string | null; expectedOutput: string | null; provenanceNotes: string | null;
  }>;
  candidates: Array<{
    candidateId: number; stableCandidateId: string; strategy: string;
    requestedModel: string | null; baselinePromptVersion: string | null;
    baselinePrompt: string | null;
  }>;
  runs: Array<{
    benchmarkRunId: number; logicalExecutionId: string; caseId: number; candidateId: number;
    replicationIndex: number | null; status: string; outputHash: string | null;
    linkedSwarmRunId: number | null; startedAt: Date | null; finishedAt: Date | null;
    usageSummary: unknown; outputText: string | null;
  }>;
  judgments: Array<{
    judgmentId: number; judgeSlot: number; kind: string; orientation: string | null;
    rubricVersionRef: string; judgePromptVersion: string; judgeModel: string;
    status: string; rawAggregate: string | null; normalizedAggregate: string | null;
    pairPreference: string | null; rationale: string | null;
  }>;
}

/** What the client writes into the folder. The hash covers EXACTLY this
 *  object — including `excluded` — so "the server copy changed" and "the bytes
 *  on disk are not what we handed over" are the same detectable event. */
interface WorkDataBundle {
  version: number;
  bundleKind: "deewaanai_work_data";
  userId: number;
  scope: DeliveryScope;
  runs: BundleRun[];
  benchmarks: BundleBenchmark[];
  /** Runs inside this scope that the bundle deliberately does not carry. */
  excluded: Array<{ swarmRunId: number; code: string; reason: string }>;
}

/** The row ids a sweep may write, all of them already proven to be the
 *  caller's, and all of them already in the delivered bundle. */
interface SweepTargets {
  swarmRunIds: number[];
  agentRunIds: number[];
  agentResponseIds: number[];
  projectIds: number[];
  runParamsRuns: Array<{ swarmRunId: number; runParams: Record<string, unknown> | null }>;
  benchmarkIds: number[];
  benchmarkCaseIds: number[];
  benchmarkCandidateIds: number[];
  benchmarkRunIds: number[];
  benchmarkJudgmentIds: number[];
}

interface Assembled {
  bundle: WorkDataBundle;
  bundleHash: string;
  targets: SweepTargets;
  counts: Record<string, number>;
}

// ─── reads ───────────────────────────────────────────────────────────

/** Runs the caller owns. `swarm_runs.user_id` is the owning row's own column,
 *  and the project behind it must be theirs too, so a run another account
 *  executed is never in scope even when the container looks familiar. */
async function ownedRunsFor(userId: number, scope: DeliveryScope): Promise<typeof swarmRuns.$inferSelect[]> {
  const db = getDb();
  if (scope.kind === "benchmark") return [];

  if (scope.kind === "run") {
    const [run] = await db.select().from(swarmRuns)
      .where(and(eq(swarmRuns.id, scope.swarmRunId), eq(swarmRuns.userId, userId))).limit(1);
    return run ? [run] : [];
  }

  const projectIds: number[] = [];
  if (scope.kind === "project") {
    // "No such project" and "not yours" refuse identically (runAccess's
    // NotVisibleError), so nothing here confirms that an id exists anywhere.
    await assertProjectVisible(userId, scope.projectId);
    projectIds.push(scope.projectId);
  } else {
    const rows = await db.select({ id: projects.id }).from(projects)
      .where(eq(projects.userId, userId)).orderBy(projects.id);
    projectIds.push(...rows.map((r) => r.id));
  }
  if (projectIds.length === 0) return [];
  return db.select().from(swarmRuns)
    .where(and(eq(swarmRuns.userId, userId), inArray(swarmRuns.projectId, projectIds)))
    .orderBy(swarmRuns.id);
}

async function ownedBenchmarkIdsFor(userId: number, scope: DeliveryScope): Promise<number[]> {
  const db = getDb();
  if (scope.kind === "run" || scope.kind === "project") return [];
  if (scope.kind === "benchmark") {
    const [row] = await db.select({ id: benchmarks.id }).from(benchmarks)
      .where(and(eq(benchmarks.id, scope.benchmarkId), eq(benchmarks.ownerId, userId))).limit(1);
    if (!row) throw new DataDeliveryError("not_found_or_not_authorized", "benchmark is not visible to this account");
    return [row.id];
  }
  const rows = await db.select({ id: benchmarks.id }).from(benchmarks)
    .where(eq(benchmarks.ownerId, userId)).orderBy(benchmarks.id);
  return rows.map((r) => r.id);
}

/** Design rule 3, phrased so the refusal names the OTHER account's interest
 *  without disclosing anything about that run's content: no prompt text, no
 *  model, no id of the seller or grantor — only whose interest the run carries.
 */
function exclusionReasonFor(run: { runParams: unknown }): { code: string; reason: string } | null {
  const shared = sharedRunOf(run);
  if (shared) {
    return {
      code: "shared_pipeline_run_not_sweepable",
      reason: "this run executed a workflow ANOTHER ACCOUNT shared with you; its definition and evidence are not yours alone to destroy, so the server copy stays",
    };
  }
  if (isProtectedRun(run)) {
    return {
      code: "protected_marketplace_run_not_sweepable",
      reason: "this run executed a PURCHASED workflow under the seller's protection; the evidence that backs the purchase still involves them, so the server copy stays",
    };
  }
  return null;
}

function stepOf(row: typeof agentRuns.$inferSelect): BundleStep {
  return {
    agentRunId: row.id, agentName: row.agentName, agentRole: row.agentRole,
    pipelineStep: row.pipelineStep, iteration: row.iteration ?? null, status: row.status,
    modelUsed: row.modelUsed ?? null, providerUsed: row.providerUsed ?? null,
    tokensUsed: row.tokensUsed ?? null, latencyMs: row.latencyMs ?? null,
    startedAt: row.startedAt ?? null, completedAt: row.completedAt ?? null,
    systemPrompt: row.systemPrompt ?? null, userPrompt: row.userPrompt ?? null,
    contextInput: row.contextInput ?? null,
  };
}

/** Reads the whole scope once. Used by BOTH calls: the delivery to build the
 *  bundle, the sweep to prove the server copy still equals what was handed
 *  over. Pure read — it writes nothing and takes no lock. */
async function assemble(userId: number, scope: DeliveryScope): Promise<Assembled> {
  const db = getDb();
  const runs = await ownedRunsFor(userId, scope);
  const excluded: Array<{ swarmRunId: number; code: string; reason: string }> = [];
  const deliverable = runs.filter((run) => {
    const found = exclusionReasonFor(run);
    if (!found) return true;
    if (scope.kind === "run") {
      // The caller asked for THIS run and nothing else: refuse the request
      // outright, with the same words, rather than answering "here is an empty
      // bundle". A wider scope excludes and reports instead, so the rest of the
      // account's work is still deliverable.
      throw new DataDeliveryError(found.code, `${found.reason}. Deliver a project or account scope to receive the rest of your work data around it`);
    }
    excluded.push({ swarmRunId: run.id, code: found.code, reason: found.reason });
    return false;
  });

  const swarmRunIds = deliverable.map((r) => r.id);
  const projectIds = [...new Set(deliverable.map((r) => r.projectId))].sort((a, b) => a - b);
  const agentRunRows = swarmRunIds.length > 0
    ? await db.select().from(agentRuns)
        .where(and(inArray(agentRuns.swarmRunId, swarmRunIds), inArray(agentRuns.projectId, projectIds)))
        .orderBy(agentRuns.swarmRunId, agentRuns.pipelineStep, agentRuns.iteration, agentRuns.id)
    : [];
  const responseRows = swarmRunIds.length > 0
    ? await db.select().from(agentResponses)
        .where(and(inArray(agentResponses.swarmRunId, swarmRunIds), inArray(agentResponses.projectId, projectIds)))
        .orderBy(agentResponses.swarmRunId, agentResponses.id)
    : [];

  const stepsByRun = new Map<number, typeof agentRuns.$inferSelect[]>();
  for (const row of agentRunRows) {
    const list = stepsByRun.get(row.swarmRunId) ?? [];
    list.push(row);
    stepsByRun.set(row.swarmRunId, list);
  }
  const responsesByRun = new Map<number, typeof agentResponses.$inferSelect[]>();
  for (const row of responseRows) {
    const list = responsesByRun.get(row.swarmRunId) ?? [];
    list.push(row);
    responsesByRun.set(row.swarmRunId, list);
  }

  const bundleRuns: BundleRun[] = deliverable.map((run) => ({
    swarmRunId: run.id, projectId: run.projectId, status: run.status,
    currentStep: run.currentStep ?? null, pipelineVersion: run.pipelineVersion ?? null,
    isTestRun: run.isTestRun ?? null, finalResponseId: run.finalResponseId ?? null,
    totalTokensUsed: run.totalTokensUsed ?? null, totalLatencyMs: run.totalLatencyMs ?? null,
    // `swarm_runs` has no created_at column; `started_at` defaults to now on
    // insert, which is the run's own record of when it began.
    startedAt: run.startedAt ?? null, completedAt: run.completedAt ?? null,
    error: run.error ?? null, userPrompt: run.userPrompt ?? null,
    steps: (stepsByRun.get(run.id) ?? []).map(stepOf),
    responses: (responsesByRun.get(run.id) ?? []).map((row) => {
      const meta = (row.metadata ?? {}) as Partial<{
        model: string; provider: string; latencyMs: number; tokensUsed: { total?: number };
      }>;
      return {
        responseId: row.id, agentRunId: row.agentRunId,
        parentResponseId: row.parentResponseId ?? null, responseType: row.responseType,
        isFinal: row.id === run.finalResponseId,
        model: meta.model ?? null, provider: meta.provider ?? null,
        tokensUsed: meta.tokensUsed?.total ?? null, latencyMs: meta.latencyMs ?? null,
        createdAt: row.createdAt ?? null,
        humanReviewed: row.humanReviewed ?? null, humanNotes: row.humanNotes ?? null,
        content: row.content,
      };
    }),
  }));

  // ─── private benchmark bodies ───
  const benchmarkIds = await ownedBenchmarkIdsFor(userId, scope);
  const bundleBenchmarks: BundleBenchmark[] = [];
  if (benchmarkIds.length > 0) {
    const [benchmarkRows, caseRows, candidateRows, bRunRows, judgmentRows, published] = await Promise.all([
      db.select().from(benchmarks).where(inArray(benchmarks.id, benchmarkIds)).orderBy(benchmarks.id),
      db.select().from(benchmarkCases).where(inArray(benchmarkCases.benchmarkId, benchmarkIds))
        .orderBy(benchmarkCases.benchmarkId, benchmarkCases.caseOrder, benchmarkCases.id),
      db.select().from(benchmarkCandidates).where(inArray(benchmarkCandidates.benchmarkId, benchmarkIds))
        .orderBy(benchmarkCandidates.benchmarkId, benchmarkCandidates.id),
      db.select().from(benchmarkRuns).where(inArray(benchmarkRuns.benchmarkId, benchmarkIds))
        .orderBy(benchmarkRuns.benchmarkId, benchmarkRuns.id),
      db.select().from(benchmarkJudgments).where(inArray(benchmarkJudgments.benchmarkId, benchmarkIds))
        .orderBy(benchmarkJudgments.benchmarkId, benchmarkJudgments.id),
      db.select({ benchmarkId: evidencePublications.benchmarkId, total: count() })
        .from(evidencePublications)
        .where(inArray(evidencePublications.benchmarkId, benchmarkIds))
        .groupBy(evidencePublications.benchmarkId),
    ]);
    const publishedByBenchmark = new Map(published.map((p) => [p.benchmarkId ?? -1, Number(p.total)]));
    for (const bm of benchmarkRows) {
      bundleBenchmarks.push({
        benchmarkId: bm.id, executionMode: bm.executionMode, state: bm.state,
        aggregateAvailability: bm.aggregateAvailability, rubricRef: bm.rubricRef ?? null,
        planHash: bm.planHash ?? null,
        totalEstimatedCost: bm.totalEstimatedCost ?? null, totalObservedCost: bm.totalObservedCost ?? null,
        costCompleteness: bm.costCompleteness ?? null,
        createdAt: bm.createdAt ?? null, startedAt: bm.startedAt ?? null, finishedAt: bm.finishedAt ?? null,
        linkedEvidencePublications: publishedByBenchmark.get(bm.id) ?? 0,
        cases: caseRows.filter((r) => r.benchmarkId === bm.id).map((r) => ({
          caseId: r.id, stableCaseId: r.stableCaseId, caseOrder: r.caseOrder, origin: r.origin,
          contentHash: r.contentHash, inputArtifactRef: r.inputArtifactRef ?? null,
          inputText: r.inputText ?? null, expectedOutput: r.expectedOutput ?? null,
          provenanceNotes: r.provenanceNotes ?? null,
        })),
        candidates: candidateRows.filter((r) => r.benchmarkId === bm.id).map((r) => ({
          candidateId: r.id, stableCandidateId: r.stableCandidateId, strategy: r.strategy,
          requestedModel: r.requestedModel ?? null, baselinePromptVersion: r.baselinePromptVersion ?? null,
          baselinePrompt: r.baselinePrompt ?? null,
        })),
        runs: bRunRows.filter((r) => r.benchmarkId === bm.id).map((r) => ({
          benchmarkRunId: r.id, logicalExecutionId: r.logicalExecutionId,
          caseId: r.caseId, candidateId: r.candidateId,
          replicationIndex: r.replicationIndex ?? null, status: r.status,
          outputHash: r.outputHash ?? null, linkedSwarmRunId: r.linkedSwarmRunId ?? null,
          startedAt: r.startedAt ?? null, finishedAt: r.finishedAt ?? null,
          usageSummary: r.usageSummary ?? null, outputText: r.outputText ?? null,
        })),
        judgments: judgmentRows.filter((r) => r.benchmarkId === bm.id).map((r) => ({
          judgmentId: r.id, judgeSlot: r.judgeSlot, kind: r.kind, orientation: r.orientation ?? null,
          rubricVersionRef: r.rubricVersionRef, judgePromptVersion: r.judgePromptVersion,
          judgeModel: r.judgeModel, status: r.status,
          rawAggregate: r.rawAggregate ?? null, normalizedAggregate: r.normalizedAggregate ?? null,
          pairPreference: r.pairPreference ?? null, rationale: r.rationale ?? null,
        })),
      });
    }
  }

  const bundle: WorkDataBundle = {
    version: DATA_DELIVERY_BUNDLE_VERSION,
    bundleKind: "deewaanai_work_data",
    userId,
    scope,
    runs: bundleRuns,
    benchmarks: bundleBenchmarks,
    excluded,
  };
  // sha256 over the canonical JSON, the same way `versionService` hashes a
  // workflow definition and `auditExport` signs a ledger.
  const bundleHash = createHash("sha256").update(canonicalJson(bundle)).digest("hex");

  const counts: Record<string, number> = {
    swarm_runs: swarmRunIds.length,
    agent_runs: agentRunRows.length,
    agent_responses: responseRows.length,
    benchmarks: benchmarkIds.length,
    benchmark_cases: bundleBenchmarks.reduce((n, b) => n + b.cases.length, 0),
    benchmark_candidates: bundleBenchmarks.reduce((n, b) => n + b.candidates.length, 0),
    benchmark_runs: bundleBenchmarks.reduce((n, b) => n + b.runs.length, 0),
    benchmark_judgments: bundleBenchmarks.reduce((n, b) => n + b.judgments.length, 0),
    excluded_runs: excluded.length,
  };

  return {
    bundle, bundleHash, counts,
    targets: {
      swarmRunIds,
      agentRunIds: agentRunRows.map((r) => r.id),
      agentResponseIds: responseRows.map((r) => r.id),
      projectIds,
      runParamsRuns: deliverable.map((r) => ({
        swarmRunId: r.id,
        runParams: (r.runParams ?? null) as Record<string, unknown> | null,
      })),
      benchmarkIds,
      benchmarkCaseIds: bundleBenchmarks.flatMap((b) => b.cases.map((c) => c.caseId)),
      benchmarkCandidateIds: bundleBenchmarks.flatMap((b) => b.candidates.map((c) => c.candidateId)),
      benchmarkRunIds: bundleBenchmarks.flatMap((b) => b.runs.map((r) => r.benchmarkRunId)),
      benchmarkJudgmentIds: bundleBenchmarks.flatMap((b) => b.judgments.map((j) => j.judgmentId)),
    },
  };
}

/** How many rows each swept column loses, derived from the SAME id lists the
 *  writes use, so the receipt can never report a column as swept that the
 *  transaction skipped. Computed outside the transaction on purpose: a rollback
 *  must not leave a mutated plan behind. */
function rowsPerSweptColumn(targets: SweepTargets): Array<{
  table: string; column: string; mode: string; rows: number;
}> {
  const runParamsWithPrompt = targets.runParamsRuns
    .filter((r) => typeof r.runParams?.prompt === "string").length;
  const rowsFor: Record<string, number> = {
    "swarm_runs.user_prompt": targets.swarmRunIds.length,
    "swarm_runs.execution_state": targets.swarmRunIds.length,
    "swarm_runs.error": targets.swarmRunIds.length,
    "swarm_runs.run_params.prompt": runParamsWithPrompt,
    "agent_runs.system_prompt": targets.agentRunIds.length,
    "agent_runs.user_prompt": targets.agentRunIds.length,
    "agent_runs.context_input": targets.agentRunIds.length,
    "agent_responses.content": targets.agentResponseIds.length,
    "agent_responses.human_notes": targets.agentResponseIds.length,
    "benchmark_cases.input_text": targets.benchmarkCaseIds.length,
    "benchmark_cases.expected_output": targets.benchmarkCaseIds.length,
    "benchmark_cases.provenance_notes": targets.benchmarkCaseIds.length,
    "benchmark_candidates.baseline_prompt": targets.benchmarkCandidateIds.length,
    "benchmark_runs.output_text": targets.benchmarkRunIds.length,
    "benchmark_judgments.rationale": targets.benchmarkJudgmentIds.length,
  };
  return SWEEPABLE_CONTENT_COLUMNS
    .map((c) => ({ table: c.table, column: c.column, mode: c.mode as string, rows: rowsFor[`${c.table}.${c.column}`] ?? 0 }))
    .filter((c) => c.rows > 0);
}

// ─── the signed receipt ──────────────────────────────────────────────

interface ReceiptPayload {
  v: number;
  userId: number;
  scope: DeliveryScope;
  bundleHash: string;
  issuedAt: string;
  counts: Record<string, number>;
}

function receiptKey(): Buffer {
  // Fail closed rather than sign with an empty secret: a sweep capability that
  // anyone could forge is worse than no sweep at all.
  const secret = env.appSecret;
  if (!secret) {
    throw new DataDeliveryError(
      "delivery_receipts_unavailable",
      "APP_SECRET is not configured, so a delivery receipt cannot be signed and deliver/sweep are unavailable until it is",
    );
  }
  return createHash("sha256").update(secret).digest();
}

function hmacHex(payload: ReceiptPayload, key: Buffer): string {
  return createHmac("sha256", key).update(canonicalJson(payload), "utf8").digest("hex");
}

function mintReceipt(userId: number, assembled: Assembled, issuedAt: Date): string {
  const payload: ReceiptPayload = {
    v: DATA_DELIVERY_BUNDLE_VERSION,
    userId,
    scope: assembled.bundle.scope,
    bundleHash: assembled.bundleHash,
    issuedAt: issuedAt.toISOString(),
    counts: assembled.counts,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${RECEIPT_PREFIX}.${body}.${hmacHex(payload, receiptKey())}`;
}

function readReceipt(token: string, userId: number): ReceiptPayload {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3 || parts[0] !== RECEIPT_PREFIX) {
    throw new DataDeliveryError(
      "delivery_receipt_invalid",
      "no delivery receipt in the form this service issues was supplied; call dataDelivery.deliver and pass its receipt back unchanged",
    );
  }
  let payload: ReceiptPayload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as ReceiptPayload;
  } catch {
    throw new DataDeliveryError("delivery_receipt_invalid", "the receipt could not be decoded");
  }
  const expected = Buffer.from(hmacHex(payload, receiptKey()), "utf8");
  const given = Buffer.from(parts[2], "utf8");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new DataDeliveryError(
      "delivery_receipt_invalid",
      "the receipt signature does not verify — it was edited, or it is not one this service issued",
    );
  }
  if (payload.userId !== userId) {
    // Not "this receipt belongs to another account": that would confirm the
    // account exists. The truthful answer for this caller is only that it is
    // not theirs.
    throw new DataDeliveryError("delivery_receipt_invalid", "this receipt was not issued to your account");
  }
  if (payload.v !== DATA_DELIVERY_BUNDLE_VERSION) {
    throw new DataDeliveryError(
      "delivery_receipt_stale",
      `this receipt is for bundle version ${payload.v}; deliver again for version ${DATA_DELIVERY_BUNDLE_VERSION}`,
    );
  }
  return payload;
}

// ─── the never-swept invariant, measured ─────────────────────────────

interface Census {
  neverSwept: Record<string, number>;
  rows: Record<string, number>;
  ledger: { totalCalls: number; knownCostUsd: string; promptTokens: string; completionTokens: string };
}

async function takeCensus(userId: number): Promise<Census> {
  const db = getDb();
  const neverSwept: Record<string, number> = {};
  for (const { table, rows } of NEVER_SWEPT_TABLES) neverSwept[table] = await rows();
  const rowCounts: Record<string, number> = {};
  for (const { table, rows } of ROWS_NEVER_DELETED) rowCounts[table] = await rows();
  return { neverSwept, rows: rowCounts, ledger: await ledgerSnapshot(db, userId) };
}

/** The cost ledger, reduced to its numbers. `payerId OR actorId` covers both
 *  ways an attempt can be attributable to this account; the claim being tested
 *  is that a sweep cannot move any of it. */
async function ledgerSnapshot(db: Db, userId: number): Promise<Census["ledger"]> {
  const [row] = await db.select({
    totalCalls: count(),
    knownCostUsd: sql<string>`COALESCE(SUM(${callAttempts.estimatedCostUsd}), 0)`,
    promptTokens: sql<string>`COALESCE(SUM(${callAttempts.promptTokens}), 0)`,
    completionTokens: sql<string>`COALESCE(SUM(${callAttempts.completionTokens}), 0)`,
  }).from(callAttempts).where(or(eq(callAttempts.payerId, userId), eq(callAttempts.actorId, userId)));
  return {
    totalCalls: Number(row?.totalCalls ?? 0),
    knownCostUsd: String(row?.knownCostUsd ?? "0"),
    promptTokens: String(row?.promptTokens ?? "0"),
    completionTokens: String(row?.completionTokens ?? "0"),
  };
}

// ─── public surface ──────────────────────────────────────────────────

/**
 * Hand the caller ONE complete bundle of their own work data. Reads only the
 * caller's rows, writes nothing at all: a client may call it as often as it
 * likes, and two calls over unchanged data return the same hash.
 */
export async function deliverWorkData(userId: number, input: DeliverWorkDataInput) {
  const scope = normalizeScope(input);
  const assembled = await assemble(userId, scope);
  const deliveredAt = new Date();
  const receipt = mintReceipt(userId, assembled, deliveredAt);
  const sizeBytes = Buffer.byteLength(canonicalJson(assembled.bundle), "utf8");

  logger.info("D14 work data delivered", {
    userId, scope: assembled.bundle.scope, bundleHash: assembled.bundleHash,
    counts: assembled.counts, sizeBytes,
  });

  return {
    version: DATA_DELIVERY_BUNDLE_VERSION,
    deliveredAt: deliveredAt.toISOString(),
    scope: assembled.bundle.scope,
    /** Write THIS object, verbatim, into the folder the user chose. The hash
     *  below is sha256 over its canonical JSON encoding. */
    bundle: assembled.bundle,
    bundleHash: assembled.bundleHash,
    hashAlgorithm: "sha256(canonical-json(bundle)) — object keys sorted recursively, dates as ISO strings",
    sizeBytes,
    counts: assembled.counts,
    /** Everything a sweep is allowed to touch, so the user can read it BEFORE
     *  agreeing rather than discovering it afterwards. */
    sweepableContentColumns: SWEEPABLE_CONTENT_COLUMNS,
    neverSweptTables: NEVER_SWEPT_TABLES.map((t) => t.table),
    /** The other half of the promise: which runs in this scope are deliberately
     *  left alone and why. Reason text only — another account's prompts,
     *  outputs and identity are not disclosed here. */
    excluded: assembled.bundle.excluded,
    protectionNotes: assembled.bundle.excluded.length > 0
      ? "Some runs in this scope were excluded because another account has an interest in them — a marketplace purchase of a seller's workflow, or a pipeline another account shared with you. Their server copies stay in place: a sweep may only remove what this bundle delivered."
      : undefined,
    /** Carry this string to `dataDelivery.sweep` unchanged. */
    receipt,
    howToSweep: {
      procedure: "dataDelivery.sweep",
      receipt,
      confirmation: SWEEP_CONFIRM_PHRASE,
      warning: "The sweep clears the content columns named in sweepableContentColumns, for exactly this bundle's scope. It deletes no rows and never touches published versions, evidence manifests, purchases, execution rights, the cost ledger or consent records. It cannot be undone from the platform: the copy on your device becomes the only one.",
    },
  };
}

/**
 * Clear the server copy of what the receipt delivered. The order of the checks
 * IS the design: receipt → confirmation → still-the-same-bytes → write.
 */
export async function sweepDeliveredData(userId: number, input: SweepDeliveredDataInput) {
  const db = getDb();
  if (!input.receipt || !input.receipt.trim()) {
    throw new DataDeliveryError(
      "delivery_receipt_required",
      "a sweep names the delivery it follows: call dataDelivery.deliver, write the bundle to the folder the user chose, then pass that receipt here — nothing was deleted",
    );
  }
  const payload = readReceipt(input.receipt, userId);
  if (input.confirmation !== SWEEP_CONFIRM_PHRASE) {
    throw new DataDeliveryError(
      "sweep_confirmation_required",
      `the sweep needs the explicit confirmation phrase "${SWEEP_CONFIRM_PHRASE}" — nothing was deleted`,
    );
  }

  // Re-derive, never trust: the receipt says what WAS delivered, the database
  // says what is here now. If they differ, the copy on the user's device is not
  // the copy on the server and sweeping would delete something undelivered.
  const assembled = await assemble(userId, payload.scope);
  if (assembled.bundleHash !== payload.bundleHash) {
    throw new DataDeliveryError(
      "bundle_changed",
      "the server copy no longer matches the bundle this receipt delivered (rows added or edited since delivery). Deliver again, write the new bundle, then sweep with the receipt for THAT copy — nothing was deleted",
    );
  }

  const t = assembled.targets;
  const marker = `${SWEPT_MARKER_PREFIX}${assembled.bundleHash}${SWEPT_MARKER_SUFFIX}`;
  const before = await takeCensus(userId);
  const workNeeded = [
    t.swarmRunIds, t.agentRunIds, t.agentResponseIds, t.benchmarkCaseIds,
    t.benchmarkCandidateIds, t.benchmarkRunIds, t.benchmarkJudgmentIds,
  ].some((ids) => ids.length > 0);

  if (workNeeded) {
    await db.transaction(async (tx) => {
      // Every predicate carries the CALLER's own user id, or an id list derived
      // from a row they own: an id alone never authorizes a write (rule 2).
      if (t.swarmRunIds.length > 0) {
        await tx.update(swarmRuns)
          .set({ userPrompt: marker, executionState: null, error: null })
          .where(and(
            inArray(swarmRuns.id, t.swarmRunIds),
            eq(swarmRuns.userId, userId),
            inArray(swarmRuns.projectId, t.projectIds),
          ));
        // run_params IN PLACE (rule 4): swap only the duplicated prompt text and
        // leave the share/protection context, the chain config, the credential
        // field and `attachments` exactly as they are. Read-modify-write,
        // because the column is one JSON document and the run set is small by
        // measurement (~24 rows per account).
        for (const { swarmRunId, runParams } of t.runParamsRuns) {
          if (!runParams || typeof runParams.prompt !== "string") continue;
          const next = { ...runParams, prompt: marker };
          await tx.update(swarmRuns)
            .set({ runParams: next as unknown as typeof swarmRuns.$inferInsert.runParams })
            .where(and(eq(swarmRuns.id, swarmRunId), eq(swarmRuns.userId, userId)));
        }
      }
      if (t.agentRunIds.length > 0) {
        await tx.update(agentRuns)
          .set({ systemPrompt: null, userPrompt: marker, contextInput: null })
          .where(and(
            inArray(agentRuns.id, t.agentRunIds),
            inArray(agentRuns.swarmRunId, t.swarmRunIds),
            inArray(agentRuns.projectId, t.projectIds),
          ));
      }
      if (t.agentResponseIds.length > 0) {
        await tx.update(agentResponses)
          .set({ content: marker, humanNotes: null })
          .where(and(
            inArray(agentResponses.id, t.agentResponseIds),
            inArray(agentResponses.swarmRunId, t.swarmRunIds),
            inArray(agentResponses.projectId, t.projectIds),
          ));
      }
      if (t.benchmarkCaseIds.length > 0) {
        await tx.update(benchmarkCases)
          .set({ inputText: null, expectedOutput: null, provenanceNotes: null })
          .where(and(
            inArray(benchmarkCases.id, t.benchmarkCaseIds),
            inArray(benchmarkCases.benchmarkId, t.benchmarkIds),
          ));
      }
      if (t.benchmarkCandidateIds.length > 0) {
        await tx.update(benchmarkCandidates).set({ baselinePrompt: null })
          .where(and(
            inArray(benchmarkCandidates.id, t.benchmarkCandidateIds),
            inArray(benchmarkCandidates.benchmarkId, t.benchmarkIds),
          ));
      }
      if (t.benchmarkRunIds.length > 0) {
        await tx.update(benchmarkRuns).set({ outputText: null })
          .where(and(
            inArray(benchmarkRuns.id, t.benchmarkRunIds),
            inArray(benchmarkRuns.benchmarkId, t.benchmarkIds),
          ));
      }
      if (t.benchmarkJudgmentIds.length > 0) {
        await tx.update(benchmarkJudgments).set({ rationale: null })
          .where(and(
            inArray(benchmarkJudgments.id, t.benchmarkJudgmentIds),
            inArray(benchmarkJudgments.benchmarkId, t.benchmarkIds),
          ));
      }
    });
  }

  const after = await takeCensus(userId);
  const rowsSwept: Record<string, number> = {
    swarm_runs: t.swarmRunIds.length,
    agent_runs: t.agentRunIds.length,
    agent_responses: t.agentResponseIds.length,
    benchmarks: t.benchmarkIds.length,
    benchmark_cases: t.benchmarkCaseIds.length,
    benchmark_candidates: t.benchmarkCandidateIds.length,
    benchmark_runs: t.benchmarkRunIds.length,
    benchmark_judgments: t.benchmarkJudgmentIds.length,
  };
  const neverSweptUntouched = NEVER_SWEPT_TABLES.every(
    ({ table }) => after.neverSwept[table] === before.neverSwept[table],
  );
  const rowsUntouched = ROWS_NEVER_DELETED.every(
    ({ table }) => after.rows[table] === before.rows[table],
  );
  const ledgerUntouched = after.ledger.totalCalls === before.ledger.totalCalls
    && after.ledger.knownCostUsd === before.ledger.knownCostUsd;

  if (!neverSweptUntouched || !rowsUntouched || !ledgerUntouched) {
    // Should be unreachable — this call writes no row outside the swept set —
    // and loud rather than silent, because it is the promise the offering makes.
    logger.error("D14 sweep found a protected table changed", {
      userId, bundleHash: assembled.bundleHash,
      neverSweptUntouched, rowsUntouched, ledgerUntouched,
      before: before.neverSwept, after: after.neverSwept,
    });
  }

  const columnsSwept = rowsPerSweptColumn(t);
  logger.info("D14 server copy swept", {
    userId, scope: assembled.bundle.scope, bundleHash: assembled.bundleHash,
    rowsSwept, columnsSwept: columnsSwept.map((c) => `${c.table}.${c.column}:${c.rows}`),
    neverSweptUnchanged: neverSweptUntouched, rowsUnchanged: rowsUntouched, ledgerUnchanged: ledgerUntouched,
  });

  return {
    version: DATA_DELIVERY_BUNDLE_VERSION,
    sweptAt: new Date().toISOString(),
    // The two things that make this a receipt rather than an ok: WHICH bytes
    // were the delivered copy, and WHAT was cleared per table and per column.
    bundleHash: assembled.bundleHash,
    scope: assembled.bundle.scope,
    deliveryReceiptIssuedAt: payload.issuedAt,
    rowsSwept,
    columnsSwept,
    rowsDeleted: 0,
    markerText: marker,
    preserved: {
      note: "Rows, ids, timestamps, model/provider names, token counts, latency, cost numbers and every hash are untouched: the cost ledger and any published evidence still reconcile to a run that happened.",
      neverSweptTables: after.neverSwept,
    },
    neverSwept: { before: before.neverSwept, after: after.neverSwept, unchanged: neverSweptUntouched },
    rowCountsWithinSweptTables: { before: before.rows, after: after.rows, unchanged: rowsUntouched },
    ledger: { before: before.ledger, after: after.ledger, unchanged: ledgerUntouched },
  };
}

/** One sweepable scope, described without its content: what WOULD be delivered
 *  and swept, and what would be refused. No writes, no receipt. */
export async function previewDeliveryScope(userId: number, input: DeliverWorkDataInput) {
  const scope = normalizeScope(input);
  const assembled = await assemble(userId, scope);
  return {
    scope: assembled.bundle.scope,
    counts: assembled.counts,
    bundleHash: assembled.bundleHash,
    sizeBytes: Buffer.byteLength(canonicalJson(assembled.bundle), "utf8"),
    excluded: assembled.bundle.excluded,
    sweepableContentColumns: SWEEPABLE_CONTENT_COLUMNS,
    neverSweptTables: NEVER_SWEPT_TABLES.map((t) => t.table),
  };
}

/** The per-benchmark ledger totals, so a client can print the same
 *  reconciliation sentence the platform keeps after a sweep. Numbers only: this
 *  reads no content column, so it answers identically before and after. */
export async function deliveredLedgerTotals(userId: number, benchmarkId: number) {
  const db = getDb();
  const [row] = await db.select({ id: benchmarks.id }).from(benchmarks)
    .where(and(eq(benchmarks.id, benchmarkId), eq(benchmarks.ownerId, userId))).limit(1);
  if (!row) throw new DataDeliveryError("not_found_or_not_authorized", "benchmark is not visible to this account");
  return benchmarkLedgerTotals(benchmarkId);
}
