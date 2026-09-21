// Private evaluation engine (offering redesign spec §4.1–4.2, §6.1, §7.2,
// §9, §10). Draft → freeze plan+hash → quote → atomic spend approval →
// durable fan-out over IMMUTABLE workflow versions → LLM judgments →
// descriptive-only summary. Nothing here publishes anything (A10): the
// publication boundary arrives in P3 as its own operation.
//
// Key invariants:
// - grade_only grades with the configured workflow as-is; no second model is
//   ever added, and an imported existing output is never regenerated (D1/A01).
// - Candidate model overrides apply to EVERY model-backed step incl. gates
//   via materialized override versions (A02).
// - Plan change after approval → hash mismatch → start refused; the approval
//   row is consumed exactly once (A06).
// - Completed children/judgments are skipped on re-entry; attempts are
//   append-only in call_attempts (resume never silently reruns work).
// - Summary is descriptive only (A07): counts, spread, agreement, failures,
//   observed cost. No CIs, significance, or certification language.

import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import {
  agentResponses, benchmarkCandidates, benchmarkCases, benchmarkJudgments, benchmarkRuns,
  benchmarks, llmProviders, pipelineVersions, projects, spendApprovals, swarmRuns,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import { logger } from "../../lib/logger";
import { executeSwarmRun } from "../swarmService";
import { resolveModelPricing, type PricingSource, type ResolvedPricing } from "./modelPricing";
import {
  VALIDATORS_DISABLED_REASON,
  type BenchmarkCallPlan, type CallCounts, type CandidateSpec, type CaseSpec,
  type JudgeSpec, type RubricSpec, type SnapshotStep, type ValidatorSpec, type VersionDefinition,
} from "./benchmarkTypes";
import {
  computeCounts, expandDraftCandidates, hashPlan, planPreflightErrors,
  repeatsForCandidate, stepsPerGenerationForCandidate,
} from "./benchmarkCallPlan";
import {
  captureVersionFromProject, createVersionRow, loadVersionDefinition, materializeOverrideVersion,
  snapshotStepsFromProject, stepResolutionsFromSnapshot, singleRouteOfSnapshot,
} from "./versionService";
import {
  JUDGE_PROMPT_VERSION, buildPairwiseJudgePrompt, buildRubricJudgePrompt,
  generateJudgeCall, parseAndValidatePairwiseVerdict, parseAndValidateRubricVerdict,
} from "./judgeService";
import { benchmarkLedgerTotals, recordCallAttempt } from "./benchmarkLedger";

const LEASE_MS = 15 * 60_000;

export const DEFAULT_RUBRIC: RubricSpec = {
  versionRef: "preset-generic-v1",
  dimensions: [
    { dimension: "accuracy", lowerBound: 0, upperBound: 10, weight: 0.3, anchor: "10 = factually correct and complete; 0 = wrong or fabricated" },
    { dimension: "completeness", lowerBound: 0, upperBound: 10, weight: 0.25, anchor: "10 = covers every part of the task; 0 = misses the ask" },
    { dimension: "instructionFit", lowerBound: 0, upperBound: 10, weight: 0.25, anchor: "10 = follows format/tone/constraints exactly; 0 = ignores them" },
    { dimension: "clarity", lowerBound: 0, upperBound: 10, weight: 0.2, anchor: "10 = immediately usable by the end reader; 0 = unintelligible" },
  ],
  normalizedWeights: [0.3, 0.25, 0.25, 0.2],
};

// ─── Drafts ─────────────────────────────────────────────────────────

export interface CreateBenchmarkInput {
  userId: number;
  projectId: number;
  /** Defaults to the Test journey's grade-only mode (spec §4.1, A01). */
  executionMode?: BenchmarkCallPlan["executionMode"];
  cases: Array<{ inputText: string; origin?: CaseSpec["origin"]; baseCaseId?: string; expectedOutput?: string }>;
  judges: Array<{ providerId: number; model: string }>;
  candidates?: Array<{
    label?: string; overrideModel?: string; overrideProviderId?: number;
    isFrontierSoloBaseline?: boolean; baselinePrompt?: string;
    /** A01: grade this owned response instead of generating a new one. */
    existingResponseId?: number;
  }>;
  rubric?: RubricSpec;
  generationRepeats?: number;
  judgmentKind?: "rubric" | "pairwise";
  pairedRepeatIndexes?: number[];
  listingId?: number | null;
}

interface DraftPlan {
  schemaVersion: 1;
  executionMode: BenchmarkCallPlan["executionMode"];
  cases: CaseSpec[];
  candidates: Array<Omit<CandidateSpec, "baseVersionId"> & { baseVersionId?: number }>;
  judges: JudgeSpec[];
  rubric: RubricSpec;
  /** Always empty/disabled in this deployment — see spec §7.1. Carried in the
   *  plan so the quote and the published manifest can DISCLOSE that no
   *  deterministic validation happened, rather than leaving it unstated. */
  validators: ValidatorSpec[];
  generationRepeats: number;
  judgmentKind: "rubric" | "pairwise";
  /** Pairwise only: which generation repeats are paired. Explicit, never an
   *  implicit cross-product (contracts/offeringV2.ts §9 counting rules). */
  pairedRepeatIndexes?: number[];
  limits: BenchmarkCallPlan["limits"];
}

/** Pairwise plans must state their paired repeats explicitly; the default is
 *  to pair the first replication only, never every repeat. */
const DEFAULT_PAIRED_REPEAT_INDEX = 1;

export function pairedRepeatsOf(draft: Pick<DraftPlan, "judgmentKind" | "pairedRepeatIndexes">): number[] {
  if (draft.judgmentKind !== "pairwise") return [];
  return draft.pairedRepeatIndexes?.length ? draft.pairedRepeatIndexes : [DEFAULT_PAIRED_REPEAT_INDEX];
}

async function assertOwnerProviders(userId: number, providerIds: number[]) {
  const unique = [...new Set(providerIds)];
  if (unique.length === 0) return;
  const db = getDb();
  const rows = await db.select({ id: llmProviders.id, userId: llmProviders.userId, enabled: llmProviders.isEnabled })
    .from(llmProviders).where(inArray(llmProviders.id, unique));
  if (rows.length !== unique.length || rows.some((r) => r.userId !== userId || r.enabled === false)) {
    throw new Error("Provider not found, not owned, or disabled");
  }
}

/** Imported outputs must be the caller's own recorded responses (spec §4.1:
 *  an owned run's output; existence of someone else's row is never revealed). */
async function assertOwnedResponses(userId: number, responseIds: number[]): Promise<void> {
  const unique = [...new Set(responseIds)];
  const db = getDb();
  const rows = await db.select({ id: agentResponses.id, content: agentResponses.content, runOwner: swarmRuns.userId })
    .from(agentResponses)
    .innerJoin(swarmRuns, eq(agentResponses.swarmRunId, swarmRuns.id))
    .where(inArray(agentResponses.id, unique));
  if (rows.length !== unique.length || rows.some((r) => r.runOwner !== userId)) {
    throw new Error("not_found_or_not_authorized");
  }
  if (rows.some((r) => !String(r.content ?? "").trim())) {
    throw new Error("An imported output is empty — there is nothing to grade");
  }
}

function toDraftPlan(input: CreateBenchmarkInput): DraftPlan {
  const judgmentKind = input.judgmentKind ?? "rubric";
  const generationRepeats = Math.min(Math.max(input.generationRepeats ?? 1, 1), 5);
  const requestedPairs = judgmentKind === "pairwise"
    ? (input.pairedRepeatIndexes ?? []).map((i) => Math.trunc(i)).filter((i) => i >= 1 && i <= generationRepeats)
    : [];
  return {
    schemaVersion: 1,
    executionMode: input.executionMode ?? "grade_only",
    cases: input.cases.map((c, i) => ({
      stableCaseId: `case-${i + 1}`,
      inputText: c.inputText,
      origin: c.origin ?? "user",
      ...(c.baseCaseId ? { baseCaseId: c.baseCaseId } : {}),
      ...(c.expectedOutput ? { expectedOutput: c.expectedOutput } : {}),
    })),
    candidates: (input.candidates ?? []).map((c, i) => ({
      stableCandidateId: c.label || `candidate-${i + 1}`,
      strategy: c.existingResponseId
        ? "imported_output" as const
        : c.isFrontierSoloBaseline ? "solo_baseline" as const : "pipeline" as const,
      ...(c.existingResponseId ? { importedResponseId: c.existingResponseId } : {}),
      ...(c.overrideModel ? { overrideModel: c.overrideModel } : {}),
      ...(c.overrideProviderId ? { overrideProviderId: c.overrideProviderId } : {}),
      ...(c.baselinePrompt ? { baselinePrompt: c.baselinePrompt } : {}),
      decoding: {},
    })),
    judges: input.judges.map((j, i) => ({ slot: i + 1, providerId: j.providerId, model: j.model })),
    rubric: input.rubric ?? DEFAULT_RUBRIC,
    validators: [],
    generationRepeats,
    judgmentKind,
    ...(requestedPairs.length ? { pairedRepeatIndexes: [...new Set(requestedPairs)].sort((a, b) => a - b) } : {}),
    limits: { maxConcurrency: 2, deadlineMs: 30 * 60_000, maxTokensPerCall: 8192 },
  };
}

export async function createBenchmarkDraft(input: CreateBenchmarkInput): Promise<number> {
  const db = getDb();
  const [project] = await db.select().from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.userId, input.userId))).limit(1);
  if (!project) throw new Error("Project not found");
  if (input.cases.length === 0) throw new Error("At least one task input (case) is required");
  if (input.judges.length === 0) throw new Error("At least one judge is required");

  await assertOwnerProviders(input.userId, [
    ...input.judges.map((j) => j.providerId),
    ...(input.candidates ?? []).map((c) => c.overrideProviderId).filter((v): v is number => typeof v === "number"),
  ]);
  // A01: an imported output must be the owner's own recorded response with
  // something to grade. Never accept another tenant's response id.
  const importedIds = (input.candidates ?? []).map((c) => c.existingResponseId).filter((v): v is number => typeof v === "number");
  if (importedIds.length) await assertOwnedResponses(input.userId, importedIds);

  const draft = toDraftPlan(input);
  const [res] = await db.insert(benchmarks).values({
    ownerId: input.userId,
    listingId: input.listingId ?? null,
    sourceProjectId: input.projectId,
    // pipeline_version_id stays NULL until start freezes the snapshot: a
    // placeholder row id would violate the FK (migration 026).
    executionMode: draft.executionMode,
    state: "draft",
    plan: JSON.stringify(draft),
    costCurrency: "USD",
  });
  return Number((res as { insertId: number }).insertId);
}

