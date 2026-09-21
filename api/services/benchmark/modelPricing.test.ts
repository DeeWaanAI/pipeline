// Pure pricing-resolution tests: no DB, no network. The provider fetch is
// covered by the live path in modelPricing; what must not regress is the
// unit conversion, the fallback order, and "unknown is never zero".

import { afterEach, describe, expect, it } from "vitest";
import { toModelRates } from "../../lib/providers/openai";
import { resolveModelPricing } from "./modelPricing";

const originalVector = process.env.V2_PRICE_VECTOR_JSON;
afterEach(() => {
  if (originalVector === undefined) delete process.env.V2_PRICE_VECTOR_JSON;
  else process.env.V2_PRICE_VECTOR_JSON = originalVector;
});

describe("provider list-price conversion", () => {
  it("converts per-1M-token rates to the per-1K unit the ledger uses", () => {
    const rates = toModelRates({ input: 1.04, output: 4.4 });
    expect(rates?.in).toBeCloseTo(0.00104, 9);
    expect(rates?.out).toBeCloseTo(0.0044, 9);
  });

  it("returns nothing rather than a zero price when the host omits rates", () => {
    expect(toModelRates(undefined)).toBeNull();
    expect(toModelRates({ input: 0.3 })).toBeNull();
    expect(toModelRates({ input: "0", output: "1.2" })).toBeNull();
    expect(toModelRates({ input: "abc", output: "1.2" })).toBeNull();
  });
});

describe("quote pricing sources", () => {
  it("uses the maintained vector when no host rates are available, and labels it", async () => {
    process.env.V2_PRICE_VECTOR_JSON = JSON.stringify({ "model-a": { in: 0.01, out: 0.03 } });
    const pricing = await resolveModelPricing({ providerIds: [], models: ["model-a", "model-b"] });
    expect(pricing.basis).toBe("price_vector");
    expect(pricing.rates["model-a"]).toEqual({ in: 0.01, out: 0.03 });
    expect(pricing.missing).toEqual(["model-b"]);
    expect(pricing.rates["model-b"]).toBeUndefined();
  });

  it("reports unknown, not zero, when nothing can be retrieved", async () => {
    delete process.env.V2_PRICE_VECTOR_JSON;
    const pricing = await resolveModelPricing({ providerIds: [], models: ["model-x"] });
    expect(pricing.basis).toBe("unknown");
    expect(pricing.rates).toEqual({});
    expect(pricing.missing).toEqual(["model-x"]);
  });
});
