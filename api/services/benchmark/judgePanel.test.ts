// D12 unit drills on the pure halves: the vendor-disjointness gate's exact
// refusal text and the ICC(3,1)/ICC(3,k) math with hand-checkable numbers.
// No DB, no provider calls — vendor maps are passed in, exactly as
// `resolveModelVendors` would hand them over from the reviewed catalog.

import { describe, expect, it } from "vitest";
import {
  computeIcc, evaluateEvidencePanel, generatorModelsOfPlan, iccDesignNull,
  EVIDENCE_PANEL_RATINGS_PER_OUTPUT,
} from "./judgePanel";
import { panelVariants, JUDGE_PROMPT_VARIANTS, type JudgeSpec, type SnapshotStep } from "./benchmarkTypes";

const step = (stepOrder: number, model: string | null): SnapshotStep => ({
  stepOrder, name: `s${stepOrder}`, role: "builder", systemPrompt: "p", stepType: "agent",
  providerId: 1, model, temperature: "0.7", maxTokens: 1024, ifConfig: null, whileConfig: null,
});

const judge = (slot: number, model: string, variant?: JudgeSpec["variant"]): JudgeSpec => ({
  slot, providerId: 9, model, ...(variant ? { variant } : {}),
});

/** A full D12 panel: 3 developers, 3 different variants, generators elsewhere. */
const FULL_PANEL = [
  judge(1, "deepseek-v4", "anchored_scale"),
  judge(2, "glm-5.2", "comment_first"),
  judge(3, "llama-3.3-70b", "checklist_first"),
];
const VENDORS: Record<string, string | null> = {
  "deepseek-v4": "deepseek", "glm-5.2": "zhipu", "llama-3.3-70b": "meta",
  "qwen-gen": "qwen", "generator-x": "moonshot",
};
const GENERATORS = [{ label: 'candidate "pipe"', model: "qwen-gen" }];

const assess = (judges: JudgeSpec[], vendors = VENDORS, generators = GENERATORS) =>
  evaluateEvidencePanel({ judges, generators, vendors });

describe("vendor-disjointness gate (D12)", () => {
  it("accepts exactly 3 judges × 3 variants from 3 developers disjoint from the generators", () => {
    const a = assess(FULL_PANEL);
    expect(a.evidenceGrade).toBe(true);
    expect(a.issues).toEqual([]);
    expect(a.variants).toBe(3);
    expect(EVIDENCE_PANEL_RATINGS_PER_OUTPUT).toBe(9);
  });

  it("refuses two judges that share a developer, naming both models and the vendor", () => {
    const a = assess([judge(1, "deepseek-v4", "anchored_scale"), judge(2, "deepseek-r2", "comment_first"), judge(3, "llama-3.3-70b", "checklist_first")],
      { ...VENDORS, "deepseek-r2": "deepseek" });
    expect(a.evidenceGrade).toBe(false);
    expect(a.issues.some((i) => i.startsWith("panel_shared_vendor: judges deepseek-v4 and deepseek-r2 are both built by deepseek"))).toBe(true);
    expect(a.issues.join(" ")).toContain("never from which hosting provider's key served the call");
  });

  it("refuses an unknown vendor and says it counts as disjoint from nothing — never a collision", () => {
    const a = assess([judge(1, "mystery-a", "anchored_scale"), judge(2, "mystery-b", "comment_first"), judge(3, "llama-3.3-70b", "checklist_first")],
      { ...VENDORS, "mystery-a": null, "mystery-b": null });
    expect(a.evidenceGrade).toBe(false);
    const unknowns = a.issues.filter((i) => i.startsWith("panel_vendor_unknown:"));
    // One refusal per unknown model — and NOT a shared-vendor collision
    // between them: unknown attributes nothing, not even a clash.
    expect(unknowns).toHaveLength(2);
    expect(unknowns[0]).toContain("judge model mystery-a has no model developer (vendor) recorded in the reviewed catalog — an unknown vendor counts as disjoint from nothing");
    expect(a.issues.some((i) => i.startsWith("panel_shared_vendor"))).toBe(false);
  });

  it("refuses a judge that shares a developer with ANY generator in the plan (D33)", () => {
    const a = assess([judge(1, "qwen-judge", "anchored_scale"), judge(2, "glm-5.2", "comment_first"), judge(3, "llama-3.3-70b", "checklist_first")],
      { ...VENDORS, "qwen-judge": "qwen" });
    expect(a.evidenceGrade).toBe(false);
    expect(a.issues.some((i) => i.startsWith("panel_judge_generator_vendor_overlap: judge qwen-judge is built by qwen, the same developer as generating model qwen-gen"))).toBe(true);
  });

  it("refuses fewer than 3 judges and fewer than 3 declared variants", () => {
    const two = assess([judge(1, "deepseek-v4", "anchored_scale"), judge(2, "glm-5.2", "comment_first")]);
    expect(two.issues.some((i) => i.startsWith("panel_needs_three_judges"))).toBe(true);
    const sameVariant = assess(FULL_PANEL.map((j) => ({ ...j, variant: "anchored_scale" as const })));
    expect(sameVariant.issues.some((i) => i.startsWith("panel_needs_three_variants"))).toBe(true);
    expect(sameVariant.issues.some((i) => i.startsWith("panel_shared_vendor"))).toBe(false);
  });

  it("a solo baseline (model unnamed) and an uncatalogued generator are both refusals", () => {
    const solo = evaluateEvidencePanel({ judges: FULL_PANEL, generators: [{ label: 'candidate "solo" (solo baseline)', model: null }], vendors: VENDORS });
    expect(solo.issues.some((i) => i.startsWith("panel_generator_model_unattributed"))).toBe(true);
    const uncatalogued = evaluateEvidencePanel({ judges: FULL_PANEL, generators: [{ label: 'candidate "c"', model: "ghost-model" }], vendors: VENDORS });
    expect(uncatalogued.issues.some((i) => i.startsWith("panel_generator_vendor_unknown"))).toBe(true);
  });

  it("generatorModelsOfPlan uses overrides when named, snapshot steps otherwise, and nothing for imported outputs", () => {
    const steps = [step(1, "qwen-gen"), step(2, "qwen-gen")];
    expect(generatorModelsOfPlan([{ stableCandidateId: "x", strategy: "pipeline", overrideModel: "generator-x" }], steps))
      .toEqual([{ label: 'candidate "x"', model: "generator-x" }]);
    expect(generatorModelsOfPlan([{ stableCandidateId: "as-config", strategy: "pipeline" }], steps))
      .toEqual([{ label: 'candidate "as-config" step 1', model: "qwen-gen" }]); // deduped per model: one refusal, not one per step
    expect(generatorModelsOfPlan([{ stableCandidateId: "imp", strategy: "imported_output" }], steps)).toEqual([]);
  });
});