export async function updateBenchmarkDraft(opts: {
  userId: number; benchmarkId: number; draft: DraftPlan;
}): Promise<{ ok: boolean; message: string }> {
  const db = getDb();
  const [b] = await db.select().from(benchmarks)
    .where(and(eq(benchmarks.id, opts.benchmarkId), eq(benchmarks.ownerId, opts.userId))).limit(1);
  if (!b) return { ok: false, message: "not_found_or_not_authorized" };
  if (b.state !== "draft") return { ok: false, message: "Started plans are immutable — create a new benchmark instead." };
  await assertOwnerProviders(opts.userId, [
    ...opts.draft.judges.map((j) => j.providerId),
    ...opts.draft.candidates.map((c) => c.overrideProviderId).filter((v): v is number => typeof v === "number"),
  ]);
  const imported = opts.draft.candidates.map((c) => c.importedResponseId).filter((v): v is number => typeof v === "number");
  if (imported.length) await assertOwnedResponses(opts.userId, imported);
  await db.update(benchmarks).set({ plan: JSON.stringify(opts.draft), executionMode: opts.draft.executionMode })
    .where(eq(benchmarks.id, b.id));
  return { ok: true, message: "draft updated" };
}

// ─── Draft artifact preparation (spec §10.1 prepareRubric/prepareCases) ───

/** Local rubric templates. Loading one makes NO provider call; an
 *  LLM-generated rubric would need its own spend approval and is out of P2b
 *  scope, so asking for it fails loudly instead of silently spending. */
export const RUBRIC_PRESETS: Record<string, RubricSpec> = {
  generic: DEFAULT_RUBRIC,
  translation: {
    versionRef: "preset-translation-v1",
    dimensions: [
      { dimension: "adequacy", lowerBound: 0, upperBound: 10, weight: 0.4, anchor: "10 = meaning preserved with no omissions or additions; 0 = meaning changed" },
      { dimension: "fluency", lowerBound: 0, upperBound: 10, weight: 0.3, anchor: "10 = reads natively in the target language; 0 = unreadable" },
      { dimension: "terminology", lowerBound: 0, upperBound: 10, weight: 0.3, anchor: "10 = domain and named entities handled consistently; 0 = wrong terms" },
    ],
    normalizedWeights: [0.4, 0.3, 0.3],
  },
  code: {
    versionRef: "preset-code-v1",
    dimensions: [
      { dimension: "correctness", lowerBound: 0, upperBound: 10, weight: 0.5, anchor: "10 = does what was asked, no latent bugs; 0 = broken" },
      { dimension: "runnability", lowerBound: 0, upperBound: 10, weight: 0.25, anchor: "10 = compiles/runs as given; 0 = does not" },
      { dimension: "clarity", lowerBound: 0, upperBound: 10, weight: 0.25, anchor: "10 = idiomatic and maintainable; 0 = obfuscated" },
    ],
    normalizedWeights: [0.5, 0.25, 0.25],
  },
};

export interface RubricDraftInput {
  userId: number;
  benchmarkId: number;
  preset?: string;
  dimensions?: Array<{ dimension: string; weight: number; lowerBound?: number; upperBound?: number; anchor?: string }>;
  llmAssist?: boolean;
}

/** Server-side rubric normalization (§6.3: weights sum to 1 after validated
 *  normalization). Rewrites the draft plan, which changes the plan hash, so
 *  any earlier spend approval is invalidated by construction (A06). */
export async function prepareRubricDraft(opts: RubricDraftInput): Promise<{ ok: true; rubric: RubricSpec } | { ok: false; error: string }> {
  if (opts.llmAssist) return { ok: false, error: "llm_assisted_rubric_requires_its_own_spend_approval (not implemented in P2b)" };
  const guard = await loadDraftForEdit(opts.userId, opts.benchmarkId);
  if (!guard.ok) return guard;

  const provided = opts.dimensions?.length
    ? opts.dimensions.map((d) => ({
      dimension: String(d.dimension).trim().slice(0, 60),
      lowerBound: Number.isFinite(d.lowerBound) ? Number(d.lowerBound) : 0,
      upperBound: Number.isFinite(d.upperBound) ? Number(d.upperBound) : 10,
      weight: Number(d.weight),
      anchor: String(d.anchor ?? "").slice(0, 500),
    }))
    : (opts.preset ? RUBRIC_PRESETS[opts.preset] : undefined)?.dimensions;
  if (!opts.preset && !opts.dimensions?.length) return { ok: false, error: "provide a preset name or at least one rubric dimension" };
  if (opts.preset && !RUBRIC_PRESETS[opts.preset]) return { ok: false, error: `unknown rubric preset "${opts.preset}" (available: ${Object.keys(RUBRIC_PRESETS).join(", ")})` };
  if (!provided?.length || provided.length > 6) return { ok: false, error: "a rubric needs 1–6 dimensions" };

  const total = provided.reduce((acc, d) => acc + (Number.isFinite(d.weight) && d.weight > 0 ? d.weight : 0), 0);
  if (total <= 0) return { ok: false, error: "every rubric dimension needs a positive weight" };
  if (provided.some((d) => !d.dimension)) return { ok: false, error: "every rubric dimension needs a name" };
  if (provided.some((d) => d.upperBound <= d.lowerBound)) return { ok: false, error: "dimension upperBound must exceed lowerBound" };

  const dimensions = provided.map((d) => ({ ...d, weight: d.weight / total }));
  const rubric: RubricSpec = {
    versionRef: opts.preset && !opts.dimensions?.length
      ? String(RUBRIC_PRESETS[opts.preset].versionRef)
      : `custom-${sha256(stableKey(dimensions)).slice(0, 12)}`,
    dimensions,
    normalizedWeights: dimensions.map((d) => d.weight),
  };
  await writeDraftPlan(opts.userId, guard.b, (draft) => ({ ...draft, rubric }));
  return { ok: true, rubric };
}

function stableKey(dimensions: RubricSpec["dimensions"]): string {
  return JSON.stringify(dimensions.map((d) => [d.dimension, d.lowerBound, d.upperBound, d.weight, d.anchor]));
}

export interface PrepareCasesInput {
  userId: number; benchmarkId: number;
  cases: Array<{ stableCaseId?: string; inputText: string; origin?: CaseSpec["origin"]; baseCaseId?: string; expectedOutput?: string }>;
  llmExpand?: boolean;
}

/** Case-list normalization: trims, drops empty and duplicate inputs, and
 *  preserves existing stable IDs so a later resume still matches recorded
 *  attempts. Generates variants only from what the owner supplied — an
 *  LLM-generated expansion is a paid call and requires its own approval. */
export async function prepareCasesDraft(opts: PrepareCasesInput): Promise<
  { ok: true; cases: CaseSpec[]; dropped: Array<{ reason: string; inputText: string }> } | { ok: false; error: string }
> {
  if (opts.llmExpand) return { ok: false, error: "llm_case_expansion_requires_its_own_spend_approval (not implemented in P2b)" };
  const guard = await loadDraftForEdit(opts.userId, opts.benchmarkId);
  if (!guard.ok) return guard;
  if (opts.cases.length === 0) return { ok: false, error: "at least one case is required" };

  const dropped: Array<{ reason: string; inputText: string }> = [];
  const seenText = new Set<string>();
  const usedIds = new Set<string>();
  const cases: CaseSpec[] = [];
  opts.cases.forEach((c, i) => {
    const inputText = String(c.inputText ?? "").trim();
    if (!inputText) { dropped.push({ reason: "empty input", inputText }); return; }
    if (inputText.length > 20000) { dropped.push({ reason: "input exceeds 20000 characters", inputText: inputText.slice(0, 80) }); return; }
    if (seenText.has(inputText)) { dropped.push({ reason: "duplicate of an earlier case", inputText: inputText.slice(0, 80) }); return; }
    seenText.add(inputText);
    const stableCaseId = c.stableCaseId && !usedIds.has(c.stableCaseId)
      ? c.stableCaseId.slice(0, 60)
      : `case-${i + 1}`;
    usedIds.add(stableCaseId);
    cases.push({
      stableCaseId,
      inputText,
      origin: c.origin ?? "user",
      ...(c.baseCaseId ? { baseCaseId: c.baseCaseId } : {}),
      ...(c.expectedOutput ? { expectedOutput: c.expectedOutput } : {}),
    });
  });
  if (cases.length === 0) return { ok: false, error: `no usable cases after validation (${dropped.length} dropped)` };
  if (cases.length > 50) return { ok: false, error: "a plan is limited to 50 cases" };

  await writeDraftPlan(opts.userId, guard.b, (draft) => ({ ...draft, cases }));
  return { ok: true, cases, dropped };
}

async function loadDraftForEdit(userId: number, benchmarkId: number): Promise<
  { ok: true; b: typeof benchmarks.$inferSelect } | { ok: false; error: string }
