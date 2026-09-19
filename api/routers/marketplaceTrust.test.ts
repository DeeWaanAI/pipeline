// Pure-function tests for the Marketplace Trust & Certification logic
// (spec: DeeWaanAI-Next/MARKETPLACE-TRUST-SPEC.md, Phase 0).
// No DB/network: covers kappa math, certification thresholds, the blind-task
// payload shape (no identity leak), and the AI triage floor constant.
// DB-backed pool behavior (claim race, self-review ban, quorum) is exercised
// by the parent's integration gates.

import { describe, it, expect } from "vitest";
import {
  calculateFleissKappa,
  decideCertification,
  toBlindTaskPayload,
  REVIEW_RUBRIC,
  AI_TRIAGE_FLOOR,
  CERTIFY_MIN_AVG_SCORE,
  CERTIFY_MIN_KAPPA,
  CERTIFY_MIN_PASS_RATIO,
  bucketForKappa,
  KAPPA_BUCKET_CATEGORIES,
} from "./marketplace";

describe("calculateFleissKappa", () => {
  it("returns 0 for empty input", () => {
    expect(calculateFleissKappa([], 5)).toEqual({ kappa: 0, pe: 0 });
  });

  it("treats a single rater as perfect agreement (beta self-cert)", () => {
    const { kappa } = calculateFleissKappa([[4], [5], [3]], 5);
    expect(kappa).toBe(1.0);
  });

  it("perfect agreement across raters → kappa 1", () => {
    const ratings = [
      [5, 5, 5],
      [4, 4, 4],
      [3, 3, 3],
    ];
    const { kappa } = calculateFleissKappa(ratings, 5);
    expect(kappa).toBeGreaterThan(0.99);
  });

  it("total disagreement → kappa well below the 0.60 certification bar", () => {
    const ratings = [
      [1, 5, 3],
      [5, 1, 2],
      [2, 4, 5],
      [4, 2, 1],
    ];
    const { kappa } = calculateFleissKappa(ratings, 5);
    expect(kappa).toBeLessThan(CERTIFY_MIN_KAPPA);
  });

  it("clamps kappa into [-1, 1]", () => {
    const { kappa } = calculateFleissKappa(
      [
        [1, 5],
        [5, 1],
        [1, 5],
        [5, 1],
      ],
      5,
    );
    expect(kappa).toBeGreaterThanOrEqual(-1);
    expect(kappa).toBeLessThanOrEqual(1);
  });
});

describe("bucketForKappa + bucketed kappa (2026-07-27 calibration)", () => {
  it("buckets weighted scores at the certification bar", () => {
    expect(bucketForKappa(3.49)).toBe(1);
    expect(bucketForKappa(3.5)).toBe(2);
    expect(bucketForKappa(5)).toBe(2);
    expect(bucketForKappa(1)).toBe(1);
  });

  it("rehearsal regression: 4s and 5s with ±1 jitter now AGREE (was kappa 0.479 → rejected)", () => {
    // 5 reviewers, 10 prompts, weighted scores clustered at 4–5 — the exact
    // pattern that scored kappa 0.479 on raw 1–5 accuracy ratings.
    const bucketed = Array.from({ length: 10 }, (_, i) =>
      [4.2, 4.5, 4.0, 4.8, 4.3].map((v, j) => bucketForKappa(v + ((i + j) % 2) * 0.4)),
    );
    const { kappa } = calculateFleissKappa(bucketed, KAPPA_BUCKET_CATEGORIES);
    expect(kappa).toBeGreaterThan(CERTIFY_MIN_KAPPA);
  });

  it("unanimous pass → kappa 1 via the prevalence guard", () => {
    const bucketed = Array.from({ length: 10 }, () => [2, 2, 2, 2, 2]);
    const { kappa } = calculateFleissKappa(bucketed, KAPPA_BUCKET_CATEGORIES);
    expect(kappa).toBe(1);
  });

  it("genuine decision disagreement still fails the bar", () => {
    // Reviewers split pass/fail on every prompt — real disagreement.
    const bucketed = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? [2, 1, 2, 1, 1] : [1, 2, 1, 2, 2]));
    const { kappa } = calculateFleissKappa(bucketed, KAPPA_BUCKET_CATEGORIES);
    expect(kappa).toBeLessThan(CERTIFY_MIN_KAPPA);
  });
});

describe("decideCertification (2026-07-28 redesign: avg ≥ 3.5 && pass ratio ≥ 0.80)", () => {
  it("publishes at exactly avg 3.5 with 100% pass ratio", () => {
    expect(decideCertification(3.5, 1.0)).toBe("published");
  });

  it("publishes a high-grade listing even with a few dissenters (beta regression: grade 4.87, kappa 0.01)", () => {
    // 27/30 reviews pass = 0.90 pass ratio — the exact profile Fleiss' kappa
    // rejected (prevalence paradox). Pass-ratio publishes it.
    expect(decideCertification(4.87, 0.9)).toBe("published");
  });

  it("rejects at exactly 79% pass ratio (below the 0.80 bar)", () => {
    expect(decideCertification(4.5, 0.79)).toBe("rejected");
  });

  it("rejects below-average scores even with everyone passing it... impossible by definition — sanity: low avg, high pass", () => {
    // avg < 3.5 with pass ratio ≥ 0.8 cannot happen in practice, but the
    // function must still gate on both conditions independently.
    expect(decideCertification(3.49, 1.0)).toBe("rejected");
  });

  it("rejects mediocre listings that reviewers split on", () => {
    expect(decideCertification(3.6, 0.5)).toBe("rejected");
  });

  it("threshold constants match the redesigned gate", () => {
    expect(CERTIFY_MIN_AVG_SCORE).toBe(3.5);
    expect(CERTIFY_MIN_PASS_RATIO).toBe(0.8);
    expect(CERTIFY_MIN_KAPPA).toBe(0.6); // kept as logged diagnostic only
  });
});

describe("AI triage floor (spec 0.3)", () => {
  it("starts at 2.5/5 and is never a publish path", () => {
    expect(AI_TRIAGE_FLOOR).toBe(2.5);
  });
});

describe("toBlindTaskPayload (spec 0.5.3: blind review)", () => {
  it("returns ONLY taskId, inputText, actualOutput, rubric — no identity", () => {
    const payload = toBlindTaskPayload(42, "Translate: hello", "bonjour");

    expect(Object.keys(payload).sort()).toEqual(
      ["actualOutput", "inputText", "rubric", "taskId"].sort(),
    );
    expect(payload.taskId).toBe(42);
    expect(payload.inputText).toBe("Translate: hello");
    expect(payload.actualOutput).toBe("bonjour");

    // No listing/creator identity anywhere in the payload (deep check).
    const serialized = JSON.stringify(payload);
    for (const forbidden of ["listingId", "listing_id", "creatorId", "creator", "title", "category"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("rubric covers exactly the 6 scoring dimensions reviewers must supply", () => {
    expect(Object.keys(REVIEW_RUBRIC).sort()).toEqual(
      ["accuracy", "clarity", "completeness", "consistency", "speed", "tokenEfficiency"].sort(),
    );
  });

  it("tolerates a null actualOutput (still no extra keys)", () => {
    const payload = toBlindTaskPayload(7, "input", null);
    expect(payload.actualOutput).toBeNull();
    expect(Object.keys(payload)).toHaveLength(4);
  });
});
