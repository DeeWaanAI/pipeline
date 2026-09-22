// Unit tests for the frozen call-plan core (offering redesign v2, spec §9 and
// A06/A08 at the pure level). No DB, no provider calls.

import { describe, expect, it } from "vitest";
import {
  AS_CONFIGURED_CANDIDATE_ID, computeCounts, expandDraftCandidates, hashPlan,
  planPreflightErrors, repeatsForCandidate, stepsPerGenerationForCandidate,
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
    validators: [],
    generationRepeats: 1,
    judgmentKind: "rubric",
    limits: { maxConcurrency: 2, deadlineMs: 60_000, maxTokensPerCall: 1024 },
    counts: computeCounts({
      caseCount: CASES.length, judgeCount: JUDGES.length, judgmentKind: "rubric",
      candidates: [
        { stableCandidateId: "x", strategy: "pipeline", repeats: 1, stepsPerGeneration: 5 },
        { stableCandidateId: "y", strategy: "pipeline", repeats: 1, stepsPerGeneration: 5 },
      ],
    }),
    ...over,
  };
}

describe("call-plan arithmetic (spec §9, A08)", () => {
  it("counts 3 cases x 2 candidates x 1 repeat x 5 steps as 30 generation calls", () => {
    const counts = computeCounts({
      caseCount: 3, judgeCount: 3, judgmentKind: "rubric",
      candidates: [
        { stableCandidateId: "x", strategy: "pipeline", repeats: 1, stepsPerGeneration: 5 },
        { stableCandidateId: "y", strategy: "pipeline", repeats: 1, stepsPerGeneration: 5 },
      ],
    });
    expect(counts.generationCalls).toBe(30);
    expect(counts.judgingCalls).toBe(18); // C x M x R x J
  });

  it("counts one paired comparison per case with 3 judges and 1 orientation as 9 judging calls", () => {
    const counts = computeCounts({
      caseCount: 3, judgeCount: 3, judgmentKind: "pairwise",
      candidates: [
        { stableCandidateId: "x", strategy: "pipeline", repeats: 1, stepsPerGeneration: 5 },
        { stableCandidateId: "y", strategy: "pipeline", repeats: 1, stepsPerGeneration: 5 },
      ],
      pairedRepeatCount: 1, pairCount: 1, orientationCount: 1,
    });
    expect(counts.judgingCalls).toBe(9);
    expect(counts.generationCalls).toBe(30);
  });

  it("sums generation calls per candidate rather than quoting every one at the widest", () => {
    const counts = computeCounts({
      caseCount: 3, judgeCount: 1, judgmentKind: "rubric",
      candidates: [
        { stableCandidateId: "pipe", strategy: "pipeline", repeats: 2, stepsPerGeneration: 5 },
        { stableCandidateId: "solo", strategy: "solo_baseline", repeats: 2, stepsPerGeneration: 1 },
        { stableCandidateId: "imported", strategy: "imported_output", repeats: 1, stepsPerGeneration: 0 },
      ],
    });
    expect(counts.generationCalls).toBe(3 * 2 * 5 + 3 * 2 * 1 + 0); // 36, not 3×3×5
    expect(counts.generationPerCandidate.map((c) => c.calls)).toEqual([30, 6, 0]);
  });

  it("grades an existing output with no generation call and no repeats (A01)", () => {
    const imported = candidate({ strategy: "imported_output", importedResponseId: 7 });
    expect(stepsPerGenerationForCandidate(imported, FIVE_STEPS)).toBe(0);
    expect(repeatsForCandidate(imported, 4)).toBe(1);
    expect(stepsPerGenerationForCandidate(candidate({ strategy: "solo_baseline" }), FIVE_STEPS)).toBe(1);
    expect(stepsPerGenerationForCandidate(candidate(), FIVE_STEPS)).toBe(5);
  });

  it("D12: a 3-judge × 3-variant panel is the cross product — 9 ratings per output, quoted as such", () => {
    const counts = computeCounts({
      caseCount: 3, judgeCount: 3, judgmentKind: "rubric", variantCount: 3,
      candidates: [
        { stableCandidateId: "x", strategy: "pipeline", repeats: 1, stepsPerGeneration: 5 },
        { stableCandidateId: "y", strategy: "pipeline", repeats: 1, stepsPerGeneration: 5 },
      ],
    });
    expect(counts.judgingCalls).toBe(54); // C × M × R × J × V = 3 × 2 × 1 × 9
    expect(counts.judgingPromptVariants).toBe(3);
    expect(counts.generationCalls).toBe(30); // generation is untouched by the panel
  });

  it("D12: pairwise judging multiplies by the variant count too, and omits the field when V=1", () => {
    const withVariants = computeCounts({
      caseCount: 3, judgeCount: 3, judgmentKind: "pairwise", variantCount: 3,
      candidates: [
        { stableCandidateId: "x", strategy: "pipeline", repeats: 1, stepsPerGeneration: 5 },
        { stableCandidateId: "y", strategy: "pipeline", repeats: 1, stepsPerGeneration: 5 },
      ],
      pairedRepeatCount: 1, pairCount: 1, orientationCount: 1,
    });
    expect(withVariants.judgingCalls).toBe(27); // C × PR × P × J × O × V
    const legacy = computeCounts({
      caseCount: 3, judgeCount: 3, judgmentKind: "rubric",
      candidates: [{ stableCandidateId: "x", strategy: "pipeline", repeats: 1, stepsPerGeneration: 5 }],
    });
    // A panel without variants has NO new key in counts at all: untouched
    // drafts keep hashing to the planHash their spend approval was signed for.
    expect(legacy).not.toHaveProperty("judgingPromptVariants");
    expect(legacy.judgingCalls).toBe(9);
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

  it("D12: prompt variants join the hash — panels differing only in variants need separate approvals", () => {
    const base = plan(); // no variants declared
    const withVariants = plan({
      judges: [
        { slot: 1, providerId: 1, model: "judge-1", variant: "anchored_scale" },
        { slot: 2, providerId: 2, model: "judge-2", variant: "comment_first" },
        { slot: 3, providerId: 3, model: "judge-3", variant: "checklist_first" },
      ],
      counts: computeCounts({
        caseCount: 3, judgeCount: 3, judgmentKind: "rubric", variantCount: 3,
        candidates: [
          { stableCandidateId: "x", strategy: "pipeline", repeats: 1, stepsPerGeneration: 5 },
          { stableCandidateId: "y", strategy: "pipeline", repeats: 1, stepsPerGeneration: 5 },
        ],
      }),
    });
    const reshuffled = JSON.parse(JSON.stringify(withVariants)) as typeof withVariants;
    reshuffled.judges = reshuffled.judges.map((j) => ({ ...j, variant: j.slot === 1 ? "comment_first" : j.slot === 2 ? "anchored_scale" : "checklist_first" }) as typeof j);
    expect(hashPlan(withVariants)).not.toBe(hashPlan(base));
    // which judge carries WHICH variant is committed, not just that variants exist
    expect(hashPlan(reshuffled)).not.toBe(hashPlan(withVariants));
    // key ORDER inside a judge entry must not matter (stable stringify)
    const reordered = plan({ judges: [{ providerId: 1, variant: "anchored_scale", slot: 1, model: "judge-1" }, ...base.judges.slice(1)] as typeof base.judges, candidates: base.candidates });
    expect(hashPlan({ ...plan(), judges: [{ slot: 1, providerId: 1, model: "judge-1", variant: "anchored_scale" }, ...plan().judges.slice(1)] })).toBe(hashPlan(reordered));
  });

  it("a pre-D12 stored plan with no variant key still loads, hashes and preflights unchanged", () => {
    // Exactly the JSON that was frozen before D12: judges are {slot, providerId, model}.
    const stored = JSON.stringify(plan());
    const loaded = JSON.parse(stored) as BenchmarkCallPlan;
    expect(planPreflightErrors(loaded, FIVE_STEPS)).toEqual([]);
    expect(hashPlan(loaded)).toBe(hashPlan(plan()));
    expect(loaded.judges.every((j) => j.variant === undefined)).toBe(true);
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
      counts: computeCounts({
        caseCount: 3, judgeCount: 3, judgmentKind: "rubric",
        candidates: [{ stableCandidateId: "only", strategy: "pipeline", repeats: 1, stepsPerGeneration: 5 }],
      }),
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

  it("D12: rejects a duplicated judge slot and a variant outside the closed enum (a plan re-read from the DB is not trusted)", () => {
    const dupSlot = plan({ judges: [JUDGES[0], JUDGES[1], { ...JUDGES[2], slot: 2 }] });
    expect(planPreflightErrors(dupSlot, FIVE_STEPS).join("\n")).toContain("judge slots must be distinct");
    const junkVariant = plan({ judges: [{ ...JUDGES[0], variant: "make_my_answer_win" } as (typeof JUDGES)[0], JUDGES[1], JUDGES[2]] });
    const errs = planPreflightErrors(junkVariant, FIVE_STEPS).join("\n");
    expect(errs).toContain('unknown prompt variant "make_my_answer_win"');
    expect(errs).toContain("anchored_scale, comment_first, checklist_first");
  });
});
