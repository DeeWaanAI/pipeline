import { z } from "zod";

// ═══════════════════════════════════════════════════════════════════════
// OFFERING REDESIGN V2 — SHARED CONTRACTS (Technical Specification v2.0)
// ═══════════════════════════════════════════════════════════════════════
// Contracts layer only: NO imports from db/schema.ts. Every enum value below
// mirrors a `mysqlEnum` in the "OFFERING REDESIGN V2 (P1)" section of
// db/schema.ts and MUST stay byte-identical (cross-references in comments).
// Spec anchors: §3 (contracts row), §4 (purposes/modes), §5.3 (durable jobs),
// §6 (data model + scoring), §7 (rubrics, disclosure manifest), §9 (cost
// arithmetic), §10.1 (structured errors). Confirmed decisions D1 (grade-only
// needs no listing and no comparator) and D5 (tested model shown, revision
// availability disclosed) are encoded as contract-level constraints.

// ─── NUMERIC PRIMITIVES (spec §6.3, §9, §11) ─────────────────────────
// Scores, costs and money travel as DECIMAL STRINGS, never JS floats:
// settlement/aggregate math must be decimal-safe with deterministic rounding.
const DECIMAL_SIGNED_8_RE = /^-?\d+(?:\.\d{1,8})?$/; // DECIMAL(18,8) cost, DECIMAL(8,4)/(7,6) scores
const DECIMAL_UNSIGNED_2_RE = /^\d+(?:\.\d{1,2})?$/; // minor-unit money, DECIMAL(10,2) style

/** Signed decimal literal, ≤8 fraction digits (API cost / score vectors). */
export const DecimalStringSchema = z
  .string()
  .regex(DECIMAL_SIGNED_8_RE, "expected a decimal string with at most 8 fraction digits");
export type DecimalString = z.infer<typeof DecimalStringSchema>;

/**
 * Money transferred/settled: currency minor-unit accounting, 2 decimal places,
 * nonnegative. Never a float and never a settlement input to floating math.
 */
export const MinorAmountSchema = z
  .string()
  .regex(DECIMAL_UNSIGNED_2_RE, "expected a nonnegative amount with at most 2 fraction digits")
  .superRefine((value, ctx) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      ctx.addIssue({
        code: "custom",
        message: "amount must be finite and nonnegative",
      });
    }
  });
export type MinorAmount = z.infer<typeof MinorAmountSchema>;

/**
 * An unknown price is the literal "unknown" — never zero and never a fabricated
 * precise total (spec §9).
 */
export const CostOrUnknownSchema = z.union([DecimalStringSchema, z.literal("unknown")]);
export type CostOrUnknown = z.infer<typeof CostOrUnknownSchema>;

export const CurrencyCodeSchema = z.string().regex(/^[A-Z]{3,4}$/);
export type CurrencyCode = z.infer<typeof CurrencyCodeSchema>;

/** Mirrors db/schema.ts `benchmarks.costCompleteness` / `callAttempts.costCompleteness`. */
export const CostCompletenessSchema = z.enum(["complete", "partial", "unknown"]);
export type CostCompleteness = z.infer<typeof CostCompletenessSchema>;

/** sha-256 style hex digest: plan hash, definition hash, content/output hashes. */
export const Hash64Schema = z.string().regex(/^[0-9a-f]{64}$/);
export type Hash64 = z.infer<typeof Hash64Schema>;
export const IdSchema = z.number().int().positive();
export type Id = z.infer<typeof IdSchema>;
/** Actor-scoped operation key: start/cancel/resume/publish retries are idempotent (§5.3). */
export const IdempotencyKeySchema = z.string().min(1).max(120);
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;
/** Original test time and publication time are separate fields (§6.2). */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;
/** Opaque private/public artifact reference (object storage, not a download URL). */
export const OpaqueRefSchema = z.string().min(1).max(255);
export type OpaqueRef = z.infer<typeof OpaqueRefSchema>;

// ─── STRUCTURED ERROR CATALOG (spec §10.1) ───────────────────────────
/**
 * `not_found_or_not_authorized` is deliberately ONE code: separate 404/403
 * responses would leak the existence of another tenant's resource through error
 * verbosity. Never include cross-tenant detail in `message`.
 */
const V2_ERROR_CODE_VALUES = [
  "not_found_or_not_authorized",
  "invalid_plan",
  "plan_changed",
  "revision_changed",
  "provider_unavailable",
  "model_unavailable",
  "pricing_unapproved",
  "trial_exhausted",
  "capacity_limited",
  "unsafe_endpoint",
  "retryable_infrastructure",
] as const;

export const V2ErrorCodes = {
  NOT_FOUND_OR_NOT_AUTHORIZED: "not_found_or_not_authorized",
  INVALID_PLAN: "invalid_plan",
  PLAN_CHANGED: "plan_changed",
  REVISION_CHANGED: "revision_changed",
  PROVIDER_UNAVAILABLE: "provider_unavailable",
  MODEL_UNAVAILABLE: "model_unavailable",
  PRICING_UNAPPROVED: "pricing_unapproved",
  TRIAL_EXHAUSTED: "trial_exhausted",
  CAPACITY_LIMITED: "capacity_limited",
  UNSAFE_ENDPOINT: "unsafe_endpoint",
  RETRYABLE_INFRASTRUCTURE: "retryable_infrastructure",
} as const satisfies Record<string, (typeof V2_ERROR_CODE_VALUES)[number]>;

export const V2ErrorCodeSchema = z.enum(V2_ERROR_CODE_VALUES);
export type V2ErrorCode = z.infer<typeof V2ErrorCodeSchema>;

/** Sanitized error body: no prompts, keys, provider payloads or cross-tenant existence hints. */
export const V2ErrorResponseBodySchema = z.object({
  code: V2ErrorCodeSchema,
  message: z.string().min(1).max(500),
  retryable: z.boolean(),
  requestId: z.string().min(1),
});
export type V2ErrorResponseBody = z.infer<typeof V2ErrorResponseBodySchema>;

// ─── EXECUTION PURPOSES AND MODES (spec §4.2, §4.5, §6.1) ────────────

/**
 * Payer-authorization purpose of every spend. Mirrors
 * db/schema.ts `spendApprovals.purpose` and `callAttempts.purpose`.
 * An actor may use only their own enabled credentials; disabled purpose/payer
 * combinations must fail before enqueue (§4.5).
 */
export const ExecutionPurposeSchema = z.enum([
  "private_design",
  "private_evaluation",
  "seller_evidence",
  "buyer_execution",
  "trial",
  "community_evaluation",
]);
export type ExecutionPurpose = z.infer<typeof ExecutionPurposeSchema>;

/**
 * Evaluation modes. Mirrors db/schema.ts `benchmarks.executionMode`.
 * `grade_only` requires no listing, no second model and no frontier call (D1).
 */
export const BenchmarkExecutionModeSchema = z.enum([
  "grade_only",
  "compare_models",
  "compare_frontier_solo",
]);
export type BenchmarkExecutionMode = z.infer<typeof BenchmarkExecutionModeSchema>;

/** Benchmark states. Mirrors db/schema.ts `benchmarks.state` (§10.2). */
export const BenchmarkStateSchema = z.enum([
  "draft",
  "queued",
  "running",
  "paused",
  "completed",
  "partial",
  "failed",
  "cancelled",
]);
export type BenchmarkState = z.infer<typeof BenchmarkStateSchema>;

/**
 * Aggregate availability. Mirrors `benchmarks.aggregateAvailability`: missing or
 * mixed judgment coverage yields an INCOMPLETE summary, never silent reweighting
 * or zeros (spec §6.3, A07).
 */
export const AggregateAvailabilitySchema = z.enum(["none", "complete", "incomplete"]);
export type AggregateAvailability = z.infer<typeof AggregateAvailabilitySchema>;

/** Case origin. Mirrors `benchmarkCases.origin`; generated/paraphrase must be labelled (§4.1, §7.3). */
export const BenchmarkCaseOriginSchema = z.enum(["user", "generated", "paraphrase"]);
export type BenchmarkCaseOrigin = z.infer<typeof BenchmarkCaseOriginSchema>;

