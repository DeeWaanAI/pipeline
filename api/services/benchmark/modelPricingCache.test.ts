// The retrieval CACHE, not the arithmetic (that is modelPricing.test.ts).
//
// Why this exists: an unreachable or slow host was cached as an empty result
// for the same ten minutes as a good one, so one timeout made the ledger report
// `unknown` for a model it had priced minutes earlier, and a quote taken inside
// that window could only ever say the cost was unretrievable. The local database
// shows the symptom: the same (provider, model) pair priced `provider_list` on
// six `call_attempts` rows and `NULL` on thirteen.

import { beforeEach, describe, expect, it, vi } from "vitest";

const listPricing = vi.fn();

vi.mock("../../queries/connection", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            return [{
              id: 7, slug: "openai", apiKeyRef: "ciphertext",
              baseUrl: "https://prices.test/v1", defaultModel: "cache-test-model",
            }];
          },
        }),
      }),
    }),
  }),
}));

vi.mock("../../lib/providers", () => ({
  createProviderAdapter: () => ({ listPricing }),
}));

vi.mock("../cryptoService", () => ({
  decrypt: () => "key", getMasterKey: () => "key",
}));

const { PRICING_MISS_TTL_MS, resetPricingCache, resolveModelPricing } = await import("./modelPricing");

const RATES = { "cache-test-model": { in: 0.001, out: 0.004 } };

beforeEach(() => {
  vi.useFakeTimers();
  process.env.V2_PRICE_VECTOR_JSON = "{}";
  listPricing.mockReset();
  resetPricingCache();
});

async function quote() {
  return resolveModelPricing({ providerIds: [7], models: ["cache-test-model"] });
}

describe("pricing retrieval cache", () => {
  it("retries a retrieval that failed, instead of remembering the failure for ten minutes", async () => {
    listPricing.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect((await quote()).basis).toBe("unknown");
    expect(listPricing).toHaveBeenCalledTimes(1);

    // Immediately after, the miss is still remembered — a burst of calls must
    // not turn one dead host into one request each.
    expect((await quote()).basis).toBe("unknown");
    expect(listPricing).toHaveBeenCalledTimes(1);

    // Once the short miss TTL has passed the next caller tries the host again,
    // and a host that has come back prices the very model it "could not" before.
    vi.advanceTimersByTime(PRICING_MISS_TTL_MS + 1);
    listPricing.mockResolvedValue(RATES);
    const recovered = await quote();
    expect(listPricing).toHaveBeenCalledTimes(2);
    expect(recovered.basis).toBe("provider_list");
    expect(recovered.rates["cache-test-model"]).toEqual(RATES["cache-test-model"]);
  });

  it("keeps a good retrieval for the full quote TTL so the host is not hammered", async () => {
    listPricing.mockResolvedValue(RATES);
    expect((await quote()).basis).toBe("provider_list");
    expect((await quote()).basis).toBe("provider_list");
    expect(listPricing).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10 * 60_000 + 1);
    expect((await quote()).basis).toBe("provider_list");
    expect(listPricing).toHaveBeenCalledTimes(2);
  });

  it("clears the timeout guard once the call has resolved", async () => {
    listPricing.mockResolvedValue(RATES);
    expect((await quote()).basis).toBe("provider_list");
    // The guard timer is created per call; leaving it scheduled would keep an
    // already-answered request on the event loop for its full eight seconds.
    expect(vi.getTimerCount()).toBe(0);
  });
});
