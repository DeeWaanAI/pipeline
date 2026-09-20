// Unit tests for the frozen call-plan core (offering redesign v2, spec §9 and
// A06/A08 at the pure level). No DB, no provider calls.

import { describe, expect, it } from "vitest";
import {
  AS_CONFIGURED_CANDIDATE_ID, computeCounts, expandDraftCandidates, hashPlan,
  planPreflightErrors, planStepsPerGeneration,
} from "./benchmarkCallPlan";
import type { BenchmarkCallPlan, CandidateSpec, RubricSpec, SnapshotStep } from "./benchmarkTypes";

const RUBRIC: RubricSpec = {
  versionRef: "preset-generic-v1",
  dimensions: [
    { dimension: "accuracy", lowerBound: 0, upperBound: 10, weight: 0.5, anchor: "a" },
    { dimension: "clarity", lowerBound: 0, upperBound: 10, weight: 0.5, anchor: "c" },
  ],
  normalizedWeights: [0.5, 0.5],
};

const agentStep = (stepOrder: number): SnapshotStep => ({
  stepOrder, name: `s${stepOrder}`, role: "builder", systemPrompt: "p", stepType: "agent",
  providerId: 1, model: "glm-4.5", temperature: "0.7", maxTokens: 1024, ifConfig: null, whileConfig: null,
});

/** Spec §9 worked example: five fixed LLM steps. */
const FIVE_STEPS = [1, 2, 3, 4, 5].map(agentStep);
const CASES = ["a", "b", "c"].map((t, i) => ({ stableCaseId: `case-${i + 1}`, inputText: t, origin: "user" as const }));
const JUDGES = [1, 2, 3].map((slot) => ({ slot, providerId: slot, model: `judge-${slot}` }));

const candidate = (over: Partial<CandidateSpec> = {}): CandidateSpec => ({
  stableCandidateId: "candidate-1", strategy: "pipeline", baseVersionId: 0, decoding: {}, ...over,
});

function plan(over: Partial<BenchmarkCallPlan> = {}): BenchmarkCallPlan {
  return {
    schemaVersion: 1,
    executionMode: "compare_models",
    cases: CASES,
    candidates: [candidate({ stableCandidateId: "x", overrideModel: "m-x" }), candidate({ stableCandidateId: "y", overrideModel: "m-y" })],
    judges: JUDGES,
    rubric: RUBRIC,
    generationRepeats: 1,
    judgmentKind: "rubric",
    limits: { maxConcurrency: 2, deadlineMs: 60_000, maxTokensPerCall: 1024 },
    counts: computeCounts({
      caseCount: CASES.length, candidateCount: 2, generationRepeats: 1, judgeCount: JUDGES.length,
      stepsPerGeneration: 5, judgmentKind: "rubric",
    }),
    ...over,
  };
}

describe("call-plan arithmetic (spec §9, A08)", () => {
  it("counts 3 cases x 2 candidates x 1 repeat x 5 steps as 30 generation calls", () => {
    const counts = computeCounts({
      caseCount: 3, candidateCount: 2, generationRepeats: 1, judgeCount: 3, stepsPerGeneration: 5, judgmentKind: "rubric",
    });
    expect(counts.generationCalls).toBe(30);
    expect(counts.judgingCalls).toBe(18); // C x M x R x J
  });

  it("counts one paired comparison per case with 3 judges and 1 orientation as 9 judging calls", () => {
    const counts = computeCounts({
      caseCount: 3, candidateCount: 2, generationRepeats: 1, judgeCount: 3, stepsPerGeneration: 5,
      judgmentKind: "pairwise", pairedRepeatCount: 1, pairCount: 1, orientationCount: 1,
    });
    expect(counts.judgingCalls).toBe(9);
    expect(counts.generationCalls).toBe(30);
  });

  it("quotes mixed solo/pipeline plans at the largest candidate (honest-high)", () => {
    expect(planStepsPerGeneration([candidate({ strategy: "solo_baseline" })], FIVE_STEPS)).toBe(1);
    expect(planStepsPerGeneration([candidate({ strategy: "solo_baseline" }), candidate()], FIVE_STEPS)).toBe(5);
  });
});

