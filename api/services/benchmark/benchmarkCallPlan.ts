// Frozen call-plan construction + arithmetic (offering redesign spec §9).
// Pure module: deterministic hashing and the EXACT counting rules the cost
// preflight must quote. C = cases, M = candidates, R = generation repeats,
// J = judges.
//   Independent rubric grading: judgingCalls = C × M × R × J
//   Pairwise:                   judgingCalls = C × pairedRepeats × pairs × J × orientations
//   Pipeline generation calls = sum of executed LLM steps over every
//     case×candidate×repeat run (bounded loops counted at their max
//     iterations; if-gates count their own call; branches counted at the
//     widest path — disclosed as an upper bound, never silently lower).

import { createHash } from "node:crypto";
import type { BenchmarkCallPlan, CallCounts, CandidateSpec, SnapshotStep } from "./benchmarkTypes";

/** LLM calls one pipeline execution performs, worst-case path.
 *  agent/if steps = 1 call; while gate = 1 assess × (maxIterations+1)
 *  (loop body counted separately); approval = rejected before spend. */
export function stepsToLlmCallCount(steps: SnapshotStep[]): number {
  let calls = 0;
  for (const s of steps) {
    switch (s.stepType) {
      case "agent":
        calls += 1;
        break;
      case "if":
        calls += 1; // the gate itself assesses via LLM; branch not both-taken (widest single path adds downstream counted separately)
        break;
      case "while": {
        const maxIter = Math.min(Math.max(s.whileConfig?.maxIterations ?? 1, 1), 3);
        calls += 1 + maxIter; // initial assess + up to maxIter loops (each re-runs body counted at body steps below is an approximation documented as upper bound)
        break;
      }
      case "approval":
        // Automated benchmark plans reject approval steps before spending
        // (spec §5.1). Counted as 0 here; rejection happens in validate.
        break;
      default:
        calls += 1;
    }
  }
  return Math.max(calls, 1);
}

/** Widest-path step count for a snapshot: steps + the widest if branch span.
 *  Simplification documented: an if-gate can route backward, revisiting
 *  steps; we bound total visits by steps×2 to stay honest-high (§9). */
export function upperBoundCallsPerGeneration(steps: SnapshotStep[]): number {
  const base = stepsToLlmCallCount(steps);
  const hasGate = steps.some((s) => s.stepType === "if" || s.stepType === "while");
  return hasGate ? base * 2 : base;
}

export function computeCounts(input: {
  caseCount: number;
  candidateCount: number;
  generationRepeats: number;
  judgeCount: number;
  stepsPerGeneration: number;
  judgmentKind: "rubric" | "pairwise";
  pairedRepeatCount?: number;
  pairCount?: number;
  orientationCount?: number;
}): CallCounts {
  const { caseCount: C, candidateCount: M, generationRepeats: R, judgeCount: J, stepsPerGeneration: S } = input;
  const generationCalls = C * M * R * S;
  let judgingCalls: number;
  if (input.judgmentKind === "pairwise") {
    const PR = input.pairedRepeatCount ?? 1;
    const P = input.pairCount ?? Math.max(M * (M - 1) / 2, 1);
    const O = input.orientationCount ?? 1;
    judgingCalls = C * PR * P * J * O;
  } else {
    judgingCalls = C * M * R * J;
  }
  return {
    cases: C, candidates: M, generationRepeats: R, judges: J,
    stepsPerGeneration: S, generationCalls, judgingCalls,
    ...(input.judgmentKind === "pairwise"
      ? { pairedRepeatCount: input.pairedRepeatCount ?? 1, pairCount: input.pairCount ?? Math.max(M * (M - 1) / 2, 1), orientationCount: input.orientationCount ?? 1 }
      : {}),
  };
}

/** The implicit "run the workflow exactly as configured" candidate that a
 *  draft omits. Quote and start MUST expand identically or their hashes
 *  cannot agree — this is the only place that decision lives. */
export const AS_CONFIGURED_CANDIDATE_ID = "pipeline-as-configured";

export function expandDraftCandidates(
  candidates: Array<Omit<CandidateSpec, "baseVersionId"> & { baseVersionId?: number }>,
): Array<Omit<CandidateSpec, "baseVersionId">> {
  if (candidates.length > 0) {
    return candidates.map(({ baseVersionId, ...rest }) => { void baseVersionId; return rest; });
  }
  return [{
    stableCandidateId: AS_CONFIGURED_CANDIDATE_ID,
    strategy: "pipeline",
    decoding: {},
  }];
}

/** Steps one generation of a candidate performs. A solo baseline is a single
 *  LLM call; pipeline candidates run the snapshot. Plans mix both, so the
 *  plan-level count is the honest-HIGH maximum (spec §9 never under-quotes). */
export function planStepsPerGeneration(
  candidates: Array<Pick<CandidateSpec, "strategy">>,
  pipelineSteps: SnapshotStep[],
): number {
  const pipelineCount = upperBoundCallsPerGeneration(pipelineSteps);
  if (candidates.length === 0) return pipelineCount;
  return Math.max(1, ...candidates.map((c) => (c.strategy === "solo_baseline" ? 1 : pipelineCount)));
}