> {
  const db = getDb();
  const [b] = await db.select().from(benchmarks)
    .where(and(eq(benchmarks.id, benchmarkId), eq(benchmarks.ownerId, userId))).limit(1);
  if (!b) return { ok: false, error: "not_found_or_not_authorized" };
  if (b.state !== "draft") return { ok: false, error: "started plans are immutable — create a new benchmark instead" };
  return { ok: true, b };
}

async function writeDraftPlan(
  userId: number, b: typeof benchmarks.$inferSelect, edit: (draft: DraftPlan) => DraftPlan,
): Promise<void> {
  const db = getDb();
  const draft = edit(JSON.parse(String(b.plan)) as DraftPlan);
  await db.update(benchmarks).set({ plan: JSON.stringify(draft), executionMode: draft.executionMode })
    .where(and(eq(benchmarks.id, b.id), eq(benchmarks.ownerId, userId)));
}

// ─── Quote + spend approval (spec §9) ───────────────────────────────

export interface QuoteResult {
  planHash: string;
  counts: BenchmarkCallPlan["counts"];
  estimatedGenerationCostUsd: number | null;
  estimatedJudgingCostUsd: number | null;
  estimatedTotalCostUsd: number | null;
  pricingStatus: "priced" | "unknown";
  /** Where the per-token rates came from. `provider_list` is the host's own
   *  published rate at `pricingAsOf`; `price_vector` is the locally maintained
   *  fallback. Both are estimates, and a list rate cannot see a discount. */
  pricingBasis: ResolvedPricing["basis"];
  pricingAsOf: string | null;
  rates: Array<{ model: string; usdPer1KInput: number; usdPer1KOutput: number; source: PricingSource }>;
  warnings: string[];
  /** Non-empty means start will refuse; surfaced at quote time so the user
   *  fixes the plan before approving spend against it. */
  blockingErrors: string[];
}

function priceCalls(
  pricing: ResolvedPricing, models: string[], calls: number, avgIn: number, avgOut: number,
): number | null {
  if (calls === 0) return 0;
  if (models.length === 0) return null;
  const rates = models.map((m) => pricing.rates[m]);
  if (rates.some((r) => r == null)) return null;
  const per = (rates as Array<{ in: number; out: number }>)
    .reduce((acc, r) => acc + (avgIn / 1000) * r.in + (avgOut / 1000) * r.out, 0) / rates.length;
  return Number((per * calls).toFixed(8));
}

/** One blinded orientation per pair; a second pass would double the quote and
 *  must be an explicit future plan change, never a silent multiplier. */
const PAIRWISE_ORIENTATIONS = 1;

/** Used when a plan runs no pipeline candidate at all (pure solo baselines):
 *  keeps the snapshot-step argument meaningful for preflight. */
const SOLO_ONLY_STEPS: SnapshotStep[] = [{
  stepOrder: 1, name: "solo", role: "builder", systemPrompt: "", stepType: "agent",
  providerId: null, model: null, temperature: "0.7", maxTokens: 4096, ifConfig: null, whileConfig: null,
}];

/** THE draft → plan derivation. quote, approveSpend and start all go through
 *  here, so an unchanged draft over an unchanged workflow always yields the
 *  same planHash; any real edit changes it and invalidates the approval (A06). */
function countsForDraft(draft: DraftPlan, steps: SnapshotStep[]): CallCounts {
  const candidates = expandDraftCandidates(draft.candidates);
  const M = candidates.length;
  const paired = pairedRepeatsOf(draft);
  return computeCounts({
    caseCount: draft.cases.length,
    judgeCount: draft.judges.length,
    judgmentKind: draft.judgmentKind,
    candidates: candidates.map((c) => ({
      stableCandidateId: c.stableCandidateId,
      strategy: c.strategy,
      repeats: repeatsForCandidate(c, draft.generationRepeats),
      stepsPerGeneration: stepsPerGenerationForCandidate(c, steps),
    })),
    ...(draft.judgmentKind === "pairwise"
      ? { pairedRepeatCount: paired.length, pairCount: Math.max((M * (M - 1)) / 2, 1), orientationCount: PAIRWISE_ORIENTATIONS }
      : {}),
  });
}

function planFromDraft(draft: DraftPlan, steps: SnapshotStep[]): BenchmarkCallPlan {
  const candidates = expandDraftCandidates(draft.candidates).map((c): CandidateSpec => ({ ...c, baseVersionId: 0 }));
  return { ...draft, validators: draft.validators ?? [], candidates, counts: countsForDraft(draft, steps) };
}

async function buildQuote(userId: number, benchmarkId: number): Promise<QuoteResult & { plan: BenchmarkCallPlan }> {
  const db = getDb();
  const [b] = await db.select().from(benchmarks)
    .where(and(eq(benchmarks.id, benchmarkId), eq(benchmarks.ownerId, userId))).limit(1);
  if (!b) throw new Error("not_found_or_not_authorized");
  const draft = JSON.parse(String(b.plan)) as DraftPlan;
  const steps = await stepsForDraft(userId, b, draft);
  const plan = planFromDraft(draft, steps);
  const counts = plan.counts;

  const executing = plan.candidates.filter((c) => c.strategy !== "imported_output");
  const pipelineModels = [...new Set([
    ...executing.filter((c) => c.strategy === "pipeline").map((c) => c.overrideModel).filter((m): m is string => !!m),
    ...(executing.some((c) => !c.overrideModel) ? steps.map((s) => s.model).filter((m): m is string => !!m) : []),
  ])];
  const judgeModels = plan.judges.map((j) => j.model);
  const warnings: string[] = [];
  // Ask the hosts that will actually serve these calls. Their published rates
  // beat a table we maintain by hand, and the user is told which one was used.
  const pricing = await resolveModelPricing({
    providerIds: [
      ...plan.judges.map((j) => j.providerId),
      ...steps.map((s) => s.providerId),
      ...executing.map((c) => c.overrideProviderId),
    ].filter((v): v is number => typeof v === "number"),
    models: [...pipelineModels, ...judgeModels],
  });
  const genCost = priceCalls(pricing, pipelineModels, counts.generationCalls, 2000, 1200);
  const judgeCost = priceCalls(pricing, judgeModels, counts.judgingCalls, 3000, 300);
  if (pricing.missing.length) {
    warnings.push(`pricing source by model: ${Object.entries(pricing.sourceByModel).map(([m, s]) => `${m}=${s}`).join(", ") || "none"}; no rate retrievable for ${pricing.missing.join(", ")} — cost shown as UNKNOWN, never zero (spec §9)`);
  } else if (Object.keys(pricing.rates).length) {
    warnings.push(`rates used (USD per 1K tokens, ${pricing.basis} as of ${pricing.asOf}): ${Object.entries(pricing.rates).map(([m, r]) => `${m} ${r.in.toFixed(4)} in / ${r.out.toFixed(4)} out`).join(", ")}. Provider LIST prices — promotional, committed-use and cached-input discounts are not visible to us, so the bill may be lower.`);
  }
  if (genCost === null && counts.generationCalls > 0) warnings.push("generation cost UNKNOWN — no retrievable rate for one or more executor models");
  if (judgeCost === null && counts.judgingCalls > 0) warnings.push("judging cost UNKNOWN — no retrievable rate for one or more judge models");
  warnings.push("cost is estimated from per-call token ASSUMPTIONS (generation 2,000 in / 1,200 out; judging 3,000 in / 300 out), not from your actual outputs — a long pipeline answer or a wide rubric costs more than this quote");
  warnings.push("generation calls are an honest upper bound: if-gates counted at widest path, while-loops at max iterations (spec §9)");
  warnings.push(`deterministic validators: DISABLED — ${VALIDATORS_DISABLED_REASON}. Nothing here verifies executable output; the rubric judgment is the only assessment.`);
  if (plan.candidates.some((c) => c.strategy === "imported_output")) {
    warnings.push("one or more candidates is an EXISTING output graded without regeneration (A01): it adds no generation call, and it is not attested execution produced by this plan (spec §4.3)");
  }

  const blocking = planPreflightErrors(plan, steps);
  return {
    plan,
    planHash: hashPlan(plan),
    counts,
    estimatedGenerationCostUsd: genCost,
    estimatedJudgingCostUsd: judgeCost,
    estimatedTotalCostUsd: genCost === null || judgeCost === null ? null : Number((genCost + judgeCost).toFixed(8)),
    pricingStatus: genCost === null || judgeCost === null ? "unknown" : "priced",
    pricingBasis: pricing.basis,
    pricingAsOf: pricing.asOf,
    rates: Object.entries(pricing.rates).map(([model, r]) => ({
      model, usdPer1KInput: r.in, usdPer1KOutput: r.out, source: pricing.sourceByModel[model],
    })),
    warnings: [...blocking.map((e) => `PLAN BLOCKED: ${e}`), ...warnings],
    blockingErrors: blocking,
  };
}

/** Public quote: read-only, writes nothing, and returns only the DTO fields
 *  the cost-approval dialog is allowed to show. */
export async function quoteBenchmark(opts: { userId: number; benchmarkId: number }): Promise<QuoteResult> {
  const { plan: _internal, ...quote } = await buildQuote(opts.userId, opts.benchmarkId);
  void _internal;
  return quote;
}

/** Read-only view of the workflow a draft would run, used for counting and
 *  preflight. Quoting must never write: only `start` freezes a version.
 *  An imported-output-only plan runs no workflow at all (A01). */
async function stepsForDraft(userId: number, b: typeof benchmarks.$inferSelect, draft: DraftPlan): Promise<SnapshotStep[]> {
  if (!planNeedsSnapshot(draft)) return SOLO_ONLY_STEPS;
  const projectId = b.sourceProjectId ?? (b.pipelineVersionId
    ? (await loadVersionDefinition(b.pipelineVersionId)).version.sourceProjectId
    : null);
  if (!projectId) throw new Error("Benchmark has no source project or version");
  return (await snapshotStepsFromProject(userId, projectId)).steps;
}