/** Candidate strategy. Mirrors `benchmarkCandidates.strategy`.
 *  `imported_output` (migration 027, spec §4.1/A01) graded an output that
 *  already existed instead of executing the workflow, so it must stay
 *  distinguishable in a published manifest rather than being reported as the
 *  nearest executable strategy. */
export const CandidateStrategySchema = z.enum(["pipeline", "solo_baseline", "imported_output"]);
export type CandidateStrategy = z.infer<typeof CandidateStrategySchema>;

/** Judgment kinds. Mirrors `benchmarkJudgments.kind` and `pairPreference`. */
export const JudgmentKindSchema = z.enum(["rubric", "pairwise"]);
export type JudgmentKind = z.infer<typeof JudgmentKindSchema>;
/**
 * Judge prompt variants (decision D12). THE canonical closed list — defined
 * once here and imported by the benchmark services. Optional framing overrides
 * are part of the frozen plan hash. Each variant asks the SAME rubric question in a meaningfully
 * different order/framing (anchored scale first, free comment first, checklist
 * first) while the judge still returns the same validated JSON shape.
 * An evidence-grade panel has 3 judges × 3 variants = 9 ratings per output.
 */
export const JUDGE_PROMPT_VARIANTS = ["anchored_scale", "comment_first", "checklist_first"] as const;
export const JudgePromptVariantSchema = z.enum(JUDGE_PROMPT_VARIANTS);
export type JudgePromptVariant = z.infer<typeof JudgePromptVariantSchema>;
export const JudgePromptKeySchema = z.enum(["default", ...JUDGE_PROMPT_VARIANTS]);
export type JudgePromptKey = z.infer<typeof JudgePromptKeySchema>;
export const JudgePromptOverrideSchema = z.object({
  system: z.string().max(2000),
  preface: z.string().max(4000),
}).strict();
export const JudgePromptOverridesSchema = z.partialRecord(JudgePromptKeySchema, JudgePromptOverrideSchema);
export type JudgePromptOverrides = z.infer<typeof JudgePromptOverridesSchema>;
export const PairPreferenceSchema = z.enum(["a", "b", "tie"]);
export type PairPreference = z.infer<typeof PairPreferenceSchema>;
/** Mirrors `benchmarkJudgments.orientation` (recorded/randomized for paired checks). */
export const JudgmentOrientationSchema = z.enum(["none", "ab", "ba"]);
export type JudgmentOrientation = z.infer<typeof JudgmentOrientationSchema>;
/** Mirrors `benchmarkJudgments.status`; parse failures must be disclosed, not dropped (§7.3). */
export const JudgmentStatusSchema = z.enum([
  "pending",
  "completed",
  "parse_failed",
  "validation_failed",
  "failed",
]);
export type JudgmentStatus = z.infer<typeof JudgmentStatusSchema>;
/** Mirrors `benchmarkRuns.status` (`uncertain` = outcome unknown after provider acceptance, §5.3). */
export const RunStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "uncertain",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;
/** Mirrors `callAttempts.outcome`. */
export const CallOutcomeSchema = z.enum(["success", "failed", "uncertain"]);
export type CallOutcome = z.infer<typeof CallOutcomeSchema>;
/** Mirrors `callAttempts.operationKind`. */
export const CallOperationKindSchema = z.enum([
  "generation",
  "judgment",
  "design",
  "narrative",
  "preparation",
]);
export type CallOperationKind = z.infer<typeof CallOperationKindSchema>;
/** Mirrors `evidencePublications.publicationKind` / `.provenance` (§6.2). */
export const PublicationKindSchema = z.enum(["seller", "community"]);
export type PublicationKind = z.infer<typeof PublicationKindSchema>;
export const EvidenceProvenanceSchema = z.enum([
  "platform_recorded",
  "user_reported",
  "legacy_import",
]);
export type EvidenceProvenance = z.infer<typeof EvidenceProvenanceSchema>;

/**
 * A model revision the provider does not expose is stated, never inferred from a
 * friendly model name (spec §6.2, §12.1).
 */
export const REVISION_NOT_EXPOSED = "not_exposed_by_provider";
export const RevisionNotExposedReasonSchema = z.literal(REVISION_NOT_EXPOSED);
export type RevisionNotExposedReason = z.infer<typeof RevisionNotExposedReasonSchema>;

// ─── SCORING (spec §6.3) ─────────────────────────────────────────────
/**
 * One per-dimension score with its DECLARED scale bounds. Values are decimal
 * strings; out-of-range, missing, NaN or malformed values are rejected rather
 * than coerced to zero (A07). `10.00` is representable because raw scores use the
 * DECIMAL(8,4) shape, not DECIMAL(3,2).
 *
 * NOTE: "weights are finite/nonnegative and sum to one after an explicit
 * validated normalization" is a rubric-level invariant and is enforced on
 * `RubricSchema` below (a single dimension row cannot see its own panel).
 */
export const NormalizedScoreSchema = z
  .object({
    dimension: z.string().min(1),
    rawScore: DecimalStringSchema,
    lowerBound: DecimalStringSchema,
    upperBound: DecimalStringSchema,
    weight: DecimalStringSchema,
    /** Declared-bounds normalization to [0,1]; computed deterministically. */
    normalizedScore: DecimalStringSchema.optional(),
  })
  .superRefine((score, ctx) => {
    const raw = Number(score.rawScore);
    const lower = Number(score.lowerBound);
    const upper = Number(score.upperBound);
    const weight = Number(score.weight);

    const reject = (field: string, reason: string) =>
      ctx.addIssue({
        code: "custom",
        message: `${field} ${reason} (spec §6.3: reject, never coerce to zero)`,
        path: [field],
      });

    if (!Number.isFinite(raw)) reject("rawScore", "must be a finite decimal (NaN rejected)");
    if (!Number.isFinite(lower)) reject("lowerBound", "must be a finite decimal");
    if (!Number.isFinite(upper)) reject("upperBound", "must be a finite decimal");
    if (Number.isFinite(lower) && Number.isFinite(upper) && upper <= lower) {
      reject("upperBound", "must be greater than lowerBound");
    }
    if (Number.isFinite(raw) && Number.isFinite(lower) && Number.isFinite(upper)) {
      if (raw < lower || raw > upper) reject("rawScore", "is outside its declared bounds");
    }
    if (!Number.isFinite(weight)) reject("weight", "must be a finite decimal");
    else if (weight < 0) reject("weight", "must be nonnegative");

    if (score.normalizedScore !== undefined) {
      const normalized = Number(score.normalizedScore);
      if (!Number.isFinite(normalized)) reject("normalizedScore", "must be a finite decimal");
      else if (normalized < 0 || normalized > 1) {
        reject("normalizedScore", "must be within [0,1]");
      }
    }
  });
export type NormalizedScore = z.infer<typeof NormalizedScoreSchema>;

/**
 * Aggregate for one candidate: normalized value in [0,1] (DECIMAL(7,6)) plus the
 * raw aggregate on its declared scale (DECIMAL(8,4)) and a clearly labelled
 * 0–100 display value. A score is not a percentage of objective quality nor a
 * probability of correctness (§6.3).
 */
export const AggregateScoreSchema = z
  .object({
    rawAggregate: DecimalStringSchema,
    lowerBound: DecimalStringSchema,
    upperBound: DecimalStringSchema,
    /** DECIMAL(7,6) shape: weighted sum of [0,1]-normalized dimensions. */
    normalizedAggregate: DecimalStringSchema,
    /** Display-only 0–100 rubric score; label it as a rubric score in UI copy. */
    displayScore0To100: DecimalStringSchema,
    complete: z.boolean(),
    missingJudgmentCount: z.number().int().nonnegative(),
  })
  .superRefine((aggregate, ctx) => {
    const normalized = Number(aggregate.normalizedAggregate);
    if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) {
      ctx.addIssue({
        code: "custom",
        message: "normalizedAggregate must be finite and within [0,1]",
        path: ["normalizedAggregate"],
      });
    }
    const display = Number(aggregate.displayScore0To100);
    if (!Number.isFinite(display) || display < 0 || display > 100) {
      ctx.addIssue({
        code: "custom",
        message: "displayScore0To100 must be finite and within [0,100]",
        path: ["displayScore0To100"],
      });
    }
    if (!aggregate.complete && aggregate.missingJudgmentCount === 0) {
      ctx.addIssue({
        code: "custom",
        message: "an incomplete aggregate must report its missing judgment count",
        path: ["missingJudgmentCount"],
      });
    }
  });
