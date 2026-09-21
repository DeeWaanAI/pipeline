// Shared v2 evaluation types (offering redesign spec §4/§6/§9). Leaf module:
// no DB imports — safe for swarmService and the benchmark services alike.

/** One canonical pipeline step inside an immutable version snapshot. */
export interface SnapshotStep {
  stepOrder: number;
  name: string;
  role: string;
  systemPrompt: string;
  stepType: "agent" | "if" | "while" | "approval" | string;
  providerId: number | null;
  model: string | null;
  temperature: string;
  maxTokens: number;
  ifConfig: { options: string[]; mappings: Record<string, number> } | null;
  whileConfig: { targetStep: number; maxIterations: number } | null;
}

export interface VersionDefinition {
  schemaVersion: number;
  steps: SnapshotStep[];
  pipelineConfig: unknown;
  /** Source agent IDs are references for provenance only; execution uses the
   *  in-snapshot prompts/defaults so later agent edits can't mutate history. */
  sourceAgentIds: Array<number | null>;
}

/** Per-step resolved model map recorded as execution evidence (§4.2). */
export interface StepModelResolution {
  stepOrder: number;
  requestedModel: string | null;
  returnedModel?: string | null;
  providerRoute?: string | null;
}

// ─── Frozen call plan (spec §9) ─────────────────────────────────────

export interface CaseSpec {
  stableCaseId: string;
  inputText: string;
  origin: "user" | "generated" | "paraphrase";
  baseCaseId?: string;
  expectedOutput?: string;
}

export interface JudgeSpec {
  slot: number;
  providerId: number;
  model: string;
}

export interface CandidateSpec {
  stableCandidateId: string;
  /** `imported_output` grades an output the owner already has instead of
   *  regenerating it — the grade-only default of spec §4.1 step 4 (A01). It
   *  contributes ZERO generation calls and is user-reported provenance, not
   *  platform-attested execution (spec §4.3). */
  strategy: "pipeline" | "solo_baseline" | "imported_output";
  /** Snapshot the candidate executes (materialized at start for overrides). */
  baseVersionId: number;
  overrideModel?: string;
  overrideProviderId?: number;
  /** solo_baseline only. */
  baselinePrompt?: string;
  /** imported_output only: an owned agent_responses row. */
  importedResponseId?: number;
  decoding: { temperature?: number; maxTokens?: number };
}

/** Deterministic validators (spec §7.1 line 260): code execution needs an
 *  isolated, resource-limited sandbox with no default network/filesystem
 *  access. This deployment has none, so every validator stays DISABLED and the
 *  plan says so out loud — absent coverage must never look like passing
 *  coverage. Configuring one is a preflight error, not a silent no-op. */
export interface ValidatorSpec {
  kind: "schema" | "expected_value" | "owner_test";
  enabled: false;
  disabledReason: string;
}

export const VALIDATORS_DISABLED_REASON =
  "no isolated execution sandbox is available in this deployment; deterministic validators stay disabled (spec §7.1)";

export interface RubricDimensionSpec {
  dimension: string;
  lowerBound: number;
  upperBound: number;
  weight: number;
  anchor: string;
  /** Optional richer wording (contracts/offeringV2.ts RubricDimensionSchema
   *  requires a definition plus an anchors list). Absent for drafts built
   *  before D9, in which case `anchor` is what is published. */
  definition?: string;
  anchors?: string[];
}

export interface RubricSpec {
  versionRef: string;
  dimensions: RubricDimensionSpec[];
  normalizedWeights: number[]; // sums to 1; recorded at rubric version creation
}

export interface CallCounts {
  cases: number;
  candidates: number;
  generationRepeats: number;
  judges: number;
  /** Widest single generation across the planned candidates (honest-high
   *  headline number; the per-candidate breakdown below is authoritative). */
  stepsPerGeneration: number;
  generationCalls: number;
  judgingCalls: number;
  /** Contract §9: generation calls are a SUM over candidates, so the quote
   *  shows what each condition contributes (the P5 cost table renders this). */
  generationPerCandidate: Array<{
    stableCandidateId: string;
    strategy: CandidateSpec["strategy"];
    repeats: number;
    stepsPerGeneration: number;
    calls: number;
  }>;
  /** Pairwise-only fields; zero for independent rubric grading. */
  pairedRepeatCount?: number;
  pairCount?: number;
  orientationCount?: number;
}

export interface BenchmarkCallPlan {
  schemaVersion: 1;
  executionMode: "grade_only" | "compare_models" | "compare_frontier_solo";
  cases: CaseSpec[];
  candidates: CandidateSpec[];
  judges: JudgeSpec[];
  rubric: RubricSpec;
  /** Deterministic validators: empty unless an isolated sandbox exists, and
   *  never enabled when it doesn't (spec §7.1). */
  validators: ValidatorSpec[];
  generationRepeats: number;
  judgmentKind: "rubric" | "pairwise";
  /** Pairwise: which generation repeats are paired. */
  pairedRepeatIndexes?: number[];
  limits: { maxConcurrency: number; deadlineMs: number; maxTokensPerCall: number };
  counts: CallCounts;
}

export const PRICE_VECTOR_VERSION = "pv-2026-09";

/** Per-1K-token USD rates from env (`V2_PRICE_VECTOR_JSON`), e.g.
 *  {"glm-4.5-flash": {"in": 0.03, "out": 0.14}}. Missing model → UNKNOWN,
 *  never zero (spec §9). */
export function readPriceVector(): Record<string, { in: number; out: number }> {
  try {
    return JSON.parse(process.env.V2_PRICE_VECTOR_JSON || "{}") as Record<string, { in: number; out: number }>;
  } catch {
    return {};
  }
}