describe("plan hashing (A06)", () => {
  it("ignores candidate version IDs materialized during start", () => {
    const quoted = plan();
    const frozen = plan({
      candidates: [
        candidate({ stableCandidateId: "x", overrideModel: "m-x", baseVersionId: 41 }),
        candidate({ stableCandidateId: "y", overrideModel: "m-y", baseVersionId: 42 }),
      ],
    });
    expect(hashPlan(frozen)).toBe(hashPlan(quoted));
  });

  it("changes when the approved intent changes", () => {
    const base = plan();
    expect(hashPlan(plan({ cases: [...CASES, { stableCaseId: "case-4", inputText: "d", origin: "user" }] }))).not.toBe(hashPlan(base));
    expect(hashPlan(plan({ judges: JUDGES.slice(0, 2) }))).not.toBe(hashPlan(base));
    expect(hashPlan(plan({ rubric: { ...RUBRIC, versionRef: "other" } }))).not.toBe(hashPlan(base));
    expect(hashPlan(plan({ generationRepeats: 2 }))).not.toBe(hashPlan(base));
    expect(hashPlan(plan({ limits: { ...base.limits, maxConcurrency: 5 } }))).not.toBe(hashPlan(base));
    // A workflow edit that changes the call count invalidates the quote too.
    expect(hashPlan(plan({ counts: { ...base.counts, generationCalls: 36 } }))).not.toBe(hashPlan(base));
  });

  it("expands an empty draft candidate list the same way quote and start do", () => {
    const expanded = expandDraftCandidates([]);
    expect(expanded).toHaveLength(1);
    expect(expanded[0].stableCandidateId).toBe(AS_CONFIGURED_CANDIDATE_ID);
    expect(expandDraftCandidates([candidate({ baseVersionId: 7 })])).toEqual([
      { stableCandidateId: "candidate-1", strategy: "pipeline", decoding: {} },
    ]);
  });
});

describe("plan preflight (spec §5.1/§9)", () => {
  const steps = (extra: SnapshotStep[] = []) => [...FIVE_STEPS, ...extra];

  it("rejects human-in-the-loop approval steps before any spend", () => {
    const approvalStep: SnapshotStep = { ...agentStep(6), stepType: "approval" };
    expect(planPreflightErrors(plan(), steps([approvalStep])).join("\n")).toContain("approval (human-in-the-loop) steps");
  });

  it("keeps grade_only to the workflow as configured", () => {
    const gradeOnly = plan({
      executionMode: "grade_only",
      candidates: [candidate()],
      counts: computeCounts({ caseCount: 3, candidateCount: 1, generationRepeats: 1, judgeCount: 3, stepsPerGeneration: 5, judgmentKind: "rubric" }),
    });
    expect(planPreflightErrors(gradeOnly, FIVE_STEPS)).toEqual([]);
    expect(planPreflightErrors({ ...gradeOnly, candidates: [candidate({ overrideModel: "other" })] }, FIVE_STEPS).join("\n")).toContain("must not override");
    expect(planPreflightErrors({ ...gradeOnly, candidates: [candidate(), candidate({ stableCandidateId: "two" })] }, FIVE_STEPS).join("\n")).toContain("exactly one candidate");
  });

  it("requires every compare_models candidate to name an override model", () => {
    expect(planPreflightErrors(plan(), FIVE_STEPS)).toEqual([]);
    expect(planPreflightErrors(plan({ candidates: [candidate(), candidate({ stableCandidateId: "y" })] }), FIVE_STEPS).join("\n")).toContain("override model");
  });

  it("requires both halves of a frontier-vs-solo comparison", () => {
    const solo = candidate({ stableCandidateId: "solo", strategy: "solo_baseline", baselinePrompt: "answer directly" });
    expect(planPreflightErrors(plan({ executionMode: "compare_frontier_solo", candidates: [candidate(), solo] }), FIVE_STEPS)).toEqual([]);
    expect(planPreflightErrors(plan({ executionMode: "compare_frontier_solo", candidates: [candidate()] }), FIVE_STEPS).join("\n")).toContain("solo baseline");
    expect(planPreflightErrors(plan({ executionMode: "compare_frontier_solo", candidates: [candidate(), { ...solo, baselinePrompt: undefined }] }), FIVE_STEPS).join("\n")).toContain("no prompt to run");
  });

  it("pins the pairwise shape instead of guessing a cross-product", () => {
    const pairwise = plan({ judgmentKind: "pairwise", pairedRepeatIndexes: [1] });
    expect(planPreflightErrors(pairwise, FIVE_STEPS)).toEqual([]);
    expect(planPreflightErrors({ ...pairwise, pairedRepeatIndexes: undefined }, FIVE_STEPS).join("\n")).toContain("which generation repeats are paired");
    expect(planPreflightErrors({ ...pairwise, candidates: [candidate()] }, FIVE_STEPS).join("\n")).toContain("exactly two candidates");
    expect(planPreflightErrors({ ...pairwise, pairedRepeatIndexes: [9] }, FIVE_STEPS).join("\n")).toContain("existing generation repeats");
  });

  it("rejects duplicate stable ids and a broken rubric", () => {
    expect(planPreflightErrors(plan({ candidates: [candidate({ stableCandidateId: "dup" }), candidate({ stableCandidateId: "dup" })] }), FIVE_STEPS).join("\n")).toContain("duplicate stable candidate");
    const badWeights = { ...RUBRIC, dimensions: RUBRIC.dimensions.map((d) => ({ ...d, weight: 0.3 })), normalizedWeights: [0.3, 0.3] };
    expect(planPreflightErrors(plan({ rubric: badWeights }), FIVE_STEPS).join("\n")).toContain("sum to 1");
  });
});