export type AggregateScore = z.infer<typeof AggregateScoreSchema>;

/** Rubric dimension definition with anchors and normalized weight (§7.1, §6.3). */
export const RubricDimensionSchema = z.object({
  dimension: z.string().min(1),
  definition: z.string().min(1),
  lowerBound: DecimalStringSchema,
  upperBound: DecimalStringSchema,
  /** Finite, nonnegative; the panel sums to 1 (validated on `RubricSchema`). */
  weight: DecimalStringSchema,
  anchors: z.array(z.string().min(1)).default([]),
});
export type RubricDimension = z.infer<typeof RubricDimensionSchema>;

/**
 * Rubric version identity used by judgments and disclosures. Generated rubrics
 * stay drafts until the owner confirms them (§7.1); weights must already be
 * normalized to sum to one (§6.3).
 */
export const RubricSchema = z
  .object({
    rubricVersionRef: z.string().min(1),
    dimensions: z.array(RubricDimensionSchema).min(1),
    generatedDraftRequiresConfirmation: z.boolean(),
    aggregationRule: z.string().min(1),
  })
  .superRefine((rubric, ctx) => {
    let total = 0;
    for (const dimension of rubric.dimensions) {
      const weight = Number(dimension.weight);
      if (!Number.isFinite(weight) || weight < 0) {
        ctx.addIssue({
          code: "custom",
          message: `weight for "${dimension.dimension}" must be finite and nonnegative`,
          path: ["dimensions"],
        });
        return;
      }
      total += weight;
    }
    // Tolerance only guards decimal-string parsing; server-side normalization uses
    // decimal arithmetic, not this sum, as the authoritative record.
    if (Math.abs(total - 1) > 1e-9) {
      ctx.addIssue({
        code: "custom",
        message: `rubric weights must sum to 1 after validated normalization (got ${total})`,
        path: ["dimensions"],
      });
    }
  });
export type Rubric = z.infer<typeof RubricSchema>;

// ─── FROZEN CALL PLAN AND ESTIMATE (spec §9) ─────────────────────────
/**
 * Call arithmetic (worked example is structural, never a price prediction):
 *   C = cases (incl. explicitly chosen input variants), M = candidates,
 *   R = generation repeats, J = judges.
 *   Independent rubric grading: judgmentCount = C × M × R × J
 *                                     (× judgingPromptRepeatCount if requested)
 *   Pairwise comparison:        judgmentCount = C × pairedRepeatCount
 *                                            × selectedPairCount × J
 *                                            × orientationCount
 *   Generation calls = Σ executed LLM steps over every case × candidate × repeat
 *     (branches, gate calls, bounded loops and retries change this number).
 *   3 cases × 2 candidates × 1 repeat × 5 fixed LLM steps = 30 generation calls;
 *   3 independent judges → 18 judging calls; one paired comparison per case with
 *   3 judges and 1 orientation → 9 judging calls (a different plan).
 * Unknown prices/usage stay "unknown" (§9); A08 pins these two counts.
 */
export const CallPlanLimitsSchema = z.object({
  maxCalls: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  maxRuntimeSeconds: z.number().int().positive().optional(),
  maxConcurrentRuns: z.number().int().positive().optional(),
  maxOutputBytes: z.number().int().positive().optional(),
  maxRetriesPerCall: z.number().int().nonnegative().optional(),
});
export type CallPlanLimits = z.infer<typeof CallPlanLimitsSchema>;

export const CallPlanEstimateSchema = z
  .object({
    /** Purpose/payer this quote is bound to (§4.5). */
    purpose: ExecutionPurposeSchema,
    payerId: IdSchema,
    executionMode: BenchmarkExecutionModeSchema,
    scoringShape: z.enum(["independent_rubric", "pairwise"]),
    // ── plan counts ──
    caseCount: z.number().int().positive(), // C
    candidateCount: z.number().int().positive(), // M
    generationRepeatCount: z.number().int().positive(), // R
    judgeCount: z.number().int().positive(), // J
    /** Explicit judging-prompt repeats; only multiplies the independent-rubric plan. */
    judgingPromptRepeatCount: z.number().int().positive().default(1),
    /** Paired plan only — which repeats are paired must be explicit, never a silent cross-product. */
    pairedRepeatCount: z.number().int().positive().optional(),
    selectedPairCount: z.number().int().positive().optional(),
    orientationCount: z.number().int().positive().optional(),
    judgmentCount: z.number().int().nonnegative(),
    /** LLM steps assumed executed per run (bounded; branches/loops/retries disclosed). */
    executedLlmStepsPerRunEstimate: z.number().int().positive(),
    generationCallEstimate: z.number().int().nonnegative(),
    validatorCallEstimate: z.number().int().nonnegative().default(0),
    narrativeCallEstimate: z.number().int().nonnegative().default(0),
    // ── cost lines: "unknown" is a real answer, zero is not (§9) ──
    currency: CurrencyCodeSchema,
    preparationCostUsd: CostOrUnknownSchema,
    designCostUsd: CostOrUnknownSchema,
    generationCostUsd: CostOrUnknownSchema,
    judgingCostUsd: CostOrUnknownSchema,
    narrativeCostUsd: CostOrUnknownSchema,
    authorizedRetryCostUsd: CostOrUnknownSchema,
    totalBaselineUsd: CostOrUnknownSchema,
    totalBoundedHighUsd: CostOrUnknownSchema,
    /** Items the provider could not price; rendered as "unknown", never as 0. */
    unknownCostItems: z.array(z.string().min(1)).default([]),
    priceVectorVersion: z.string().min(1).max(40),
    pricingSource: z.string().min(1),
    pricingAsOf: IsoDateTimeSchema,
    // ── admission controls and assumptions ──
    limits: CallPlanLimitsSchema,
    /** Optional user-approved spend ceiling; best-effort where billing is incomplete (§9). */
    approvedSpendCeiling: MinorAmountSchema.optional(),
    /** Potential overshoot must be explained, not hidden, when ceilings are best-effort. */
    ceilingOvershootNote: z.string().min(1).optional(),
    assumptions: z.array(z.string().min(1)).min(1),
    planHash: Hash64Schema.optional(),
  })
  .superRefine((plan, ctx) => {
    const reject = (message: string, path: string[]) =>
      ctx.addIssue({ code: "custom", message, path });

    if (plan.scoringShape === "pairwise") {
      const { pairedRepeatCount, selectedPairCount, orientationCount } = plan;
      if (
        pairedRepeatCount === undefined ||
        selectedPairCount === undefined ||
        orientationCount === undefined
      ) {
        reject(
          "pairwise plans require pairedRepeatCount, selectedPairCount and orientationCount",
          ["scoringShape"],
        );
      } else {
        const maxPairs = (plan.candidateCount * (plan.candidateCount - 1)) / 2;
        if (maxPairs > 0 && selectedPairCount > maxPairs) {
          reject(
            `selectedPairCount exceeds the ${maxPairs} distinct pairs of ${plan.candidateCount} candidates`,
            ["selectedPairCount"],
          );
        }
        const expected =
          plan.caseCount * pairedRepeatCount * selectedPairCount * plan.judgeCount * orientationCount;
        if (plan.judgmentCount !== expected) {
          reject(
            `judgmentCount must equal C × pairedRepeatCount × selectedPairCount × J × orientationCount (${expected})`,
            ["judgmentCount"],
          );
        }
      }
    } else {
      if (
        plan.pairedRepeatCount !== undefined ||
        plan.selectedPairCount !== undefined ||
        plan.orientationCount !== undefined
      ) {
        reject("paired counts are only valid for pairwise plans", ["scoringShape"]);
      }
      const expected =
        plan.caseCount *
        plan.candidateCount *
        plan.generationRepeatCount *
        plan.judgeCount *
        plan.judgingPromptRepeatCount;
      if (plan.judgmentCount !== expected) {
        reject(
          `judgmentCount must equal C × M × R × J (× judgingPromptRepeatCount) (${expected})`,
          ["judgmentCount"],
        );
      }
    }

    const expectedGeneration =
      plan.caseCount *
      plan.candidateCount *
      plan.generationRepeatCount *
      plan.executedLlmStepsPerRunEstimate;
    if (plan.generationCallEstimate !== expectedGeneration) {
      reject(
        `generationCallEstimate must equal C × M × R × executed LLM steps per run (${expectedGeneration})`,
        ["generationCallEstimate"],
      );
    }

    if (plan.executionMode === "grade_only" && plan.candidateCount !== 1) {
      reject("grade_only evaluates the configured workflow only: no comparator candidates (D1)", [
        "candidateCount",
      ]);
    }
  });