/** Does this plan execute anything, or only grade outputs the owner already
 *  has? Imported-only plans never capture a version and never spend a
 *  generation call. */
function planNeedsSnapshot(draft: Pick<DraftPlan, "candidates">): boolean {
  const candidates = expandDraftCandidates(draft.candidates);
  return candidates.some((c) => c.strategy !== "imported_output");
}

export async function approveBenchmarkSpend(opts: {
  userId: number; benchmarkId: number; planHash: string; ceilingUsd?: number;
}): Promise<number> {
  const db = getDb();
  const [b] = await db.select().from(benchmarks)
    .where(and(eq(benchmarks.id, opts.benchmarkId), eq(benchmarks.ownerId, opts.userId))).limit(1);
  if (!b) throw new Error("not_found_or_not_authorized");
  // A draft is approved before it runs. A cancelled/partial/failed plan can
  // also be approved again, because RESUMING spends again (A06) — the hash
  // check below still binds the approval to the exact frozen plan.
  if (!["draft", "cancelled", "partial", "failed"].includes(b.state)) {
    throw new Error(`no spend approval can be granted while the benchmark is '${b.state}'`);
  }
  // The approved hash is recomputed server-side: a caller must not be able to
  // record an approval against a hash it was never shown (A06).
  const { plan, counts, blockingErrors } = await buildQuote(opts.userId, opts.benchmarkId);
  if (blockingErrors.length) throw new Error(`plan_not_executable: ${blockingErrors.join("; ")}`);
  if (hashPlan(plan) !== opts.planHash) throw new Error("plan_changed — re-quote and approve the plan you were actually shown (A06)");
  const [res] = await db.insert(spendApprovals).values({
    actorId: opts.userId,
    payerId: opts.userId, // owner-funded private tests (D4/P1 default); never inferred otherwise
    purpose: "private_evaluation",
    planHash: opts.planHash,
    planSnapshot: JSON.stringify(plan),
    bindings: collectBindings(plan),
    limits: { maxCalls: counts.generationCalls + counts.judgingCalls, maxRuntimeSeconds: Math.ceil(plan.limits.deadlineMs / 1000) },
    spendCeilingUsd: opts.ceilingUsd != null ? opts.ceilingUsd.toFixed(2) : null,
    status: "active",
    policyVersion: "v2-p2b-1",
    expiresAt: new Date(Date.now() + 24 * 3600_000),
  });
  return Number((res as { insertId: number }).insertId);
}

function collectBindings(plan: BenchmarkCallPlan): Array<{ providerId: number; model: string }> {
  const out = new Map<number, Set<string>>();
  const add = (pid: number | null | undefined, model: string | null | undefined) => {
    if (!pid) return;
    if (!out.has(pid)) out.set(pid, new Set());
    if (model) out.get(pid)!.add(model);
  };
  for (const j of plan.judges) add(j.providerId, j.model);
  for (const c of plan.candidates) add(c.overrideProviderId, c.overrideModel ?? null);
  return [...out.entries()].flatMap(([providerId, models]) =>
    models.size ? [...models].map((model) => ({ providerId, model })) : [{ providerId, model: "*" }]);
}

// ─── Start (freeze + fan-out materialization) ───────────────────────

export async function startBenchmark(opts: {
  userId: number; benchmarkId: number; planHash: string; spendApprovalId: number; idempotencyKey?: string;
}): Promise<{ ok: true; state: string } | { ok: false; error: string }> {
  const db = getDb();
  const [b] = await db.select().from(benchmarks)
    .where(and(eq(benchmarks.id, opts.benchmarkId), eq(benchmarks.ownerId, opts.userId))).limit(1);
  if (!b) return { ok: false, error: "not_found_or_not_authorized" };
  if (b.state !== "draft") return { ok: true, state: b.state }; // idempotent

  const [approval] = await db.select().from(spendApprovals)
    .where(and(eq(spendApprovals.id, opts.spendApprovalId), eq(spendApprovals.actorId, opts.userId))).limit(1);
  if (!approval || approval.status !== "active") return { ok: false, error: "spend approval missing or not active" };
  if (approval.expiresAt && approval.expiresAt < new Date()) return { ok: false, error: "spend approval expired — re-quote and re-approve" };
  if (approval.planHash !== opts.planHash) return { ok: false, error: "plan_changed — approval was granted for a different plan (A06)" };

  if (!b.sourceProjectId) return { ok: false, error: "Benchmark has no source project" };
  if (approval.purpose !== "private_evaluation" || approval.payerId !== opts.userId) {
    return { ok: false, error: "spend approval is not an owner-funded private_evaluation approval" };
  }
  const needsSnapshot = planNeedsSnapshot(JSON.parse(String(b.plan)) as DraftPlan);

  // 1 — validate and verify the approved hash BEFORE writing anything. The
  //     quote derivation is the same function the quote and approval used, so
  //     an untouched draft matches; any real edit (or workflow edit, which
  //     changes the call counts) refuses to start until re-approved (A06).
  const { plan: approvedPlan, blockingErrors } = await buildQuote(opts.userId, b.id);
  if (blockingErrors.length) return { ok: false, error: blockingErrors.join("; ") };
  if (hashPlan(approvedPlan) !== opts.planHash) {
    return { ok: false, error: "plan_changed — the plan differs from the approved quote; obtain a new quote and approval (A06)" };
  }

  // 2 — provider bindings re-checked at spend time, not just at draft time.
  await assertOwnerProviders(opts.userId, [
    ...approvedPlan.judges.map((j) => j.providerId),
    ...approvedPlan.candidates.map((c) => c.overrideProviderId).filter((v): v is number => typeof v === "number"),
  ]);

  // 3 — freeze the immutable snapshot (only when something must run), then
  //     materialize per-candidate versions SEQUENTIALLY. Each materialization
  //     allocates the next version number for (owner, project); running them
  //     concurrently just makes them collide on the unique index and retry, so
  //     ordering them here removes the contention we would otherwise absorb.
  const captured = needsSnapshot
    ? await captureVersionFromProject(opts.userId, b.sourceProjectId, { designerMethod: "manual" })
    : null;
  const recheck = planPreflightErrors(approvedPlan, captured?.definition.steps ?? []);
  if (recheck.length) return { ok: false, error: recheck.join("; ") };

  const candidates: CandidateSpec[] = [];
  for (const c of approvedPlan.candidates) {
    if (c.strategy === "imported_output") { candidates.push(c); continue; } // A01: nothing materialized
    const baseVersionId = captured!.versionId;
    if (c.strategy === "solo_baseline") {
      candidates.push({ ...c, baseVersionId: await soloBaselineVersion(opts.userId, baseVersionId, c.baselinePrompt ?? "") });
      continue;
    }
    const needsOverride = Boolean(c.overrideModel || c.overrideProviderId);
    candidates.push({
      ...c,
      baseVersionId: needsOverride ? await materializeOverrideVersion(opts.userId, baseVersionId, c) : baseVersionId,
    });
  }

  // 4 — materialization must not have changed the approved intent: candidate
  //     version IDs are excluded from the hash, everything else must still match.
  const plan: BenchmarkCallPlan = { ...approvedPlan, candidates };
  const finalHash = hashPlan(plan);
  if (finalHash !== opts.planHash) return { ok: false, error: "plan_changed — the frozen plan differs from the approved quote; obtain a new quote and approval (A06)" };

  await db.transaction(async (tx) => {
    await tx.insert(benchmarkCases).values(plan.cases.map((c, i) => ({
      benchmarkId: b.id, stableCaseId: c.stableCaseId, caseOrder: i + 1,
      inputText: c.inputText, origin: c.origin ?? "user",
      baseCaseId: c.baseCaseId ?? null, expectedOutput: c.expectedOutput ?? null,
      contentHash: sha256(c.inputText),
    })));
    await tx.insert(benchmarkCandidates).values(plan.candidates.map((c) => ({
      benchmarkId: b.id, stableCandidateId: c.stableCandidateId, strategy: c.strategy,
      workflowVersionId: c.strategy === "imported_output" ? null : c.baseVersionId || null,
      importedResponseId: c.importedResponseId ?? null,
      baselinePrompt: c.baselinePrompt ?? null,
      requestedModel: c.overrideModel ?? null,
      requestedProviderId: c.overrideProviderId ?? null,
      stepResolutionPolicy: c.strategy === "imported_output" ? null
        : c.overrideModel || c.overrideProviderId
          ? { mode: "override_all" as const, overrideModel: c.overrideModel, overrideProviderId: c.overrideProviderId }
          : { mode: "as_configured" as const },
      decodingSnapshot: c.decoding,
    })));
    await tx.update(benchmarks).set({
      pipelineVersionId: captured?.versionId ?? null,
      plan: JSON.stringify(plan),
      planHash: finalHash,
      spendApprovalId: opts.spendApprovalId,
      rubricRef: plan.rubric.versionRef,
      judgeConfigRef: `panel:${plan.judges.length}`,
      state: "queued",
      idempotencyKey: opts.idempotencyKey ?? sha256(`bm-${b.id}-${finalHash}`).slice(0, 60),
      startedAt: null,
    }).where(eq(benchmarks.id, b.id));
    await tx.update(spendApprovals).set({ status: "consumed" }).where(eq(spendApprovals.id, opts.spendApprovalId));
  });

  await ensureChildRuns(b.id);
  return { ok: true, state: "queued" };
}

