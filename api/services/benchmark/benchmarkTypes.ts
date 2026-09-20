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
  strategy: "pipeline" | "solo_baseline";
  /** Snapshot the candidate executes (materialized at start for overrides). */
  baseVersionId: number;
  overrideModel?: string;
  overrideProviderId?: number;
  /** solo_baseline only. */
  baselinePrompt?: string;
  decoding: { temperature?: number; maxTokens?: number };
}

export interface RubricDimensionSpec {
  dimension: string;
  lowerBound: number;
  upperBound: number;
  weight: number;
  anchor: string;
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
  /** LLM steps actually executed per pipeline generation (sum over steps;
   *  bounded loops counted at their max, branches at the widest path). */
  stepsPerGeneration: number;
  generationCalls: number;
  judgingCalls: number;
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

export interface CostEstimate {
  basis: "price_vector" | "unknown";
  priceVectorVersion: string;
  estimatedUsd: number | null;
  note?: string;
}

export function estimateCostUsd(promptTokens: number, completionTokens: number, model: string): CostEstimate {
  const rates = readPriceVector()[model];
  if (!rates) {
    return { basis: "unknown", priceVectorVersion: PRICE_VECTOR_VERSION, estimatedUsd: null, note: "no approved price vector entry for this model" };
  }
  const usd = (promptTokens / 1000) * rates.in + (completionTokens / 1000) * rates.out;
  return { basis: "price_vector", priceVectorVersion: PRICE_VECTOR_VERSION, estimatedUsd: Math.round(usd * 1e8) / 1e8 };
}