export type CallPlanEstimate = z.infer<typeof CallPlanEstimateSchema>;

// ─── DESIGN JOB DTOs (spec §5.2, §5.3, §6.1) ────────────────────────
/** `designJobs.state` in db/schema.ts (§10.2 state machine). */
export const DesignJobStateSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "paused",
]);
export type DesignJobState = z.infer<typeof DesignJobStateSchema>;

/** `designJobs.applyState`: `succeeded` means a validated candidate exists, not that it overwrote the project. */
export const DesignJobApplyStateSchema = z.enum(["not_applied", "applied", "revision_conflict"]);
export type DesignJobApplyState = z.infer<typeof DesignJobApplyStateSchema>;

/**
 * `designJobs.start` input. Uses the inserted project ID (never "latest project
 * for user") and an explicit designer binding + spend approval (§5.1, §5.2).
 */
export const DesignJobStartInputSchema = z.object({
  projectId: IdSchema,
  /** Optimistic-concurrency target captured at start; apply must repeat it. */
  expectedRevision: z.number().int().nonnegative(),
  objective: z.string().min(1),
  /** Owned, enabled provider binding of the ACTOR; no implicit default spend. */
  designerProviderId: IdSchema.optional(),
  designerModel: z.string().min(1).max(120).optional(),
  /** Recorded designer-prompt version; any prompt change is a new version (§5.1). */
  designerPromptVersion: z.string().min(1).max(60).optional(),
  spendApprovalId: IdSchema.optional(),
  idempotencyKey: IdempotencyKeySchema,
});
export type DesignJobStartInput = z.infer<typeof DesignJobStartInputSchema>;

/**
 * `designJobs.get` result: durable status, not a live client callback. A retained
 * candidate plus `revision_conflict` is the correct outcome when the project moved
 * on while the designer was working — current steps are never deleted (§5.1).
 */
export const DesignJobStatusDtoSchema = z.object({
  jobId: IdSchema,
  projectId: IdSchema,
  expectedRevision: z.number().int().nonnegative(),
  state: DesignJobStateSchema,
  applyState: DesignJobApplyStateSchema,
  /** Nullable: a running/failed job has no candidate yet. */
  candidateVersionId: IdSchema.nullable(),
  designer: z.object({
    providerId: IdSchema.nullable(),
    model: z.string().nullable(),
    promptVersion: z.string().nullable(),
  }),
  attemptCount: z.number().int().nonnegative(),
  /** False when the job fell back to a process-local queue — never described as durable (§5.3). */
  durable: z.boolean(),
  /** Whether a provider outcome is unknown; possible duplicate spend is shown, not hidden. */
  uncertainAttemptCount: z.number().int().nonnegative().default(0),
  validationIssues: z.array(z.string().min(1)).default([]),
  /** Sanitized error only: no prompts, keys or cross-tenant detail (§5.3, §10.1). */
  error: z
    .object({
      code: V2ErrorCodeSchema,
      message: z.string().min(1),
      retryable: z.boolean(),
    })
    .nullable(),
  createdAt: IsoDateTimeSchema,
  startedAt: IsoDateTimeSchema.nullable(),
  finishedAt: IsoDateTimeSchema.nullable(),
});
export type DesignJobStatusDto = z.infer<typeof DesignJobStatusDtoSchema>;

/**
 * `designJobs.apply` input: atomic apply ONLY if the project revision still
 * matches `expectedRevision`; otherwise `revision_conflict` and the candidate is
 * retained (§5.1).
 */
export const DesignJobApplyInputSchema = z.object({
  jobId: IdSchema,
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: IdempotencyKeySchema,
});
export type DesignJobApplyInput = z.infer<typeof DesignJobApplyInputSchema>;

// ─── BENCHMARK DTOs (spec §4.1, §6.1, §10.1) ────────────────────────
/**
 * What is being evaluated: an owned immutable pipeline version, an existing
 * output from an owned run, or a privately graded user-pasted output. Pasted
 * origin/model/cost stays user-reported and never becomes platform-attested
 * execution evidence (§4.1).
 */
export const BenchmarkDraftSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("owned_pipeline_version"),
    pipelineVersionId: IdSchema,
  }),
  z.object({
    kind: z.literal("owned_run_output"),
    pipelineVersionId: IdSchema,
    swarmRunId: IdSchema,
  }),
  z.object({
    kind: z.literal("user_imported_output"),
    outputRef: OpaqueRefSchema,
    reportedModel: z.string().min(1).optional(),
    reportedAt: z.string().min(1).optional(),
    /** Contract-level guarantee: imports are not attested platform execution. */
    platformAttested: z.literal(false),
  }),
]);
export type BenchmarkDraftSource = z.infer<typeof BenchmarkDraftSourceSchema>;

/**
 * `benchmark.create/updateDraft` input. Private, owner-only, and NO listing is
 * required (D1): `listingId` stays optional. Drafts are editable; starting freezes
 * the plan, after which edits create a new benchmark (§6.1, §10.1).
 */
export const BenchmarkDraftInputSchema = z
  .object({
    /** Benchmark ID for `updateDraft`; absent on `create`. */
    benchmarkId: IdSchema.optional(),
    source: BenchmarkDraftSourceSchema,
    executionMode: BenchmarkExecutionModeSchema,
    /** OPTIONAL marketplace attachment — never a prerequisite for evaluation (D1). */
    listingId: IdSchema.optional(),
    cases: z
      .object({
        stableCaseId: z.string().min(1).max(60),
        caseOrder: z.number().int().nonnegative(),
        inputText: z.string().min(1).optional(),
        inputArtifactRef: OpaqueRefSchema.optional(),
        origin: BenchmarkCaseOriginSchema,
        baseCaseId: z.string().min(1).max(60).optional(),
        expectedOutput: z.string().optional(),
        provenanceNotes: z.string().optional(),
      })
      .array()
      .min(1),
    rubric: RubricSchema,
    /** Whole-workflow executor overrides for compare_models; unsupported settings must fail or become a disclosed separate condition (§4.2). */
    executorOverrides: z
      .array(
        z.object({
          stableCandidateId: z.string().min(1).max(60),
          strategy: CandidateStrategySchema,
          providerId: IdSchema,
          model: z.string().min(1).max(120),
          stepResolutionPolicy: z.union([
            z.object({ mode: z.literal("as_configured") }),
            z.object({
              mode: z.literal("override_all"),
              overrideModel: z.string().min(1).max(120),
              overrideProviderId: IdSchema.optional(),
            }),
          ]),
          decoding: z
            .object({
              temperature: DecimalStringSchema.optional(),
              topP: DecimalStringSchema.optional(),
              maxTokens: z.number().int().positive().optional(),
            })
            .optional(),
        }),
      )
      .optional(),
    /** Recorded baseline prompt/version for compare_frontier_solo (§4.2). */
    frontierSoloBaseline: z
      .object({
        baselinePrompt: z.string().min(1),
        baselinePromptVersion: z.string().min(1).max(60),
        model: z.string().min(1).max(120),
        providerId: IdSchema,
        rubricVersionRef: z.string().min(1),
      })
      .optional(),
    judgePanel: z
      .array(
        z.object({
          judgeSlot: z.number().int().positive(),
          providerId: IdSchema,
          model: z.string().min(1).max(120),
          judgePromptVersion: z.string().min(1).max(60),
          /** D12 prompt variant. Optional so a draft frozen before D12 keeps
           *  parsing; an evidence-grade panel declares all three. */
          variant: JudgePromptVariantSchema.optional(),
        }),
      )
      .min(1),
    pairwiseConfig: z
      .object({
        pairedRepeatCount: z.number().int().positive(),
        selectedPairIds: z.array(z.string().min(1)).min(1),
        orientations: z.array(z.enum(["ab", "ba"])).min(1),
        orderSwapCheck: z.boolean().default(false),
      })
      .optional(),
    validators: z
      .array(
        z.object({
          validatorVersion: z.string().min(1),
          kind: z.enum(["schema_conformance", "expected_value", "owner_supplied_tests", "sandboxed_code"]),
          requiresIsolatedSandbox: z.boolean().default(false),
        }),
      )
      .default([]),
    generationRepeatCount: z.number().int().positive().default(1),
    purpose: ExecutionPurposeSchema,
    limits: CallPlanLimitsSchema,
  })
  .superRefine((draft, ctx) => {
    const reject = (message: string, path: string[]) =>
      ctx.addIssue({ code: "custom", message, path });

    // D1: grade-only uses the configured workflow as-is.
    if (draft.executionMode === "grade_only") {
      if (draft.executorOverrides || draft.frontierSoloBaseline) {
        reject("grade_only takes no comparator: no executor overrides or frontier baseline (D1)", [
          "executionMode",
        ]);
      }
    } else if (!draft.executorOverrides && !draft.frontierSoloBaseline) {
      reject("comparison modes require at least one explicit comparator condition", [
        "executionMode",
      ]);
    }
    if (draft.executionMode === "compare_frontier_solo" && !draft.frontierSoloBaseline) {
      reject("compare_frontier_solo requires a recorded baseline prompt/version", [
        "frontierSoloBaseline",
      ]);
    }
    if (draft.executionMode === "compare_models" && !draft.executorOverrides) {
      reject("compare_models requires explicitly selected whole-workflow executor models", [
        "executorOverrides",
      ]);
    }
    if (draft.source.kind === "user_imported_output" && draft.executionMode !== "grade_only") {
      reject("externally pasted outputs may only be graded privately, never compared (D1)", [
        "source",
      ]);
    }
    const slots = draft.judgePanel.map((judge) => judge.judgeSlot);
    if (new Set(slots).size !== slots.length) {
      reject("judgePanel judgeSlot values must be distinct", ["judgePanel"]);
    }
  });
