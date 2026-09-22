// ICC(3,1) pinned against its OWN definition, not against a citation.
//
// The closed form was first written with `k·MSres` in the denominator where the
// algebra of the variance components gives `(k−1)·MSres`. That understated the
// statistic on this matrix (0.894199 against 0.922631) — and a reliability
// number that ships inside published evidence is exactly where a quiet
// off-by-one-denominator belongs least. If this test ever disagrees with a
// textbook, re-derive it from `sa/(sa+sb+se)` the way the case below does.

import { describe, expect, it } from "vitest";
import { computeIcc } from "./judgePanel";

// 5 cases × 3 judges, hand-writable values.
const MATRIX = [
  [7.0, 6.2, 7.6],
  [4.5, 5.1, 4.0],
  [8.9, 8.2, 9.4],
  [6.1, 6.6, 5.4],
  [3.2, 4.0, 3.0],
];

/** The decomposition, computed the long way round so the closed form has
 *  something independent to be checked against inside the test itself. */
function components(matrix: number[][]) {
  const n = matrix.length;
  const k = matrix[0].length;
  const grand = matrix.flat().reduce((a, x) => a + x, 0) / (n * k);
  const rowMeans = matrix.map((r) => r.reduce((a, x) => a + x, 0) / k);
  const colMeans = Array.from({ length: k }, (_, j) => matrix.reduce((a, r) => a + r[j], 0) / n);
  const msr = k * rowMeans.reduce((a, m) => a + (m - grand) ** 2, 0) / (n - 1);
  const msc = n * colMeans.reduce((a, m) => a + (m - grand) ** 2, 0) / (k - 1);
  let ssres = 0;
  matrix.forEach((r, i) => { for (let j = 0; j < k; j++) ssres += (r[j] - rowMeans[i] - colMeans[j] + grand) ** 2; });
  const msres = ssres / ((n - 1) * (k - 1));
  return { msr, msc, msres, sa: (msr - msres) / k, sb: (msc - msres) / n, se: msres };
}

describe("computeIcc — two-way mixed, absolute agreement", () => {
  it("ICC(3,1) equals σ²case / (σ²case + σ²judge + σ²residual)", () => {
    const { sa, sb, se } = components(MATRIX);
    const byDefinition = sa / (sa + sb + se);
    expect(computeIcc(MATRIX).icc31).toBe(Number(byDefinition.toFixed(6)));
    expect(computeIcc(MATRIX).icc31).toBeCloseTo(0.922631, 6);
  });

  it("ICC(3,k) is the average-measures form and is never below ICC(3,1)", () => {
    const { icc31, icc3k } = computeIcc(MATRIX);
    expect(icc31).not.toBeNull();
    expect(icc3k).not.toBeNull();
    expect(icc3k!).toBeCloseTo(0.972808, 6);
    expect(icc3k!).toBeGreaterThan(icc31!);
  });

  it("reports the usable rows and the column count with the number", () => {
    expect(computeIcc(MATRIX)).toMatchObject({ usedRows: 5, columns: 3, nullReason: null });
  });

  it("drops an incomplete case rather than mean-filling it, and says how many rows survived", () => {
    const ragged = MATRIX.map((r) => [...r]);
    ragged[2] = [8.9, 8.2]; // this case lost a rater
    const r = computeIcc(ragged);
    expect(r.usedRows).toBe(4);
    expect(r.columns).toBe(3);
    expect(r.icc31).not.toBeNull();
  });

  const degenerate: Array<[string, number[][], RegExp]> = [
    ["one judge", [[7], [4], [9]], /needs at least 2 judges/],
    ["one case", [[7, 6, 8]], /fewer than 2 cases/],
    ["no variance at all", [[5, 5, 5], [5, 5, 5]], /no variance to be reliable about/],
  ];
  for (const [label, matrix, reason] of degenerate) {
    it(`returns null with the reason named when the design is degenerate: ${label}`, () => {
      const r = computeIcc(matrix);
      expect(r.icc31).toBeNull();
      expect(r.icc3k).toBeNull();
      expect(r.nullReason).toMatch(reason);
    });
  }
});