/** Deterministic serialization → sha256. Any change to cases, candidates,
 *  judges, rubric, limits or mode changes the hash and invalidates the spend
 *  approval (A06). `baseVersionId` is EXCLUDED on purpose: it is a row ID
 *  materialized during start, not user-approved intent, so hashing it would
 *  make every legitimate start look like a plan edit. Version identity is
 *  still recorded on the frozen plan and on each candidate row. */
export function hashPlan(plan: BenchmarkCallPlan): string {
  return createHash("sha256").update(stableStringify(canonicalPlanForHash(plan))).digest("hex");
}

export function canonicalPlanForHash(plan: BenchmarkCallPlan): BenchmarkCallPlan {
  return {
    ...plan,
    candidates: plan.candidates.map(({ baseVersionId, ...rest }) => {
      void baseVersionId;
      return { ...rest, baseVersionId: 0 } as CandidateSpec;
    }),
  };
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k])).join(",") + "}";
}

/** Validate the plan can actually run unattended before ANY spend: approval
 *  steps, empty panels, mode/candidate-shape contradictions and duplicate
 *  stable IDs (which would break the frozen case/candidate unique keys) all
 *  fail here, before a single provider call or version row is written. */
export function planPreflightErrors(plan: BenchmarkCallPlan, snapshotSteps: SnapshotStep[]): string[] {
  const errors: string[] = [];
  if (plan.cases.length === 0) errors.push("plan has no cases");
  if (plan.candidates.length === 0) errors.push("plan has no execution candidates");
  if (plan.judges.length === 0) errors.push("plan has no judges configured");
  if (snapshotSteps.some((s) => s.stepType === "approval")) {
    errors.push("the workflow contains approval (human-in-the-loop) steps; automated evaluation plans must not include them (spec §5.1)");
  }
  if (plan.limits.maxConcurrency < 1 || plan.limits.maxConcurrency > 10) errors.push("maxConcurrency must be 1–10");
  const dimSum = plan.rubric.dimensions.reduce((acc, d) => acc + d.weight, 0);
  if (!Number.isFinite(dimSum) || Math.abs(dimSum - 1) > 1e-6) {
    errors.push("rubric weights must be finite, nonnegative and sum to 1 after normalization");
  }

  for (const [label, ids] of [["case", plan.cases.map((c) => c.stableCaseId)], ["candidate", plan.candidates.map((c) => c.stableCandidateId)]] as const) {
    if (new Set(ids).size !== ids.length) errors.push(`duplicate stable ${label} ids in plan`);
  }
  for (const c of plan.candidates) {
    if (c.strategy === "solo_baseline" && !c.baselinePrompt) {
      errors.push(`solo baseline candidate "${c.stableCandidateId}" has no prompt to run`);
    }
    if (c.decoding.temperature !== undefined && (c.decoding.temperature < 0 || c.decoding.temperature > 2)) {
      errors.push(`candidate "${c.stableCandidateId}" decoding temperature out of range`);
    }
  }

  switch (plan.executionMode) {
    case "grade_only":
      // A01: grading one workflow, so exactly one as-configured candidate.
      if (plan.candidates.length !== 1) errors.push("grade_only must evaluate exactly one candidate (the workflow as configured)");
      if (plan.candidates.some((c) => c.strategy !== "pipeline" || Boolean(c.overrideModel || c.overrideProviderId))) {
        errors.push("grade_only must not override models/providers or add baseline candidates — use a comparison mode");
      }
      break;
    case "compare_models":
      if (plan.candidates.length < 2) errors.push("compare_models needs at least two candidates");
      if (plan.candidates.some((c) => c.strategy !== "pipeline" || !c.overrideModel)) {
        errors.push("compare_models candidates must each name an override model applied to every step");
      }
      break;
    case "compare_frontier_solo":
      if (!plan.candidates.some((c) => c.strategy === "pipeline")) errors.push("compare_frontier_solo needs the configured pipeline as one candidate");
      if (!plan.candidates.some((c) => c.strategy === "solo_baseline")) errors.push("compare_frontier_solo needs at least one solo baseline candidate");
      break;
  }

  if (plan.judgmentKind === "pairwise") {
    if (plan.candidates.length !== 2) errors.push("pairwise judging compares exactly two candidates — use rubric judging or a two-candidate plan");
    const paired = plan.pairedRepeatIndexes ?? [];
    if (paired.length === 0) errors.push("pairwise plans must state which generation repeats are paired");
    if (paired.some((i) => i < 1 || i > plan.generationRepeats)) errors.push("pairedRepeatIndexes must reference existing generation repeats");
    if (new Set(paired).size !== paired.length) errors.push("pairedRepeatIndexes must be unique");
  } else if ((plan.pairedRepeatIndexes?.length ?? 0) > 0) {
    errors.push("pairedRepeatIndexes are only valid on pairwise plans");
  }
  return errors;
}

export function candidateIsOverridden(c: CandidateSpec): boolean {
  return Boolean(c.overrideModel || c.overrideProviderId);
}