export type BenchmarkDraftInput = z.infer<typeof BenchmarkDraftInputSchema>;

/**
 * `benchmark.start` input. The frozen plan hash and spend approval must match
 * server-side state: a materially changed model, graph, case set, judge panel or
 * limit invalidates approval (`plan_changed` / `pricing_unapproved`) before enqueue (§9, §10.1).
 */
export const BenchmarkStartInputSchema = z.object({
  benchmarkId: IdSchema,
  /** Hash of the exact frozen call plan the owner approved (§6.1). */
  frozenPlanHash: Hash64Schema,
  spendApprovalId: IdSchema,
  idempotencyKey: IdempotencyKeySchema,
  /** Explicit human-intervention policy: approval steps are supported or rejected before spending, never auto-approved (§5.1). */
  approvalStepHandling: z.enum(["pause_for_human", "reject_before_spend"]).default("pause_for_human"),
});
export type BenchmarkStartInput = z.infer<typeof BenchmarkStartInputSchema>;

/**
 * `benchmark.get` progress. Owner-authorized; protected buyers receive this
 * sanitized shape only — no prompts, step traces or private credential refs (§5.3, §8.1).
 */
export const BenchmarkProgressDtoSchema = z
  .object({
    benchmarkId: IdSchema,
    state: BenchmarkStateSchema,
    executionMode: BenchmarkExecutionModeSchema,
    aggregateAvailability: AggregateAvailabilitySchema,
    planHash: Hash64Schema.nullable(),
    durable: z.boolean(),
    counts: z.object({
      casesTotal: z.number().int().nonnegative(),
      casesCompleted: z.number().int().nonnegative(),
      casesFailed: z.number().int().nonnegative(),
      casesCancelled: z.number().int().nonnegative(),
      runsPlanned: z.number().int().nonnegative(),
      runsCompleted: z.number().int().nonnegative(),
      runsFailed: z.number().int().nonnegative(),
      /** Provider outcome unknown after acceptance: visible, not hidden (§5.3). */
      runsUncertain: z.number().int().nonnegative(),
      judgmentsPlanned: z.number().int().nonnegative(),
      judgmentsCompleted: z.number().int().nonnegative(),
      judgmentsParseFailed: z.number().int().nonnegative(),
      validatorsPlanned: z.number().int().nonnegative(),
      validatorsCompleted: z.number().int().nonnegative(),
    }),
    observedCostUsd: CostOrUnknownSchema,
    estimatedTotalCostUsd: CostOrUnknownSchema,
    currency: CurrencyCodeSchema,
    costCompleteness: CostCompletenessSchema,
    /** Attempt history is retained across retries/resumes (§5.3). */
    attemptCount: z.number().int().nonnegative(),
    lastUpdatedAt: IsoDateTimeSchema,
    /** Sanitized: catalog code + operator-safe message, no prompts or provider payloads. */
    error: z
      .object({
        code: V2ErrorCodeSchema,
        message: z.string().min(1),
        retryable: z.boolean(),
      })
      .nullable(),
  })
  .superRefine((progress, ctx) => {
    const { counts } = progress;
    const reject = (message: string, path: string[]) =>
      ctx.addIssue({ code: "custom", message, path });
    if (
      counts.casesCompleted + counts.casesFailed + counts.casesCancelled >
      counts.casesTotal
    ) {
      reject("case counts exceed the planned case total", ["counts"]);
    }
    if (counts.judgmentsCompleted + counts.judgmentsParseFailed > counts.judgmentsPlanned) {
      reject("judgment counts exceed the planned judgment total", ["counts"]);
    }
    if (progress.state === "completed" && counts.judgmentsCompleted !== counts.judgmentsPlanned) {
      reject("completed requires every planned judgment; otherwise partial/failed (§10.2)", [
        "state",
      ]);
    }
  });
export type BenchmarkProgressDto = z.infer<typeof BenchmarkProgressDtoSchema>;

/**
 * Canonical claim boundary for comparisons (spec §7.2). A verdict reports the
 * "highest observed score among these tested conditions" or a tie/insufficient
 * evidence — never a general quality ranking. UI localizes the label; the literal
 * keeps the claim scope machine-checkable.
 */
export const AMONG_TESTED_CONDITIONS_ONLY =
  "Highest observed score among these tested conditions only.";
export const AmongTestedConditionsDisclaimerSchema = z.literal(AMONG_TESTED_CONDITIONS_ONLY);
export type AmongTestedConditionsDisclaimer = z.infer<typeof AmongTestedConditionsDisclaimerSchema>;
export const NO_RANKING_IN_GRADE_ONLY = "no_ranking_grade_only";

const EvaluationSummaryScopeSchema = z.object({
  caseCount: z.number().int().positive(),
  candidateCount: z.number().int().positive(),
  generationRepeatCount: z.number().int().positive(),
  judgeCount: z.number().int().positive(),
  judgmentCount: z.number().int().nonnegative(),
  /** Repetitions/paraphrases are NOT independent tasks; count them separately (§2.5). */
  independentCaseCount: z.number().int().positive(),
});

const DescriptiveStatisticsSchema = z.object({
  /** Descriptive only: no inferential CI, significance or "equivalent quality" badges (§7.2). */
  scoreSpread: z
    .object({
      minimum: DecimalStringSchema,
      maximum: DecimalStringSchema,
    })
    .nullable(),
  judgeAgreement: z
    .object({
      agreeingJudgmentCount: z.number().int().nonnegative(),
      disagreeingJudgmentCount: z.number().int().nonnegative(),
    })
    .nullable(),
  parseFailureCount: z.number().int().nonnegative(),
  validationFailureCount: z.number().int().nonnegative(),
});

const CandidateScoreSchema = z.object({
  stableCandidateId: z.string().min(1).max(60),
  strategy: CandidateStrategySchema,
  testedModel: z.object({
    provider: z.string().min(1),
    requestedModel: z.string().min(1),
    returnedModel: z.string().nullable(),
    /** null ⇒ `notExposedReason` must be present (§6.2). */
    revision: z.string().min(1).nullable(),
    notExposedReason: RevisionNotExposedReasonSchema.optional(),
  }),
  score: AggregateScoreSchema,
  /** Cost per completed execution, distinct from the benchmark total (§9). */
  costPerCompletedRunUsd: CostOrUnknownSchema,
});

const HighestObservedSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("observed"),
    /** More than one ID here means an observed tie among tested conditions. */
    stableCandidateIds: z.array(z.string().min(1).max(60)).min(1),
    tie: z.boolean(),
  }),
  z.object({
    status: z.literal("insufficient_evidence"),
    reason: z.string().min(1),
  }),
]);

const EvaluationSummaryBaseSchema = z.object({
  benchmarkId: IdSchema,
  pipelineVersionId: IdSchema,
  /** Listing attachment is optional and absent for private-only evaluation (D1). */
  listingId: IdSchema.nullable(),
  workflowVersionNumber: z.number().int().positive(),
  planHash: Hash64Schema,
  rubricVersionRef: z.string().min(1),
  judgePanel: z
    .array(
      z.object({
        judgeSlot: z.number().int().positive(),
        judgeModel: z.string().min(1),
        judgePromptVersion: z.string().min(1),
        /** D12: which prompt variant this judge's slot carries, when declared. */
        variant: JudgePromptVariantSchema.optional(),
        revision: z.string().min(1).nullable(),
        notExposedReason: RevisionNotExposedReasonSchema.optional(),
      }),
    )
    .min(1),
  scope: EvaluationSummaryScopeSchema,
  aggregateAvailability: AggregateAvailabilitySchema,
  results: z.array(CandidateScoreSchema).min(1),
  descriptive: DescriptiveStatisticsSchema,
  costs: z.object({
    currency: CurrencyCodeSchema,
    totalEstimatedCostUsd: CostOrUnknownSchema,
    totalObservedCostUsd: CostOrUnknownSchema,
    /** Failed/retried attempts are summed when usage is available (§9). */
    failedAttemptCostUsd: CostOrUnknownSchema,
    costCompleteness: CostCompletenessSchema,
    missingOrEstimatedItems: z.array(z.string().min(1)).default([]),
  }),
  testedAt: IsoDateTimeSchema,
  /** A score is not a percentage of objective quality nor a probability of correctness (§6.3). */
  claimBoundaries: z.array(z.string().min(1)).min(1),
});

/**
 * `benchmark.get` final summary. Discriminated on `executionMode` so a grade-only
 * result CANNOT carry a winning-model field (spec §4.1 step 7, A01). Comparisons
 * must attach the "among these tested conditions only" disclaimer (§7.2).
 */
export const EvaluationSummaryDtoSchema = z.discriminatedUnion("executionMode", [
  EvaluationSummaryBaseSchema.extend({
    executionMode: z.literal("grade_only"),
    /** Structural proof of "no winner": a ranking value cannot type- or parse-check here. */
    rankingClaim: z.literal(NO_RANKING_IN_GRADE_ONLY),
    highestObserved: z.undefined().optional(),
    winner: z.undefined().optional(),
  }),
  EvaluationSummaryBaseSchema.extend({
    executionMode: z.literal("compare_models"),
    highestObserved: HighestObservedSchema,
    scopeDisclaimer: AmongTestedConditionsDisclaimerSchema,
  }),
  EvaluationSummaryBaseSchema.extend({
    executionMode: z.literal("compare_frontier_solo"),
    highestObserved: HighestObservedSchema,
    scopeDisclaimer: AmongTestedConditionsDisclaimerSchema,
    /** A solo baseline is a different execution STRATEGY, not just another model (§4.2). */
    strategyNote: z.string().min(1),
    baselinePromptVersion: z.string().min(1),
  }),
]);
export type EvaluationSummaryDto = z.infer<typeof EvaluationSummaryDtoSchema>;

// ─── PUBLIC EVIDENCE DISCLOSURE MANIFEST (spec §7.3) ────────────────
/** Version identity + evidence scope; never the private workflow definition. */
export const PublicVersionIdentitySchema = z.object({
  listingId: IdSchema.nullable(),
  workflowVersionId: IdSchema,
  workflowVersionNumber: z.number().int().positive(),
  definitionHash: Hash64Schema,
  executionStrategySummary: z.string().min(1),
  evidenceScope: z.string().min(1),
  includesPrivateDefinition: z.literal(false),
});
export type PublicVersionIdentity = z.infer<typeof PublicVersionIdentitySchema>;

/** Exact approved test inputs, with generated/paraphrase cases disclosed (§7.3). */
export const PublicTestCaseSchema = z.object({
  stableCaseId: z.string().min(1).max(60),
  caseOrder: z.number().int().nonnegative(),
  origin: BenchmarkCaseOriginSchema,
  inputText: z.string().nullable(),
  inputArtifactRef: OpaqueRefSchema.nullable(),
  contentHash: Hash64Schema,
  baseCaseId: z.string().min(1).max(60).nullable(),
  expectedOutput: z.string().nullable(),
  referenceMaterialPublished: z.boolean(),
  withheldReferenceMaterialReason: z.string().min(1).optional(),
});
export type PublicTestCase = z.infer<typeof PublicTestCaseSchema>;

/** Final outputs as judged, with provenance; user-reported origin is not attested. */
export const PublicTestOutputSchema = z.object({
  stableCaseId: z.string().min(1).max(60),
  stableCandidateId: z.string().min(1).max(60),
  replicationIndex: z.number().int().positive(),
  outputText: z.string().nullable(),
  outputArtifactRef: OpaqueRefSchema.nullable(),
  outputHash: Hash64Schema.nullable(),
  runStatus: RunStatusSchema,
  provenance: EvidenceProvenanceSchema,
});
export type PublicTestOutput = z.infer<typeof PublicTestOutputSchema>;

/** Judge identity: revision null ⇒ explicit "not exposed by provider" reason (D5, §6.2). */
export const PublicJudgeIdentitySchema = z
  .object({
    judgeSlot: z.number().int().positive(),
    judgeModel: z.string().min(1).max(120),
    judgeProviderRoute: z.string().min(1).nullable(),
    judgePromptVersion: z.string().min(1).max(60),
    /** D12: this judge's declared prompt variant, when the panel declared one. */
    variant: JudgePromptVariantSchema.optional(),
    revision: z.string().min(1).nullable(),
    notExposedReason: RevisionNotExposedReasonSchema.optional(),
    settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  })
  .superRefine((judge, ctx) => {
    if (judge.revision === null && judge.notExposedReason === undefined) {
      ctx.addIssue({
        code: "custom",
        message: `revision ${REVISION_NOT_EXPOSED} must be stated explicitly, never inferred`,
        path: ["notExposedReason"],
      });
    }
    if (judge.revision !== null && judge.notExposedReason !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "notExposedReason is only valid when revision is null",
        path: ["notExposedReason"],
      });
    }
  });
export type PublicJudgeIdentity = z.infer<typeof PublicJudgeIdentitySchema>;

/** Exact judging prompts, resolved inputs, and EVERY judgment including parse failures. */
export const PublicJudgingSchema = z.object({
  rubric: RubricSchema,
  judgePrompts: z
    .array(
      z.object({
        judgePromptVersion: z.string().min(1).max(60),
        promptText: z.string().min(1),
      }),
    )
    .min(1),
  resolvedJudgeInputs: z
    .array(
      z.object({
        stableCaseId: z.string().min(1).max(60),
        stableCandidateIds: z.array(z.string().min(1).max(60)).min(1),
        referenceMaterialIncluded: z.boolean(),
        /** Hidden seller instructions must NOT be sent to judges (§7.3). */
        hiddenSellerInstructionsIncluded: z.literal(false),
      }),
    )
    .min(1),
  judges: z.array(PublicJudgeIdentitySchema).min(1),
  judgments: z
    .array(
      z.object({
        stableCaseId: z.string().min(1).max(60),
        stableCandidateId: z.string().min(1).max(60).nullable(),
        pairedCandidateIds: z.array(z.string().min(1).max(60)).optional(),
        judgeSlot: z.number().int().positive(),
        judgePromptVersion: z.string().min(1).max(60),
        kind: JudgmentKindSchema,
        orientation: JudgmentOrientationSchema,
        status: JudgmentStatusSchema,
        dimensionScores: z.array(NormalizedScoreSchema).optional(),
        pairPreference: PairPreferenceSchema.optional(),
        rationale: z.string().nullable(),
        validationNotes: z
          .object({
            outOfRangeDimensions: z.array(z.string().min(1)).default([]),
            missingDimensions: z.array(z.string().min(1)).default([]),
          })
          .optional(),
      }),
    )
    .min(1),
  parseFailures: z
    .array(
      z.object({
        stableCaseId: z.string().min(1).max(60),
        judgeSlot: z.number().int().positive(),
        judgePromptVersion: z.string().min(1).max(60),
        sanitizedReason: z.string().min(1),
        attemptIndexes: z.array(z.number().int().nonnegative()).min(1),
      }),
    )
    .default([]),
  validatorOutcomes: z
    .array(
      z.object({
        validatorVersion: z.string().min(1),
        kind: z.string().min(1),
        passed: z.boolean(),
        timedOut: z.boolean(),
        environment: z.string().min(1),
        limitations: z.string().min(1),
      }),
    )
    .default([]),
  aggregationRule: z.string().min(1),
});
export type PublicJudging = z.infer<typeof PublicJudgingSchema>;