async function soloBaselineVersion(userId: number, baseVersionId: number, baselinePrompt: string): Promise<number> {
  const { version } = await loadVersionDefinition(baseVersionId);
  const db = getDb();
  const [project] = version.sourceProjectId
    ? await db.select().from(projects).where(eq(projects.id, version.sourceProjectId)).limit(1)
    : [undefined];
  const step: SnapshotStep = {
    stepOrder: 1, name: "Frontier solo baseline", role: "builder",
    systemPrompt: baselinePrompt || "Answer the task directly and completely, using your own knowledge. No intermediate steps or tools.",
    stepType: "agent", providerId: project?.defaultProviderId ?? null, model: null,
    temperature: "0.7", maxTokens: 4096, ifConfig: null, whileConfig: null,
  };
  const def: VersionDefinition = { schemaVersion: 1, steps: [step], pipelineConfig: null, sourceAgentIds: [null] };
  const { versionId } = await createVersionRow({
    ownerId: userId, sourceProjectId: version.sourceProjectId ?? null, definition: def,
    designerMethod: "manual", parentVersionId: baseVersionId,
  });
  return versionId;
}

async function ensureChildRuns(benchmarkId: number): Promise<void> {
  const db = getDb();
  const [b] = await db.select().from(benchmarks).where(eq(benchmarks.id, benchmarkId)).limit(1);
  const plan = JSON.parse(String(b.plan)) as BenchmarkCallPlan;
  const cases = await db.select().from(benchmarkCases).where(eq(benchmarkCases.benchmarkId, benchmarkId));
  const cands = await db.select().from(benchmarkCandidates).where(eq(benchmarkCandidates.benchmarkId, benchmarkId));
  const existing = await db.select({ logicalExecutionId: benchmarkRuns.logicalExecutionId }).from(benchmarkRuns)
    .where(eq(benchmarkRuns.benchmarkId, benchmarkId));
  const have = new Set(existing.map((r) => r.logicalExecutionId));
  for (const c of cases) {
    for (const cand of cands) {
      // Repeats are per candidate: an imported output exists once (A01).
      const candSpec = plan.candidates.find((p) => p.stableCandidateId === cand.stableCandidateId);
      const repeats = repeatsForCandidate(candSpec ?? { strategy: cand.strategy }, plan.generationRepeats);
      for (let r = 1; r <= repeats; r++) {
        const logical = `bm-${benchmarkId}-${c.stableCaseId}-${cand.stableCandidateId}-r${r}`;
        if (have.has(logical)) continue;
        await db.insert(benchmarkRuns).values({
          benchmarkId, caseId: c.id, candidateId: cand.id, replicationIndex: r,
          logicalExecutionId: logical, status: "pending",
        });
      }
    }
  }
}

// ─── Lease + execution (worker context) ─────────────────────────────

export async function acquireBenchmark(benchmarkId: number): Promise<string | null> {
  const db = getDb();
  const now = new Date();
  const token = randomUUID();
  const [res] = await db.update(benchmarks)
    .set({ state: "running", leaseToken: token, leaseExpiresAt: new Date(now.getTime() + LEASE_MS), startedAt: now })
    .where(and(
      eq(benchmarks.id, benchmarkId),
      or(
        eq(benchmarks.state, "queued"),
        and(eq(benchmarks.state, "running"), or(isNull(benchmarks.leaseExpiresAt), lte(benchmarks.leaseExpiresAt, now))),
      ),
    ));
  return ((res as unknown as { affectedRows?: number }).affectedRows ?? 0) > 0 ? token : null;
}

async function refetch(benchmarkId: number, leaseToken: string) {
  const db = getDb();
  const [b] = await db.select().from(benchmarks).where(eq(benchmarks.id, benchmarkId)).limit(1);
  return b && b.leaseToken === leaseToken && b.state === "running" ? b : null;
}

export async function executeBenchmark(opts: { benchmarkId: number; leaseToken: string }): Promise<void> {
  const db = getDb();
  let b = await refetch(opts.benchmarkId, opts.leaseToken);
  if (!b) return;
  const plan = JSON.parse(String(b.plan)) as BenchmarkCallPlan;
  const deadline = Date.now() + plan.limits.deadlineMs;

  const runs = await db.select().from(benchmarkRuns).where(eq(benchmarkRuns.benchmarkId, b.id));
  const cases = await db.select().from(benchmarkCases).where(eq(benchmarkCases.benchmarkId, b.id));
  const cands = await db.select().from(benchmarkCandidates).where(eq(benchmarkCandidates.benchmarkId, b.id));
  const caseById = new Map(cases.map((c) => [c.id, c]));
  const candById = new Map(cands.map((c) => [c.id, c]));
  // Which project hosts each candidate's snapshot: swarm_runs.project_id is
  // NOT NULL with a FK, so an unresolvable version falls back to the
  // benchmark's own source project; failing that the child is failed with no
  // provider call and no placeholder row.
  const versionIds = [...new Set(cands.map((c) => c.workflowVersionId).filter((v): v is number => !!v))];
  const projectOfVersion = new Map<number, number | null>();
  if (versionIds.length) {
    const rows = await db.select({ id: pipelineVersions.id, sp: pipelineVersions.sourceProjectId })
      .from(pipelineVersions).where(inArray(pipelineVersions.id, versionIds));
    for (const r of rows) projectOfVersion.set(r.id, r.sp ?? null);
  }

  // Phase 1 — generation children (skip anything already terminal).
  for (const run of runs) {
    b = await refetch(opts.benchmarkId, opts.leaseToken);
    if (!b) return; // lease lost or cancelled out from under us
    if (b.cancelRequestedAt) { await finalize(b.id, opts.leaseToken, "cancelled"); return; }
    if (Date.now() > deadline) { await runJudgments(b.id, opts.leaseToken); await finalize(b.id, opts.leaseToken, "partial"); return; }
    if (run.status !== "pending") continue;

    const kase = caseById.get(run.caseId);
    const cand = candById.get(run.candidateId);
    const caseInput = String(kase?.inputText ?? "").trim();
    if (!kase || !cand || !caseInput) {
      await failChild(run.id, b.id, "child has no resolvable case input or candidate binding — no call made");
      continue;
    }
    if (cand.strategy === "imported_output") {
      // A01: grade the owner's existing output. No provider call, therefore no
      // ledger attempt and nothing charged to the approved plan.
      await resolveImportedChild(run.id, cand, b);
      continue;
    }
    if (!cand.workflowVersionId) {
      await failChild(run.id, b.id, `candidate "${cand.stableCandidateId}" has no workflow version to execute`);
      continue;
    }
    const hostProjectId = projectOfVersion.get(cand.workflowVersionId) ?? null;
    if (!(hostProjectId ?? b.sourceProjectId)) {
      await failChild(run.id, b.id, "candidate snapshot has no host project — no call made");
      continue;
    }
    const execProjectId = hostProjectId ?? b.sourceProjectId!;
    try {
      let swarmRunId = run.linkedSwarmRunId ?? null;
      if (!swarmRunId) {
        const [ins] = await db.insert(swarmRuns).values({
          projectId: execProjectId, userId: b.ownerId, userPrompt: caseInput,
          status: "pending", pipelineVersion: "benchmark-v2", agentsUsed: [],
          runParams: { source: "execute", prompt: caseInput, snapshotVersionId: cand.workflowVersionId, stateless: true, callPlanId: b.id },
        });
        swarmRunId = Number((ins as { insertId: number }).insertId);
        await db.update(benchmarkRuns).set({ linkedSwarmRunId: swarmRunId, status: "running", startedAt: new Date() })
          .where(eq(benchmarkRuns.id, run.id));
      }
      await executeSwarmRun({ swarmRunId, userId: b.ownerId });
      const [finalRun] = await db.select().from(swarmRuns).where(eq(swarmRuns.id, swarmRunId)).limit(1);
      const [resp] = finalRun?.finalResponseId
        ? await db.select().from(agentResponses).where(eq(agentResponses.id, finalRun.finalResponseId)).limit(1)
        : await db.select().from(agentResponses).where(eq(agentResponses.swarmRunId, swarmRunId)).orderBy(desc(agentResponses.id)).limit(1);
      const ok = finalRun?.status === "completed" && !!resp?.content;
      const usage = await runTokenUsage(swarmRunId);
      const { definition } = await loadVersionDefinition(cand.workflowVersionId!);
      await db.update(benchmarkRuns).set({
        status: ok ? "completed" : "failed",
        outputText: resp?.content ?? null,
        outputHash: resp?.content ? sha256(resp.content) : null,
        finishedAt: new Date(),
        errorSummary: ok ? null : safeStr(finalRun?.error ?? "linked run did not complete"),
        executorMetadata: { stepModels: stepResolutionsFromSnapshot(definition).map((s) => ({ stepOrder: s.stepOrder, requestedModel: s.requestedModel ?? "" })), providerRoute: undefined, revisionExposed: undefined },
        usageSummary: usage,
      }).where(eq(benchmarkRuns.id, run.id));
      await recordCallAttempt({
        operationKind: "generation", operationId: run.id, benchmarkId: b.id,
        purpose: "private_evaluation", actorId: b.ownerId, payerId: b.ownerId,
        providerRefId: null, requestedModel: cand.requestedModel ?? "workflow-steps",
        pricingRoute: singleRouteOfSnapshot(definition),
        outcome: ok ? "success" : "failed",
        promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
        errorMessage: ok ? null : finalRun?.error ?? null,
      });
    } catch (err) {
      logger.warn("[benchmark] generation child failed", { benchmarkId: b.id, runId: run.id, error: (err as Error).message });
      await db.update(benchmarkRuns).set({ status: "failed", finishedAt: new Date(), errorSummary: safeStr((err as Error).message) })
        .where(eq(benchmarkRuns.id, run.id));
      await recordCallAttempt({
        operationKind: "generation", operationId: run.id, benchmarkId: b.id,
        purpose: "private_evaluation", actorId: b.ownerId, payerId: b.ownerId,
        providerRefId: null, requestedModel: "workflow-steps",
        outcome: /timeout|network|ECONN/i.test((err as Error).message) ? "uncertain" : "failed",
        errorMessage: (err as Error).message,
      });
    }
  }

  // Phase 2 — judgments; Phase 3 — summary + terminal state.
  await runJudgments(b.id, opts.leaseToken);
}

