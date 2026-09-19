// Unit tests for the AIMD provider throttle.
// Mocks Redis away (null) so the module falls back to in-memory state.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  acquireProviderSlot,
  reportProviderResult,
  getProviderThrottleMetrics,
  resetThrottleStateForTests,
} from "./providerThrottle";

// Mock Redis away so we exercise the in-memory path exclusively
vi.mock("../infra/redis", () => ({
  getRedis: vi.fn().mockResolvedValue(null),
}));

const WINDOW_MS = 60_000;

beforeEach(() => {
  vi.useRealTimers();
  resetThrottleStateForTests();
});

describe("acquireProviderSlot", () => {
  it("allows the first slot in a fresh window", async () => {
    const result = await acquireProviderSlot("test-provider");
    expect(result.ok).toBe(true);
  });

  it("throttles when prorated limit is exceeded within a window", async () => {
    vi.useFakeTimers();
    const slug = "test-throttle";

    // First call at t=0 uses slot 1 of prorated limit 1
    expect((await acquireProviderSlot(slug)).ok).toBe(true);

    // At t=30s in a 60s window, prorated limit = initRpm * 30/60 = 30 * 0.5 = 15
    // We have already used 1 slot, so 14 more are allowed (total 15)
    vi.advanceTimersByTime(30_000);
    for (let i = 0; i < 14; i++) {
      expect((await acquireProviderSlot(slug)).ok).toBe(true);
    }

    // 16th slot overall should be throttled
    const blocked = await acquireProviderSlot(slug);
    expect(blocked.ok).toBe(false);
    expect((blocked as any).retryAfterMs).toBeGreaterThan(0);
  });

  it("doubles RPM in slow start after each clean window", async () => {
    vi.useFakeTimers();
    const slug = "test-slowstart";

    // Establish baseline
    await acquireProviderSlot(slug);
    let metrics = await getProviderThrottleMetrics();
    const initRpm = metrics[slug].currentRpm;

    // Clean window 1 → should double
    vi.advanceTimersByTime(WINDOW_MS + 1);
    await acquireProviderSlot(slug);
    metrics = await getProviderThrottleMetrics();
    expect(metrics[slug].currentRpm).toBe(initRpm * 2);

    // Clean window 2 → should double again
    vi.advanceTimersByTime(WINDOW_MS + 1);
    await acquireProviderSlot(slug);
    metrics = await getProviderThrottleMetrics();
    expect(metrics[slug].currentRpm).toBe(initRpm * 4);
  });

  it("reaches ≥90 RPM within 8 clean windows from init 30", async () => {
    vi.useFakeTimers();
    const slug = "test-ramp";

    // Trigger initial state creation
    await acquireProviderSlot(slug);

    // Let 8 windows pass — each triggers slow-start doubling
    for (let w = 0; w < 8; w++) {
      vi.advanceTimersByTime(WINDOW_MS + 1);
      // Trigger window roll by acquiring one slot
      await acquireProviderSlot(slug);
    }

    // After 8 doublings: 30 → 60 → 120 → 240 → 480 → 960 → 1920 → 2000 (ceiling)
    const metrics = await getProviderThrottleMetrics();
    expect(metrics[slug]?.currentRpm).toBeGreaterThanOrEqual(90);
  });

  it("honors declaredRpm by starting at 80% and skipping slow start", async () => {
    vi.useFakeTimers();
    const slug = "test-declared";
    const declaredRpm = 500;

    // First slot should set state with declaredRpm
    await acquireProviderSlot(slug, declaredRpm);

    const metrics = await getProviderThrottleMetrics();
    expect(metrics[slug]?.currentRpm).toBe(400); // 500 * 0.8
    expect(metrics[slug]?.inSlowStart).toBe(false);
  });
});

describe("reportProviderResult", () => {
  it("halves RPM on rate_limited (multiplicative decrease)", async () => {
    vi.useFakeTimers();
    const slug = "test-decrease";

    // Ramp to 120 via slow start
    await acquireProviderSlot(slug);
    vi.advanceTimersByTime(WINDOW_MS + 1);
    await acquireProviderSlot(slug);
    vi.advanceTimersByTime(WINDOW_MS + 1);
    await acquireProviderSlot(slug);

    let metrics = await getProviderThrottleMetrics();
    expect(metrics[slug].currentRpm).toBe(120);

    await reportProviderResult(slug, "rate_limited");

    metrics = await getProviderThrottleMetrics();
    expect(metrics[slug].currentRpm).toBe(60); // 120 * 0.5
    expect(metrics[slug].inSlowStart).toBe(false);
  });

  it("honors Retry-After by pausing new slots", async () => {
    vi.useFakeTimers();
    const slug = "test-retry-after";

    await acquireProviderSlot(slug);
    await reportProviderResult(slug, "rate_limited", 30_000);

    // Immediately after report, slot should be throttled because windowStart was pushed forward
    const blocked = await acquireProviderSlot(slug);
    expect(blocked.ok).toBe(false);
    expect((blocked as any).retryAfterMs).toBeGreaterThanOrEqual(30_000 - 100); // allow small timing jitter
  });

  it("converges in the 25–50 band when mocked 429s appear above 50 RPM", async () => {
    vi.useFakeTimers();
    const slug = "test-converge";

    // Establish a steady state at 100 RPM
    await acquireProviderSlot(slug);
    vi.advanceTimersByTime(WINDOW_MS + 1);
    await acquireProviderSlot(slug);
    vi.advanceTimersByTime(WINDOW_MS + 1);
    await acquireProviderSlot(slug);

    let metrics = await getProviderThrottleMetrics();
    expect(metrics[slug].currentRpm).toBe(120);

    // Report rate-limited → 60
    await reportProviderResult(slug, "rate_limited");
    metrics = await getProviderThrottleMetrics();
    expect(metrics[slug].currentRpm).toBe(60);

    // One clean window → additive increase (+ max(10, 5%) = +10) = 70
    vi.advanceTimersByTime(WINDOW_MS + 1);
    await acquireProviderSlot(slug);

    // Report rate-limited again → 30
    await reportProviderResult(slug, "rate_limited");
    metrics = await getProviderThrottleMetrics();
    expect(metrics[slug].currentRpm).toBe(30);

    // Should be in 25–50 band
    expect(metrics[slug].currentRpm).toBeGreaterThanOrEqual(25);
    expect(metrics[slug].currentRpm).toBeLessThanOrEqual(50);
  });

  it("does not change RPM on 'ok' — increase happens at window boundary only", async () => {
    vi.useFakeTimers();
    const slug = "test-ok";

    await acquireProviderSlot(slug);
    const before = (await getProviderThrottleMetrics())[slug].currentRpm;

    await reportProviderResult(slug, "ok");
    const after = (await getProviderThrottleMetrics())[slug].currentRpm;

    expect(after).toBe(before);
  });
});

describe("getProviderThrottleMetrics", () => {
  it("returns empty object when no state exists", async () => {
    const metrics = await getProviderThrottleMetrics();
    expect(Object.keys(metrics)).toHaveLength(0);
  });

  it("returns state for providers that have been touched", async () => {
    await acquireProviderSlot("prov-a");
    await acquireProviderSlot("prov-b");

    const metrics = await getProviderThrottleMetrics();
    expect(metrics["prov-a"]).toBeDefined();
    expect(metrics["prov-b"]).toBeDefined();
    expect(metrics["prov-a"].currentRpm).toBeGreaterThan(0);
  });
});