/** Requested/returned executor identifiers with the step-model map where relevant. */
export const PublicTestedModelSchema = z
  .object({
    stableCandidateId: z.string().min(1).max(60),
    strategy: CandidateStrategySchema,
    provider: z.string().min(1).max(80),
    route: z.string().min(1).nullable(),
    requestedModel: z.string().min(1).max(120),
    returnedModel: z.string().min(1).max(120).nullable(),
    revision: z.string().min(1).nullable(),
    notExposedReason: RevisionNotExposedReasonSchema.optional(),
    stepModelMap: z
      .array(
        z.object({
          stepOrder: z.number().int().nonnegative(),
          requestedModel: z.string().min(1).max(120),
          returnedModel: z.string().min(1).max(120).nullable(),
          revision: z.string().min(1).nullable(),
          notExposedReason: RevisionNotExposedReasonSchema.optional(),
        }),
      )
      .optional(),
  })
  .superRefine((model, ctx) => {
    if (model.revision === null && model.notExposedReason === undefined) {
      ctx.addIssue({
        code: "custom",
        message: `executor revision ${REVISION_NOT_EXPOSED} must be stated explicitly`,
        path: ["notExposedReason"],
      });
    }
  });
export type PublicTestedModel = z.infer<typeof PublicTestedModelSchema>;

/** Planned vs completed work, and every attempt/failure of the selected plan (§7.3). */
export const PublicAttemptDisclosureSchema = z.object({
  planned: z.object({
    cases: z.number().int().nonnegative(),
    candidates: z.number().int().nonnegative(),
    generationRepeats: z.number().int().nonnegative(),
    judgments: z.number().int().nonnegative(),
    validators: z.number().int().nonnegative(),
  }),
  completed: z.object({
    cases: z.number().int().nonnegative(),
    candidates: z.number().int().nonnegative(),
    generationRepeats: z.number().int().nonnegative(),
    judgments: z.number().int().nonnegative(),
    validators: z.number().int().nonnegative(),
  }),
  attempts: z
    .array(
      z.object({
        operationKind: CallOperationKindSchema,
        stableRef: z.string().min(1),
        attemptIndex: z.number().int().nonnegative(),
        outcome: CallOutcomeSchema,
        sanitizedReason: z.string().min(1).nullable(),
        costDisclosed: z.boolean(),
      }),
    )
    .min(1),
  cancellationCount: z.number().int().nonnegative().default(0),
  missingJudgmentCount: z.number().int().nonnegative().default(0),
  retryCount: z.number().int().nonnegative().default(0),
  /** All attempts in the SELECTED plan are disclosed; withheld private experiments are not claimed (§4.3). */
  allSelectedPlanAttemptsDisclosed: z.literal(true),
  reproducibilityLimitations: z.array(z.string().min(1)).min(1),
});
export type PublicAttemptDisclosure = z.infer<typeof PublicAttemptDisclosureSchema>;

/** Generation-per-run vs benchmark-total cost, design/prep/judging/retries broken out (§7.3, §9). */
export const PublicCostDisclosureSchema = z.object({
  currency: CurrencyCodeSchema,
  generationCostPerCompletedRunUsd: CostOrUnknownSchema,
  totalGenerationCostUsd: CostOrUnknownSchema,
  designCostUsd: CostOrUnknownSchema,
  preparationCostUsd: CostOrUnknownSchema,
  judgingCostUsd: CostOrUnknownSchema,
  retryCostUsd: CostOrUnknownSchema,
  narrativeCostUsd: CostOrUnknownSchema,
  /** Provider-invoiced amounts are distinct from platform estimates (§9). */
  providerInvoicedAmount: CostOrUnknownSchema,
  /** Platform/license charges are separate again; minor-unit money, 2 dp. */
  platformLicenseCharge: z.union([MinorAmountSchema, z.literal("unknown")]).nullable(),
  tokenUsage: z.object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    cachedTokens: z.number().int().nonnegative(),
  }),
  priceVectorVersion: z.string().min(1).max(40),
  pricingSource: z.string().min(1),
  pricingAsOf: IsoDateTimeSchema,
  costCompleteness: CostCompletenessSchema,
  /** Explicit "missing"/"estimated" labels for every non-final figure. */
  estimatedItems: z.array(z.string().min(1)).default([]),
  missingItems: z.array(z.string().min(1)).default([]),
});
export type PublicCostDisclosure = z.infer<typeof PublicCostDisclosureSchema>;

/**
 * The complete public manifest (spec §7.3). `disclosureClass` "limited" exists so a
 * report with withheld material can be published as additional, clearly labelled
 * evidence — it cannot satisfy the v2 SELLER-publication gate.
 */
export const PublicEvidenceManifestSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    publicationKind: PublicationKindSchema,
    provenance: EvidenceProvenanceSchema,
    disclosureClass: z.enum(["full", "limited"]),
    withheldReason: z.string().min(1).optional(),
    versionIdentity: PublicVersionIdentitySchema,
    cases: z.array(PublicTestCaseSchema).min(1),
    outputs: z.array(PublicTestOutputSchema).min(1),
    judging: PublicJudgingSchema,
    testedModels: z.array(PublicTestedModelSchema).min(1),
    attempts: PublicAttemptDisclosureSchema,
    costs: PublicCostDisclosureSchema,
    publicTestConfiguration: z.string().min(1),
    testedAt: IsoDateTimeSchema,
    /** Separate from `testedAt`: re-publishing must not reset the original test date (§6.2). */
    publishedAt: IsoDateTimeSchema.nullable(),
    publicationPolicyVersion: z.string().min(1).max(40),
    consentVersion: z.string().min(1).max(40),
  })
  .superRefine((manifest, ctx) => {
    const reject = (message: string, path: string[]) =>
      ctx.addIssue({ code: "custom", message, path });

    if (manifest.disclosureClass === "limited" && manifest.publicationKind === "seller") {
      reject(
        "a limited-disclosure report cannot satisfy the v2 seller-publication gate (§7.3)",
        ["disclosureClass"],
      );
    }
    if (manifest.disclosureClass === "limited" && !manifest.withheldReason) {
      reject("limited disclosure must state what was withheld and why", ["withheldReason"]);
    }
    if (manifest.provenance === "platform_recorded" && !manifest.outputs.every((o) => o.provenance === "platform_recorded")) {
      reject(
        "platform-recorded evidence may not embed user-reported outputs as attested execution",
        ["outputs"],
      );
    }
    if (manifest.provenance === "legacy_import") {
      // G5: legacy evidence is imported with KNOWN fields only — it may never be
      // presented as fully disclosed v2 evidence (§13 G5).
      if (manifest.disclosureClass === "full") {
        reject(
          "legacy imports cannot claim full disclosure; missing metadata must be shown",
          ["disclosureClass"],
        );
      }
      if (manifest.costs.missingItems.length === 0 && manifest.costs.costCompleteness === "complete") {
        reject("legacy imports must label missing cost/metadata as missing", ["provenance"]);
      }
    }
    if (
      manifest.publicationKind === "seller" &&
      manifest.provenance === "platform_recorded" &&
      manifest.attempts.completed.judgments < manifest.attempts.planned.judgments
    ) {
      reject(
        "seller publication requires a completed plan; partial plans are additional evidence only (§10.2)",
        ["attempts"],
      );
    }
  });
export type PublicEvidenceManifest = z.infer<typeof PublicEvidenceManifestSchema>;