async function runJudgments(benchmarkId: number, leaseToken: string): Promise<void> {
  await judgePhase(benchmarkId);
  const b = await refetch(benchmarkId, leaseToken);
  if (!b) return;
  await finalizeCompleted(benchmarkId, leaseToken);
}

/** A child that cannot be executed at all (unresolvable input or binding).
 *  It fails WITHOUT a provider call, so no call attempt is recorded — the
 *  ledger lists calls that happened, never calls that were skipped. */
async function failChild(runId: number, benchmarkId: number, reason: string): Promise<void> {
  const db = getDb();
  await db.update(benchmarkRuns).set({ status: "failed", finishedAt: new Date(), errorSummary: safeStr(reason) })
    .where(eq(benchmarkRuns.id, runId));
  logger.warn("[benchmark] child failed before any provider call", { benchmarkId, runId, reason });
}

/** A01: the child's text already exists, so "executing" it means copying and
 *  hashing what is there. Ownership is re-checked here rather than trusted
 *  from draft time, and the origin is recorded so P3 can never present this as
 *  execution performed by this plan (spec §4.1, §4.3). */
async function resolveImportedChild(
  runId: number,
  cand: typeof benchmarkCandidates.$inferSelect,
  b: typeof benchmarks.$inferSelect,
): Promise<void> {
  const db = getDb();
  const text = cand.importedResponseId
    ? await (async () => {
      const [row] = await db
        .select({
          content: agentResponses.content, model: agentResponses.metadata,
          createdAt: agentResponses.createdAt, runOwner: swarmRuns.userId, runId: swarmRuns.id,
        })
        .from(agentResponses)
        .innerJoin(swarmRuns, eq(agentResponses.swarmRunId, swarmRuns.id))
        .where(eq(agentResponses.id, cand.importedResponseId!))
        .limit(1);
      return row && row.runOwner === b.ownerId ? row : null;
    })()
    : null;

  if (!text || !String(text.content ?? "").trim()) {
    await failChild(runId, b.id, "the imported output is no longer available or is not this owner's — nothing was graded");
    return;
  }
  await db.update(benchmarkRuns).set({
    status: "completed",
    outputText: text.content,
    outputHash: sha256(text.content),
    finishedAt: new Date(),
    importedProvenance: {
      kind: "owned_run", sourceResponseId: cand.importedResponseId ?? undefined,
      sourceSwarmRunId: text.runId, reportedModel: text.model?.model ?? undefined,
      reportedAt: text.createdAt?.toISOString?.(),
    },
    executorMetadata: { stepModels: [], providerRoute: undefined, revisionExposed: undefined },
    usageSummary: { promptTokens: 0, completionTokens: 0 },
  }).where(eq(benchmarkRuns.id, runId));
}

async function runTokenUsage(swarmRunId: number): Promise<{ promptTokens: number; completionTokens: number }> {
  const db = getDb();
  const rows = await db.select({ meta: agentResponses.metadata }).from(agentResponses).where(eq(agentResponses.swarmRunId, swarmRunId));
  let prompt = 0, completion = 0;
  for (const r of rows) {
    const t = (r.meta as { tokensUsed?: { prompt?: number; completion?: number } } | null)?.tokensUsed;
    prompt += t?.prompt ?? 0; completion += t?.completion ?? 0;
  }
  return { promptTokens: prompt, completionTokens: completion };
}

export async function judgePhase(benchmarkId: number): Promise<void> {
  const db = getDb();
  const [b] = await db.select().from(benchmarks).where(eq(benchmarks.id, benchmarkId)).limit(1);
  const plan = JSON.parse(String(b.plan)) as BenchmarkCallPlan;
  const runs = await db.select().from(benchmarkRuns).where(and(eq(benchmarkRuns.benchmarkId, benchmarkId), eq(benchmarkRuns.status, "completed")));
  const cases = await db.select().from(benchmarkCases).where(eq(benchmarkCases.benchmarkId, benchmarkId));
  const caseById = new Map(cases.map((c) => [c.id, c]));

  if (plan.judgmentKind === "rubric" || plan.executionMode === "grade_only") {
    for (const run of runs) {
      for (const judge of plan.judges) {
        const dup = await db.select({ id: benchmarkJudgments.id }).from(benchmarkJudgments)
          .where(and(eq(benchmarkJudgments.runId, run.id), eq(benchmarkJudgments.judgeSlot, judge.slot), eq(benchmarkJudgments.judgePromptVersion, JUDGE_PROMPT_VERSION)))
          .limit(1);
        if (dup.length) continue; // idempotent re-entry
        const kase = caseById.get(run.caseId)!;
        const prompt = buildRubricJudgePrompt({
          taskInput: String(kase.inputText), candidateOutput: String(run.outputText ?? ""),
          rubric: plan.rubric,
          ...(kase.expectedOutput ? { referenceMaterial: String(kase.expectedOutput) } : {}),
        });
        const startedAt = new Date();
        try {
          const out = await generateJudgeCall({ judge, ownerId: b.ownerId, prompt });
          const verdict = parseAndValidateRubricVerdict(out.content, plan.rubric);
          const [res] = await db.insert(benchmarkJudgments).values({
            benchmarkId, runId: run.id, judgeSlot: judge.slot,
            rubricVersionRef: plan.rubric.versionRef, judgePromptVersion: JUDGE_PROMPT_VERSION,
            judgeModel: out.model, orientation: "none", kind: "rubric",
            dimensionScores: verdict.dimensionScores ?? null,
            normalizedAggregate: verdict.normalizedAggregate ?? null,
            rationale: verdict.rationale ?? null,
            status: verdict.status,
            validationNotes: verdict.validationNotes ?? null,
          });
          await recordCallAttempt({
            operationKind: "judgment", operationId: Number((res as { insertId: number }).insertId), benchmarkId,
            purpose: "private_evaluation", actorId: b.ownerId, payerId: b.ownerId,
            providerRefId: judge.providerId, requestedModel: judge.model, returnedModel: out.model,
            outcome: "success", promptTokens: out.promptTokens, completionTokens: out.completionTokens,
            startedAt, finishedAt: new Date(),
          });
        } catch (err) {
          const msg = (err as Error).message || "";
          const [res] = await db.insert(benchmarkJudgments).values({
            benchmarkId, runId: run.id, judgeSlot: judge.slot,
            rubricVersionRef: plan.rubric.versionRef, judgePromptVersion: JUDGE_PROMPT_VERSION,
            judgeModel: judge.model, orientation: "none", kind: "rubric", status: "failed",
          });
          await recordCallAttempt({
            operationKind: "judgment", operationId: Number((res as { insertId: number }).insertId), benchmarkId,
            purpose: "private_evaluation", actorId: b.ownerId, payerId: b.ownerId,
            providerRefId: judge.providerId, requestedModel: judge.model,
            outcome: /timeout|network|ECONN/i.test(msg) ? "uncertain" : "failed",
            startedAt, finishedAt: new Date(), errorMessage: msg,
          });
        }
      }
    }
    return;
  }

  // Pairwise: exactly two candidates, paired per case+replication, blinded
  // recorded orientation (hash-deterministic so retries reuse the pairing).
  const cands = await db.select().from(benchmarkCandidates).where(eq(benchmarkCandidates.benchmarkId, benchmarkId));
  const candById = new Map(cands.map((c) => [c.id, c]));
  if (plan.candidates.length !== 2) return; // rejected by preflight before start; rubric path is the only other shape
  // Only the repeats the plan declared as paired are judged (contracts §9:
  // never an implicit cross-product of every repeat).
  const pairedRepeats = new Set(pairedRepeatsOf(plan));
  const byPair = new Map<string, typeof runs[number][] >();
  for (const run of runs) {
    if (!pairedRepeats.has(run.replicationIndex ?? 1)) continue;
    const key = `${run.caseId}-r${run.replicationIndex}`;
    byPair.set(key, [...(byPair.get(key) ?? []), run]);
  }
  for (const [, pairRuns] of byPair) {
    if (pairRuns.length !== 2) continue;
    const ordered = [...pairRuns].sort((x, y) => (candById.get(x.candidateId)!.stableCandidateId < candById.get(y.candidateId)!.stableCandidateId ? -1 : 1));
    const [first, second] = ordered;
    for (const judge of plan.judges) {
      const orientation = parseInt(sha256(`${first.id}:${second.id}:${judge.slot}`).slice(0, 4), 16) % 2 ? "ab" : "ba";
      const dup = await db.select({ id: benchmarkJudgments.id }).from(benchmarkJudgments)
        .where(and(eq(benchmarkJudgments.runAId, first.id), eq(benchmarkJudgments.runBId, second.id), eq(benchmarkJudgments.judgeSlot, judge.slot), eq(benchmarkJudgments.judgePromptVersion, JUDGE_PROMPT_VERSION)))
        .limit(1);
      if (dup.length) continue;
      const kase = caseById.get(first.caseId)!;
      const presentedA = orientation === "ab" ? first : second;
      const presentedB = orientation === "ab" ? second : first;
      const prompt = buildPairwiseJudgePrompt({ taskInput: String(kase.inputText), outputA: String(presentedA.outputText ?? ""), outputB: String(presentedB.outputText ?? ""), rubric: plan.rubric });
      const startedAt = new Date();
      try {
        const out = await generateJudgeCall({ judge, ownerId: b.ownerId, prompt });
        let verdict = parseAndValidatePairwiseVerdict(out.content);
        if (orientation === "ba" && verdict.preference && verdict.preference !== "tie") {
          verdict = { ...verdict, preference: verdict.preference === "a" ? "b" : "a" };
        }
        const [res] = await db.insert(benchmarkJudgments).values({
          benchmarkId, runAId: first.id, runBId: second.id, judgeSlot: judge.slot,
          rubricVersionRef: plan.rubric.versionRef, judgePromptVersion: JUDGE_PROMPT_VERSION,
          judgeModel: out.model, orientation, kind: "pairwise",
          pairPreference: verdict.preference ?? null, rationale: verdict.rationale ?? null, status: verdict.status,
        });
        await recordCallAttempt({
          operationKind: "judgment", operationId: Number((res as { insertId: number }).insertId), benchmarkId,
          purpose: "private_evaluation", actorId: b.ownerId, payerId: b.ownerId,
          providerRefId: judge.providerId, requestedModel: judge.model, returnedModel: out.model,
          outcome: "success", promptTokens: out.promptTokens, completionTokens: out.completionTokens,
          startedAt, finishedAt: new Date(),
        });
      } catch (err) {
        // A failed pairwise call is still a spent call: it gets its own
        // judgment row (status failed) plus its ledger attempt, so coverage
        // and cost never silently disappear (spec §7.2, §9).
        const msg = (err as Error).message || "";
        const [res] = await db.insert(benchmarkJudgments).values({
          benchmarkId, runAId: first.id, runBId: second.id, judgeSlot: judge.slot,
          rubricVersionRef: plan.rubric.versionRef, judgePromptVersion: JUDGE_PROMPT_VERSION,
          judgeModel: judge.model, orientation, kind: "pairwise", status: "failed",
        });
        await recordCallAttempt({
          operationKind: "judgment", operationId: Number((res as { insertId: number }).insertId), benchmarkId,
          purpose: "private_evaluation", actorId: b.ownerId, payerId: b.ownerId,
          providerRefId: judge.providerId, requestedModel: judge.model,
          outcome: /timeout|network|ECONN/i.test(msg) ? "uncertain" : "failed",
          startedAt, finishedAt: new Date(), errorMessage: msg,
        });
      }
    }
  }
}

