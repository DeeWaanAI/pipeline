// Pure pricing-resolution tests: no DB, no network. The provider fetch is
// covered by the live path in modelPricing; what must not regress is the
// unit conversion, the fallback order, and "unknown is never zero".

import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAIAdapter, toModelRates } from "../../lib/providers/openai";
import { createAnthropicAdapter } from "../../lib/providers/anthropic";
import { rateForAttempt, resolveModelPricing } from "./modelPricing";
import { singleRouteOfSnapshot } from "./versionService";
import type { SnapshotStep, VersionDefinition } from "./benchmarkTypes";

const originalVector = process.env.V2_PRICE_VECTOR_JSON;
afterEach(() => {
  vi.unstubAllGlobals();
  if (originalVector === undefined) delete process.env.V2_PRICE_VECTOR_JSON;
  else process.env.V2_PRICE_VECTOR_JSON = originalVector;
});

describe.each(["openai", "anthropic"] as const)("%s usage provenance", (provider) => {
  it.each([
    { label: "absent", prompt: undefined, completion: undefined, complete: false },
    { label: "partial input", prompt: 12, completion: undefined, complete: false },
    { label: "partial output", prompt: undefined, completion: 8, complete: false },
    { label: "null", prompt: null, completion: null, complete: false },
    { label: "string", prompt: "12", completion: 8, complete: false },
    { label: "negative", prompt: -1, completion: 8, complete: false },
    { label: "fractional", prompt: 1.5, completion: 8, complete: false },
    { label: "measured zero", prompt: 0, completion: 0, complete: true },
    { label: "measured usage", prompt: 12, completion: 8, complete: true },
  ])("distinguishes $label from measured zero", async ({ prompt, completion, complete }) => {
    const usage = provider === "openai"
      ? { prompt_tokens: prompt, completion_tokens: completion }
      : { input_tokens: prompt, output_tokens: completion };
    const body = { model: "test-model", choices: [{ message: { content: "answer" } }], content: [{ type: "text", text: "answer" }], usage };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const adapter = provider === "openai"
      ? createOpenAIAdapter("fixture-key", "https://provider.test/v1", "test-model")
      : createAnthropicAdapter("fixture-key", "https://provider.test/v1", "test-model");
    const response = await adapter.chat([{ role: "user", content: "test" }]);
    expect(response.usage).toMatchObject({ complete });
    expect(Number.isFinite(response.usage.promptTokens)).toBe(true);
    expect(response.usage.promptTokens).toBeGreaterThanOrEqual(0);
    if (complete) expect(response.usage.totalTokens).toBe(Number(prompt) + Number(completion));
    expect(fetch).toHaveBeenCalledOnce();
  });
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

describe("per-attempt pricing (migration 028)", () => {
  it("resolves an attempt's rate from the same sources, in the same order, as the quote", async () => {
    process.env.V2_PRICE_VECTOR_JSON = JSON.stringify({ "model-a": { in: 0.01, out: 0.03 } });
    const rate = await rateForAttempt(null, "MODEL-A");
    expect(rate?.basis).toBe("price_vector");
    expect(rate?.rates).toEqual({ in: 0.01, out: 0.03 });
    // The vector is a versioned artifact, not a momentary reading.
    expect(rate?.asOf).toBeNull();
  });

  it("returns null for a model no source knows, so the ledger writes UNKNOWN rather than 0", async () => {
    process.env.V2_PRICE_VECTOR_JSON = JSON.stringify({ "model-a": { in: 0.01, out: 0.03 } });
    expect(await rateForAttempt(null, "model-missing")).toBeNull();
    expect(await rateForAttempt(null, "   ")).toBeNull();
    expect(await rateForAttempt(null, null)).toBeNull();
  });
});

describe("which aggregate generation row may be priced at all", () => {
  const step = (over: Partial<SnapshotStep> & { stepOrder: number }): SnapshotStep => ({
    name: `s${over.stepOrder}`, role: "builder", systemPrompt: "", stepType: "agent",
    providerId: 7, model: "m", temperature: "0.7", maxTokens: 1024, ifConfig: null, whileConfig: null,
    ...over,
  });
  const def = (steps: SnapshotStep[]): VersionDefinition => ({ schemaVersion: 1, steps, pipelineConfig: null, sourceAgentIds: [] });

  it("prices a child whose every call used one provider and one model", () => {
    expect(singleRouteOfSnapshot(def([step({ stepOrder: 1 }), step({ stepOrder: 2 })])))
      .toEqual({ providerRefId: 7, model: "m" });
  });

  it("refuses to average across models, providers or an unnamed default", () => {
    expect(singleRouteOfSnapshot(def([step({ stepOrder: 1 }), step({ stepOrder: 2, model: "other" })]))).toBeNull();
    expect(singleRouteOfSnapshot(def([step({ stepOrder: 1 }), step({ stepOrder: 2, providerId: 8 })]))).toBeNull();
    expect(singleRouteOfSnapshot(def([step({ stepOrder: 1 }), step({ stepOrder: 2, model: null })]))).toBeNull();
    expect(singleRouteOfSnapshot(def([step({ stepOrder: 1 }), step({ stepOrder: 2, providerId: null })]))).toBeNull();
    // A gate assesses through the model too, so it counts as a call.
    expect(singleRouteOfSnapshot(def([step({ stepOrder: 1 }), step({ stepOrder: 2, stepType: "if" })]))).not.toBeNull();
    // Approval makes no call, so it cannot break the route.
    expect(singleRouteOfSnapshot(def([step({ stepOrder: 1 }), step({ stepOrder: 2, stepType: "approval", model: "different" })]))).not.toBeNull();
    expect(singleRouteOfSnapshot(def([]))).toBeNull();
  });
});
