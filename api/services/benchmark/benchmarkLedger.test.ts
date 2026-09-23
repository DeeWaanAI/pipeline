// The money rule, tested as a pure function: an operation whose price is not
// known is never shown as a dollar figure that could be read as "owed".

import { describe, expect, it, vi } from "vitest";

vi.mock("../../queries/connection", () => ({
  getDb: () => { throw new Error("costDisclosure must not touch the database"); },
}));

import { costDisclosure, type CostDisclosureInput } from "./benchmarkLedger";

const totals = (over: Partial<CostDisclosureInput>): CostDisclosureInput => ({
  totalCalls: 0, uncertainCalls: 0, pricedOperations: 0,
  knownCostUsd: "0.00000000", costCompleteness: "unknown", pricingBases: [], ...over,
});

describe("costDisclosure", () => {
  it("says nothing has been spent only when nothing has been recorded", () => {
    const c = costDisclosure(totals({}));
    expect(c.knownUsd).toBeNull();
    expect(c.pricedSoFarUsd).toBeNull();
    expect(c.display).toMatch(/No provider call recorded/);
  });

  it("states a total when every recorded operation is priced, and names the source", () => {
    const c = costDisclosure(totals({
      totalCalls: 15, pricedOperations: 15, knownCostUsd: "0.02535202",
      costCompleteness: "complete", pricingBases: ["provider_list"],
    }));
    expect(c.knownUsd).toBe("0.02535202");
    expect(c.unpricedOperations).toBe(0);
    expect(c.display).toContain("$0.02535202");
    expect(c.display).toContain("all of them priced");
    expect(c.display).toContain("provider_list");
  });

  it("reproduces D9 finding 1 as a floor, never as a zero total", () => {
    // Benchmark 5: 19 recorded operations, none of them priced. It printed
    // `knownUsd: "0.00000000"` with `totalCalls: 19`, which a user read as
    // "19 calls, nothing owed".
    const c = costDisclosure(totals({ totalCalls: 19, pricedOperations: 0, knownCostUsd: "0.00000000", costCompleteness: "partial" }));
    expect(c.knownUsd).toBeNull();
    expect(JSON.stringify(c)).not.toMatch(/"knownUsd":"0\.00000000"/);
    expect(c.unpricedOperations).toBe(19);
    expect(c.display).toMatch(/FLOOR and not the total owed/);
    expect(c.display).toContain("19 have no price yet");
  });

  it("keeps the partial sum visible but labelled when only some operations priced", () => {
    const c = costDisclosure(totals({
      totalCalls: 4, pricedOperations: 3, knownCostUsd: "0.01500000", costCompleteness: "partial",
    }));
    expect(c.knownUsd).toBeNull();
    expect(c.pricedSoFarUsd).toBe("0.01500000");
    expect(c.unpricedOperations).toBe(1);
    expect(c.display).toMatch(/At least \$0\.01500000 of 4/);
  });

  it("warns that an uncertain outcome can move a fully-priced figure", () => {
    const c = costDisclosure(totals({
      totalCalls: 6, pricedOperations: 6, uncertainCalls: 2,
      knownCostUsd: "0.03000000", costCompleteness: "complete",
    }));
    expect(c.knownUsd).toBe("0.03000000");
    expect(c.uncertainOperations).toBe(2);
    expect(c.display).toContain("uncertain outcome");
  });
});

// ─── pricing an aggregate that spans several models (#37) ────────────
//
// `compare_models` is the flow where cost matters most and it produced nothing
// but `unknown`: a run whose steps use different models has no single
// (provider, model) route, so the ledger row had no number to hold even though
// every model in it is individually priced by its host. These pin the sum — and
// especially the refusal to sum partially.

import { priceSegments, type PricingSegment } from "./benchmarkLedger";
import type { AttemptRate } from "./modelPricing";

const rate = (inp: number, out: number, basis: "provider_list" | "price_vector" = "provider_list", asOf: Date | null = null): AttemptRate =>
  ({ rates: { in: inp, out }, basis, asOf });

const seg = (model: string, prompt: number, completion: number, providerRefId: number | null = 1): PricingSegment =>
  ({ model, providerRefId, promptTokens: prompt, completionTokens: completion });

describe("priceSegments", () => {
  it("sums each model at its own rate, to the ledger's 8 decimals", async () => {
    // 1,000 prompt + 500 completion at 1.00/4.00 per 1K = 3.00
    // plus 1,000 prompt + 0 completion at 0.10/0.20 per 1K = 0.10
    const priced = await priceSegments(
      [seg("model-a", 1000, 500), seg("model-b", 1000, 0, 2)],
      async (_p, m) => (m === "model-a" ? rate(1, 4) : rate(0.1, 0.2)),
    );
    expect(priced?.estimatedCostUsd).toBe("3.1");
    expect(priced?.costBasis).toBe("provider_list");
  });

  it("says nothing when ONE segment cannot be priced, because a partial sum is not a total", async () => {
    const priced = await priceSegments(
      [seg("model-a", 1000, 500), seg("ghost-model", 1000, 500)],
      async (_p, m) => (m === "model-a" ? rate(1, 4) : null),
    );
    expect(priced).toBeNull();
  });

  it("treats a resolver that throws as unknown, never as zero", async () => {
    const priced = await priceSegments([seg("model-a", 1000, 500)], async () => {
      throw new Error("host unreachable");
    });
    expect(priced).toBeNull();
  });

  it("names a mixed source rather than picking one and misattributing it", async () => {
    const priced = await priceSegments(
      [seg("model-a", 1000, 0), seg("model-b", 1000, 0)],
      async (_p, m) => (m === "model-a"
        ? rate(1, 1, "provider_list", new Date("2026-09-20T00:00:00Z"))
        : rate(0.5, 0.5, "price_vector")),
    );
    expect(priced?.costBasis).toBe("mixed");
    expect(priced?.priceVectorVersion).toBeTruthy();
    // The oldest reading is the conservative thing to disclose.
    expect(priced?.costPricingAsOf?.toISOString()).toBe("2026-09-20T00:00:00.000Z");
  });

  it("prices a model served by two providers without inventing a route", async () => {
    const seen: Array<number | null> = [];
    await priceSegments(
      [seg("shared-model", 1000, 0, null)],
      async (p) => { seen.push(p); return rate(1, 1, "price_vector"); },
    );
    expect(seen).toEqual([null]);
  });

  it("returns nothing for an empty breakdown, so the single-route path still applies", async () => {
    expect(await priceSegments([], async () => rate(1, 1))).toBeNull();
  });
});