// ─── Summary (descriptive only) ─────────────────────────────────────

export async function computeSummary(benchmarkId: number): Promise<Record<string, unknown>> {
  const db = getDb();
  const [b] = await db.select().from(benchmarks).where(eq(benchmarks.id, benchmarkId)).limit(1);
  const plan = JSON.parse(String(b.plan)) as BenchmarkCallPlan;
  const runs = await db.select().from(benchmarkRuns).where(eq(benchmarkRuns.benchmarkId, benchmarkId));
  const judgments = await db.select().from(benchmarkJudgments).where(eq(benchmarkJudgments.benchmarkId, benchmarkId));
  const cands = await db.select().from(benchmarkCandidates).where(eq(benchmarkCandidates.benchmarkId, benchmarkId));
  const totals = await benchmarkLedgerTotals(benchmarkId);

  const perCandidate = cands.map((cand) => {
    const candRuns = runs.filter((r) => r.candidateId === cand.id);
    const completed = candRuns.filter((r) => r.status === "completed");
    const own = judgments.filter((j) => (j.runId != null && completed.some((r) => r.id === j.runId)) || (j.runAId != null && completed.some((r) => r.id === j.runAId)));
    const rubricOk = own.filter((j) => j.kind === "rubric" && j.status === "completed");
    const scores = rubricOk.map((j) => Number(j.normalizedAggregate)).filter(Number.isFinite);
    return {
      candidateId: cand.stableCandidateId, strategy: cand.strategy,
      // An imported output is not execution evidence for THIS plan (§4.1/§4.3),
      // so P3 must be able to tell the two apart without re-deriving it.
      provenance: cand.strategy === "imported_output"
        ? "graded_existing_output__not_executed_by_this_plan"
        : "platform_recorded_execution",
      runs: { planned: candRuns.length, completed: completed.length, failed: candRuns.filter((r) => r.status === "failed").length },
      judgments: { completed: rubricOk.length, parseFailed: own.filter((j) => j.status === "parse_failed").length, validationFailed: own.filter((j) => j.status === "validation_failed").length, callFailed: own.filter((j) => j.status === "failed").length },
      meanNormalizedScore0to1: scores.length ? Number((scores.reduce((a, x) => a + x, 0) / scores.length).toFixed(6)) : null,
      spread0to1: scores.length ? { min: Math.min(...scores), max: Math.max(...scores) } : null,
    };
  });

  // Descriptive agreement among the judges actually used (§7.2 lists it). This
  // is a description of these panel scores — not an inter-rater reliability
  // statistic, and no inference is drawn from it.
  const panels = new Map<number, number[]>();
  for (const j of judgments) {
    if (j.kind !== "rubric" || j.status !== "completed" || j.runId == null) continue;
    const score = Number(j.normalizedAggregate);
    if (!Number.isFinite(score)) continue;
    panels.set(j.runId, [...(panels.get(j.runId) ?? []), score]);
  }
  const fullPanels = [...panels.values()].filter((scores) => scores.length >= 2);
  const meanAbsDiff = fullPanels.length
    ? fullPanels.reduce((acc, scores) => {
      const mean = scores.reduce((a, x) => a + x, 0) / scores.length;
      return acc + scores.reduce((a, x) => a + Math.abs(x - mean), 0) / scores.length;
    }, 0) / fullPanels.length
    : null;
  const judgeAgreement = {
    panelsGradedByTwoOrMoreJudges: fullPanels.length,
    panelsPlanned: runs.filter((r) => r.status === "completed").length,
    meanAbsoluteDeviation0to1: meanAbsDiff == null ? null : Number(meanAbsDiff.toFixed(6)),
    widestPanelSpread0to1: fullPanels.length
      ? Number(Math.max(...fullPanels.map((s) => Math.max(...s) - Math.min(...s))).toFixed(6))
      : null,
    note: "observed dispersion among the judges in this panel only; not an inter-rater reliability measure and not an inference about any model",
  };

  const summary: Record<string, unknown> = {
    descriptiveOnly: true,
    executionMode: plan.executionMode,
    rubric: plan.rubric.versionRef,
    judges: plan.judges.map((j) => ({ slot: j.slot, model: j.model })),
    // Disclosed, not omitted: no deterministic validation ran, and why (§7.1).
    validators: {
      enabled: (plan.validators ?? []).filter((v) => (v as { enabled?: boolean }).enabled).length,
      configured: (plan.validators ?? []).length,
      status: "disabled",
      reason: VALIDATORS_DISABLED_REASON,
    },
    judgeAgreement,
    perCandidate,
    costObserved: {
      knownUsd: totals.knownCostUsd, completeness: totals.costCompleteness,
      totalCalls: totals.totalCalls, uncertainCalls: totals.uncertainCalls, currency: "USD",
      // Different UNITS, stated rather than left for a reader to assume (§9:
      // uncertainty is disclosed, never hidden).
      observedOperations: { generation: totals.generationOperations, judgment: totals.judgmentOperations },
      plannedCalls: { generation: plan.counts.generationCalls, judging: plan.counts.judgingCalls },
      unitNote: "plannedCalls counts provider LLM calls; observedOperations counts logical operations, each carrying the summed usage of every call it made. They are not one-to-one comparable.",
    },
    scopeStatement: "These numbers describe ONLY the tested cases, models, judges and repeats recorded in this benchmark. They are not a percentage of objective quality, not inferential statistics, and not a certification.",
  };
  if (plan.executionMode !== "grade_only") {
    const scored = perCandidate.filter((p) => p.meanNormalizedScore0to1 != null)
      .sort((x, y) => Number(y.meanNormalizedScore0to1) - Number(x.meanNormalizedScore0to1));
    const pairwise = judgments.filter((j) => j.kind === "pairwise" && j.status === "completed");
    if (pairwise.length) {
      const w = { candidateWins_first: 0, second: 0, tie: 0 };
      for (const j of pairwise) { if (j.pairPreference === "a") w.candidateWins_first++; else if (j.pairPreference === "b") w.second++; else w.tie++; }
      summary.pairwiseTally = { ...w, note: "blinded preference, recorded orientation" };
    }
    summary.highestObserved = scored.length === 0 ? "insufficient-evidence"
      : (scored.length > 1 && Number(scored[0].meanNormalizedScore0to1) === Number(scored[1].meanNormalizedScore0to1)) ? "tie-or-insufficient-evidence"
        : scored[0].candidateId;
    summary.highestObservedScope = "highest observed score among these tested conditions only";
  }
  return summary;
}

/** Planned judgment rows over the children that actually completed. Rubric
 *  grading judges every completed run; pairwise judges each completed PAIR
 *  (only for declared paired repeats), so runs × judges would be wrong (§9). */
function expectedJudgmentCount(
  plan: BenchmarkCallPlan,
  runs: Array<{ status: string; caseId: number; replicationIndex: number | null }>,
): number {
  const completed = runs.filter((r) => r.status === "completed");
  const J = Math.max(plan.judges.length, 1);
  if (plan.judgmentKind !== "pairwise") return completed.length * J;
  const paired = new Set(pairedRepeatsOf(plan));
  const perPair = new Map<string, number>();
  for (const r of completed) {
    if (!paired.has(r.replicationIndex ?? 1)) continue;
    const key = `${r.caseId}-r${r.replicationIndex}`;
    perPair.set(key, (perPair.get(key) ?? 0) + 1);
  }
  return [...perPair.values()].filter((n) => n >= 2).length * J;
}