// ─── PRIVATE vs PUBLIC DTOs (spec §3 contracts row, §6.2) ───────────
/**
 * OWNER-FACING full benchmark view (mirrors db/schema.ts `benchmarks`,
 * `benchmarkCases`, `benchmarkCandidates`, `benchmarkRuns`, `benchmarkJudgments`,
 * `callAttempts` rows). Private prompts, artifact refs, provider references and
 * step traces live here.
 *
 * DB rows are NEVER exposed publicly, and this is a DISTINCT type from
 * `PublicEvidenceManifestDto`: public endpoints return only the manifest of a
 * currently public, authorized publication — never a raw `benchmarks` row
 * selected by listing ID (§6.2, §10.1).
 */
export const PrivateBenchmarkDtoSchema = z.object({
  id: IdSchema,
  ownerId: IdSchema,
  listingId: IdSchema.nullable(),
  pipelineVersionId: IdSchema,
  executionMode: BenchmarkExecutionModeSchema,
  schemaVersion: z.number().int().positive(),
  state: BenchmarkStateSchema,
  aggregateAvailability: AggregateAvailabilitySchema,
  planHash: Hash64Schema.nullable(),
  /** Frozen plan JSON as recorded after start (immutable). */
  plan: z.string().nullable(),
  rubricRef: z.string().nullable(),
  judgeConfigRef: z.string().nullable(),
  spendApprovalId: IdSchema.nullable(),
  costCurrency: z.string().nullable(),
  totalEstimatedCost: DecimalStringSchema.nullable(),
  totalObservedCost: DecimalStringSchema.nullable(),
  costCompleteness: CostCompletenessSchema,
  createdAt: IsoDateTimeSchema,
  startedAt: IsoDateTimeSchema.nullable(),
  finishedAt: IsoDateTimeSchema.nullable(),
  cases: z
    .array(
      z.object({
        id: IdSchema,
        stableCaseId: z.string().min(1).max(60),
        caseOrder: z.number().int().nonnegative(),
        inputText: z.string().nullable(),
        inputArtifactRef: OpaqueRefSchema.nullable(),
        origin: BenchmarkCaseOriginSchema,
        baseCaseId: z.string().nullable(),
        expectedOutput: z.string().nullable(),
        contentHash: Hash64Schema,
        provenanceNotes: z.string().nullable(),
      }),
    )
    .default([]),
  candidates: z
    .array(
      z.object({
        id: IdSchema,
        stableCandidateId: z.string().min(1).max(60),
        strategy: CandidateStrategySchema,
        workflowVersionId: IdSchema.nullable(),
        baselinePrompt: z.string().nullable(),
        baselinePromptVersion: z.string().nullable(),
        requestedProviderId: IdSchema.nullable(),
        requestedModel: z.string().nullable(),
        stepResolutionPolicy: z
          .object({
            mode: z.enum(["as_configured", "override_all"]),
            overrideModel: z.string().optional(),
            overrideProviderId: IdSchema.optional(),
          })
          .nullable(),
        decodingSnapshot: z
          .object({
            temperature: z.number().nullable().optional(),
            maxTokens: z.number().nullable().optional(),
            topP: z.number().nullable().optional(),
          })
          .nullable(),
      }),
    )
    .default([]),
  runs: z
    .array(
      z.object({
        id: IdSchema,
        caseId: IdSchema,
        candidateId: IdSchema,
        replicationIndex: z.number().int().positive(),
        logicalExecutionId: z.string().min(1).max(60),
        linkedSwarmRunId: IdSchema.nullable(),
        importedProvenance: z
          .object({
            kind: z.literal("user_reported"),
            reportedModel: z.string().optional(),
            reportedAt: z.string().optional(),
          })
          .nullable(),
        status: RunStatusSchema,
        outputText: z.string().nullable(),
        outputHash: z.string().nullable(),
        executorMetadata: z
          .object({
            stepModels: z
              .array(
                z.object({
                  stepOrder: z.number().int(),
                  requestedModel: z.string(),
                  returnedModel: z.string().nullable().optional(),
                }),
              )
              .optional(),
            providerRoute: z.string().optional(),
            revisionExposed: z.string().nullable().optional(),
          })
          .nullable(),
        usageSummary: z
          .object({
            promptTokens: z.number().int().nonnegative().optional(),
            completionTokens: z.number().int().nonnegative().optional(),
            complete: z.boolean().optional(),
          })
          .nullable(),
        errorSummary: z.string().nullable(),
        startedAt: IsoDateTimeSchema.nullable(),
        finishedAt: IsoDateTimeSchema.nullable(),
      }),
    )
    .default([]),
  judgments: z
    .array(
      z.object({
        id: IdSchema,
        runId: IdSchema.nullable(),
        runAId: IdSchema.nullable(),
        runBId: IdSchema.nullable(),
        judgeSlot: z.number().int().positive(),
        rubricVersionRef: z.string().min(1),
        judgePromptVersion: z.string().min(1).max(60),
        judgeModel: z.string().min(1).max(120),
        judgeProviderRoute: z.string().nullable(),
        judgeRevision: z.string().nullable(),
        orientation: JudgmentOrientationSchema.nullable(),
        kind: JudgmentKindSchema,
        dimensionScores: z.array(NormalizedScoreSchema).nullable(),
        rawAggregate: DecimalStringSchema.nullable(),
        normalizedAggregate: DecimalStringSchema.nullable(),
        pairPreference: PairPreferenceSchema.nullable(),
        rationale: z.string().nullable(),
        rawResponseRef: OpaqueRefSchema.nullable(),
        status: JudgmentStatusSchema,
        validationNotes: z
          .object({
            outOfRange: z.array(z.string()).optional(),
            missingDimensions: z.array(z.string()).optional(),
          })
          .nullable(),
      }),
    )
    .default([]),
  callAttempts: z
    .array(
      z.object({
        id: IdSchema,
        operationKind: CallOperationKindSchema,
        operationId: z.number().int().nonnegative(),
        purpose: ExecutionPurposeSchema,
        actorId: IdSchema,
        payerId: IdSchema,
        /** Private: the payer's own provider reference, never surfaced cross-tenant. */
        providerRefId: IdSchema.nullable(),
        requestedModel: z.string().min(1).max(120),
        returnedModel: z.string().nullable(),
        providerRequestId: z.string().nullable(),
        attemptIndex: z.number().int().nonnegative(),
        outcome: CallOutcomeSchema,
        promptTokens: z.number().int().nonnegative().nullable(),
        completionTokens: z.number().int().nonnegative().nullable(),
        cachedTokens: z.number().int().nonnegative().nullable(),
        priceVectorVersion: z.string().nullable(),
        estimatedCostUsd: DecimalStringSchema.nullable(),
        costCompleteness: CostCompletenessSchema,
        startedAt: IsoDateTimeSchema.nullable(),
        finishedAt: IsoDateTimeSchema.nullable(),
        latencyMs: z.number().int().nonnegative().nullable(),
        errorMessage: z.string().nullable(),
      }),
    )
    .default([]),
});
export type PrivateBenchmarkDto = z.infer<typeof PrivateBenchmarkDtoSchema>;

/**
 * PUBLIC view: the envelope of one currently public publication plus its manifest.
 * `.strict()` guards against a raw DB row ever being serialized alongside it.
 */
export const PublicEvidenceManifestDtoSchema = z
  .object({
    publicationId: IdSchema,
    manifestHash: Hash64Schema,
    schemaVersion: z.number().int().positive(),
    state: z.enum(["draft_preview", "published", "withdrawn"]),
    listingId: IdSchema.nullable(),
    listingWorkflowVersionId: IdSchema.nullable(),
    supersedesPublicationId: IdSchema.nullable(),
    /** Community publications carry public author attribution compatible with the approved privacy policy (§6.2). */
    authorDisplayName: z.string().min(1).nullable(),
    manifest: PublicEvidenceManifestSchema,
  })
  .strict()
  .superRefine((dto, ctx) => {
    if (dto.state === "draft_preview") {
      ctx.addIssue({
        code: "custom",
        message: "a private preview is not public: only published manifests may be returned (§10.2)",
        path: ["state"],
      });
    }
  });
export type PublicEvidenceManifestDto = z.infer<typeof PublicEvidenceManifestDtoSchema>;
