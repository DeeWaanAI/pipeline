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