async function finalizeCompleted(benchmarkId: number, leaseToken: string): Promise<void> {
  const db = getDb();
  const [b] = await db.select().from(benchmarks).where(eq(benchmarks.id, benchmarkId)).limit(1);
  const plan = JSON.parse(String(b.plan)) as BenchmarkCallPlan;
  const runs = await db.select({
    status: benchmarkRuns.status, id: benchmarkRuns.id,
    caseId: benchmarkRuns.caseId, replicationIndex: benchmarkRuns.replicationIndex,
  }).from(benchmarkRuns).where(eq(benchmarkRuns.benchmarkId, benchmarkId));
  const judgments = await db.select({
    status: benchmarkJudgments.status, runId: benchmarkJudgments.runId,
  }).from(benchmarkJudgments).where(eq(benchmarkJudgments.benchmarkId, benchmarkId));
  const expectedJudgments = expectedJudgmentCount(plan, runs);
  const okJudgments = judgments.filter((j) => j.status === "completed").length;
  // §10.2: `completed` requires ALL planned logical outputs, judgments and
  // validators. A child that failed outright therefore makes the plan
  // `partial`, never `completed` — judging only the survivors would quietly
  // narrow the evidence. No child finished at all → `failed`.
  const completedChildren = runs.filter((r) => r.status === "completed").length;
  const allChildrenTerminal = runs.length > 0 && runs.every((r) => ["completed", "failed", "cancelled"].includes(r.status));
  const judgmentsComplete = expectedJudgments > 0 && okJudgments >= expectedJudgments;
  const state = !allChildrenTerminal ? "failed"
    : completedChildren === 0 ? "failed"
      : completedChildren === runs.length && judgmentsComplete ? "completed"
        : "partial";
  await finalize(benchmarkId, leaseToken, state);
}

async function finalize(benchmarkId: number, leaseToken: string, state: "completed" | "partial" | "failed" | "cancelled"): Promise<void> {
  const db = getDb();
  const summary = await computeSummary(benchmarkId);
  const totals = await benchmarkLedgerTotals(benchmarkId);
  const runs = await db.select({
    status: benchmarkRuns.status, caseId: benchmarkRuns.caseId, replicationIndex: benchmarkRuns.replicationIndex,
  }).from(benchmarkRuns).where(eq(benchmarkRuns.benchmarkId, benchmarkId));
  const [b] = await db.select({ plan: benchmarks.plan }).from(benchmarks).where(eq(benchmarks.id, benchmarkId)).limit(1);
  const plan = JSON.parse(String(b.plan)) as BenchmarkCallPlan;
  const judgments = await db.select({ status: benchmarkJudgments.status }).from(benchmarkJudgments).where(eq(benchmarkJudgments.benchmarkId, benchmarkId));
  const expected = expectedJudgmentCount(plan, runs);
  const complete = state === "completed" && judgments.length >= expected && judgments.every((j) => j.status === "completed");
  await db.update(benchmarks).set({
    state, leaseToken: null, leaseExpiresAt: null, finishedAt: new Date(),
    aggregateAvailability: complete ? "complete" : "incomplete",
    summary: JSON.stringify(summary), summaryComputedAt: new Date(),
    totalObservedCost: totals.knownCostUsd, costCompleteness: totals.costCompleteness,
  }).where(and(eq(benchmarks.id, benchmarkId), eq(benchmarks.leaseToken, leaseToken)));
}

// ─── Status / cancel / heal ─────────────────────────────────────────

export async function getBenchmarkProgress(opts: { userId: number; benchmarkId: number }) {
  const db = getDb();
  const [b] = await db.select().from(benchmarks)
    .where(and(eq(benchmarks.id, opts.benchmarkId), eq(benchmarks.ownerId, opts.userId))).limit(1);
  if (!b) return null;
  const runs = await db.select({ status: benchmarkRuns.status }).from(benchmarkRuns).where(eq(benchmarkRuns.benchmarkId, b.id));
  return {
    id: b.id, state: b.state, executionMode: b.executionMode, aggregateAvailability: b.aggregateAvailability,
    runs: { total: runs.length, completed: runs.filter((r) => r.status === "completed").length, failed: runs.filter((r) => r.status === "failed").length },
    summary: b.summary ? JSON.parse(String(b.summary)) : null,
    plan: b.plan ? JSON.parse(String(b.plan)) : null, planHash: b.planHash,
    costObservedUsd: b.totalObservedCost, costCompleteness: b.costCompleteness,
    createdAt: b.createdAt, finishedAt: b.finishedAt,
  };
}

export async function cancelBenchmark(opts: { userId: number; benchmarkId: number }): Promise<{ ok: boolean; state: string }> {
  const db = getDb();
  const [b] = await db.select().from(benchmarks)
    .where(and(eq(benchmarks.id, opts.benchmarkId), eq(benchmarks.ownerId, opts.userId))).limit(1);
  if (!b) return { ok: false, state: "not_found" };
  if (["completed", "partial", "failed", "cancelled"].includes(b.state)) return { ok: true, state: b.state };
  if (b.state === "draft") {
    await db.update(benchmarks).set({ state: "cancelled", finishedAt: new Date() }).where(eq(benchmarks.id, b.id));
    return { ok: true, state: "cancelled" };
  }
  await db.update(benchmarks).set({ cancelRequestedAt: new Date() }).where(eq(benchmarks.id, b.id));
  return { ok: true, state: b.state }; // worker finalizes as cancelled at next checkpoint
}

/** Continue a cancelled/interrupted benchmark under its FROZEN plan.
 *  - the approved plan hash must still match (A06);
 *  - already-completed children and judgments are never re-run — recorded
 *    `callAttempts` stay the historical record and any retry appends a new
 *    attempt rather than overwriting one;
 *  - a fresh, unconsumed spend approval is required because resuming spends
 *    again; `retryFailed` makes re-running failed children an explicit choice.
 */
export async function resumeBenchmark(opts: {
  userId: number; benchmarkId: number; spendApprovalId: number; retryFailed?: boolean;
}): Promise<{ ok: true; state: string; requeued: number } | { ok: false; error: string }> {
  const db = getDb();
  const [b] = await db.select().from(benchmarks)
    .where(and(eq(benchmarks.id, opts.benchmarkId), eq(benchmarks.ownerId, opts.userId))).limit(1);
  if (!b) return { ok: false, error: "not_found_or_not_authorized" };
  if (b.state === "draft") return { ok: false, error: "nothing to resume — the plan was never started" };
  if (b.state === "queued" || b.state === "running") return { ok: true, state: b.state, requeued: 0 }; // already in flight
  if (!["cancelled", "partial", "failed"].includes(b.state)) return { ok: false, error: `state '${b.state}' is terminal and cannot be resumed` };
  if (!b.planHash) return { ok: false, error: "no frozen plan hash on this benchmark" };

  const [approval] = await db.select().from(spendApprovals)
    .where(and(eq(spendApprovals.id, opts.spendApprovalId), eq(spendApprovals.actorId, opts.userId))).limit(1);
  if (!approval || approval.status !== "active") return { ok: false, error: "resume needs a fresh active spend approval (resuming spends again)" };
  if (approval.expiresAt && approval.expiresAt < new Date()) return { ok: false, error: "spend approval expired — re-quote and re-approve" };
  if (approval.planHash !== b.planHash) return { ok: false, error: "plan_changed — this approval is not for the frozen plan (A06)" };
  if (approval.purpose !== "private_evaluation" || approval.payerId !== opts.userId) {
    return { ok: false, error: "spend approval is not an owner-funded private_evaluation approval" };
  }

  const resumableStatuses = opts.retryFailed ? ["pending", "running", "failed"] : ["pending", "running"];
  const children = await db.select({
    id: benchmarkRuns.id, status: benchmarkRuns.status, caseId: benchmarkRuns.caseId,
    replicationIndex: benchmarkRuns.replicationIndex,
  }).from(benchmarkRuns).where(eq(benchmarkRuns.benchmarkId, b.id));
  const unfinished = children.filter((r) => resumableStatuses.includes(r.status));
  const plan = JSON.parse(String(b.plan)) as BenchmarkCallPlan;
  const judged = await db.select({ id: benchmarkJudgments.id }).from(benchmarkJudgments)
    .where(and(eq(benchmarkJudgments.benchmarkId, b.id), inArray(benchmarkJudgments.status, ["completed", "parse_failed", "validation_failed"])));
  const missingJudgments = expectedJudgmentCount(plan, children) - judged.length;
  if (unfinished.length === 0 && missingJudgments <= 0) return { ok: false, error: "nothing_left_to_do" };

  await db.transaction(async (tx) => {
    for (const child of unfinished) {
      // A retried child gets a FRESH execution row: the prior swarm run (and
      // its failure) stay as history, and the attempt ledger keeps both.
      await tx.update(benchmarkRuns).set({
        status: "pending", errorSummary: null, finishedAt: null, startedAt: null,
        linkedSwarmRunId: null, outputText: null, outputHash: null,
      }).where(eq(benchmarkRuns.id, child.id));
    }
    await tx.update(benchmarks).set({
      state: "queued", cancelRequestedAt: null, leaseToken: null, leaseExpiresAt: null, finishedAt: null,
    }).where(and(eq(benchmarks.id, b.id), eq(benchmarks.ownerId, opts.userId)));
    await tx.update(spendApprovals).set({ status: "consumed" }).where(eq(spendApprovals.id, opts.spendApprovalId));
  });

  await ensureChildRuns(b.id);
  return { ok: true, state: "queued", requeued: unfinished.length };
}

export async function healStaleBenchmarks(): Promise<number> {
  const db = getDb();
  const now = new Date();
  const stale = await db.select({ id: benchmarks.id }).from(benchmarks)
    .where(and(eq(benchmarks.state, "running"), or(isNull(benchmarks.leaseExpiresAt), lte(benchmarks.leaseExpiresAt, now))));
  for (const row of stale) {
    await db.update(benchmarks).set({ state: "queued", leaseToken: null, leaseExpiresAt: null }).where(eq(benchmarks.id, row.id));
  }
  return stale.length;
}

function sha256(s: string): string { return createHash("sha256").update(s).digest("hex"); }
function safeStr(s: unknown): string { return String(s ?? "").slice(0, 2000); }

export type { DraftPlan };