describe("panel variant set and the legacy default", () => {
  it("a pre-D12 panel (no declared variants) is ONE rater-set entry — never a silent ×3", () => {
    expect(panelVariants([judge(1, "m"), judge(2, "n")])).toEqual([undefined]);
    expect(panelVariants(FULL_PANEL)).toEqual(["anchored_scale", "comment_first", "checklist_first"]);
    expect(panelVariants([judge(1, "m")])).toEqual([undefined]);
  });

  it("the variant enum is exactly the three canonical framings", () => {
    expect([...JUDGE_PROMPT_VARIANTS]).toEqual(["anchored_scale", "comment_first", "checklist_first"]);
  });
});

describe("ICC(3,1) / ICC(3,k) — two-way mixed, absolute agreement", () => {
  // WORKED EXAMPLE (the arithmetic the module comment promises):
  // matrix ROWS = cases, COLUMNS = judges.
  //   X = [[1, 3, 2],
  //        [3, 5, 4],
  //        [4, 4, 7]]        n = 3 rows, k = 3 columns, grand = 33/9 = 11/3
  //   row means 2, 4, 5      → SSR = 3·((−5/3)² + (1/3)² + (4/3)²) = 14 → MSR = 7
  //   col means 8/3, 4, 13/3 → SSC = 3·((−1)² + (1/3)² + (2/3)²) = 14/3 → MSC = 7/3
  //   residuals (x − row − col + grand): row1 {0, 2/3, −2/3}, row2 {0, 2/3, −2/3},
  //     row3 {0, −4/3, 4/3} → SSres = 16/3 → MSres = (16/3)/4 = 4/3
  //   ICC(3,1) = (7 − 4/3)/(7 + (3−1)·4/3 + (3/3)(7/3 − 4/3)) = (17/3)/(32/3) = 17/32 = 0.53125
  //   ICC(3,3) = (7 − 4/3)/(7 + (7/3 − 4/3)/3) = (17/3)/(22/3) = 17/22 = 0.772727…
  const X = [[1, 3, 2], [3, 5, 4], [4, 4, 7]];

  it("computes ICC(3,1) and ICC(3,k) at the hand-derived values", () => {
    const icc = computeIcc(X);
    expect(icc.nullReason).toBeNull();
    expect(icc.icc31).toBe(0.53125); // 17/32 exactly
    expect(icc.icc3k).toBe(0.772727); // 17/22 rounded to 6 like its neighbours
    expect(icc.usedRows).toBe(3);
    expect(icc.columns).toBe(3);
  });

  it("ICC(3,k) is the average-measures value: always at least ICC(3,1) here", () => {
    const icc = computeIcc([[0.4, 0.6, 0.5], [0.7, 0.5, 0.9], [0.2, 0.4, 0.3], [0.9, 0.7, 0.8]]);
    expect(icc.nullReason).toBeNull();
    expect(icc.icc31!).toBeLessThan(icc.icc3k!);
  });

  it("nulls an all-identical matrix instead of inventing a number", () => {
    const icc = computeIcc([[5, 5, 5], [5, 5, 5], [5, 5, 5]]);
    expect(icc.icc31).toBeNull();
    expect(icc.icc3k).toBeNull();
    expect(icc.nullReason).toContain("every rating in the matrix is identical");
  });

  it("nulls fewer than 2 complete cases", () => {
    const icc = computeIcc([[1, 2, 3]]);
    expect(icc.icc31).toBeNull();
    expect(icc.nullReason).toContain("fewer than 2 cases");
  });

  it("nulls fewer than 2 rating columns", () => {
    const icc = computeIcc([[1], [2], [3]]);
    expect(icc.icc31).toBeNull();
    expect(icc.nullReason).toContain("rating column");
  });
});

describe("ICC design degeneracy beyond the matrix (D12 conditions)", () => {
  it("fewer than 3 judging models is degenerate whatever the vendors say", () => {
    expect(iccDesignNull(["deepseek", "meta"], 2)).toContain("fewer than 3 judges is degenerate");
    expect(iccDesignNull([null, null, null], 3)).toContain("no developer (vendor) recorded");
    expect(iccDesignNull(["meta", "meta", "meta"], 3)).toContain("every judge is a meta model");
    expect(iccDesignNull(["deepseek", "meta", "zhipu"], 3)).toBeNull();
    expect(iccDesignNull(["deepseek", "deepseek", "meta"], 3)).toBeNull(); // not single-vendor; matrix decides the rest
  });
});
