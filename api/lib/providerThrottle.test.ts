// Unit tests for the AIMD provider throttle.
// Mocks Redis away (null) so the module falls back to in-memory state.
//
// These tests pin the arithmetic against the module's documented configuration,
// so they are written against the literals below rather than against a rate
// read back from the module (it exports no config accessor). That is deliberate:
// changing `DEFAULT_CONFIG` in `providerThrottle.ts` MUST be a considered
// decision here too, which is exactly the change that silently broke this file
// once — the defaults went 30→600 init and 6→60 floor and every exact-number
// expectation below became false while the module kept passing for the wrong
// reason.

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

/** Mirror of `DEFAULT_CONFIG` in the module under test. */
const INIT_RPM = 600;
const FLOOR_RPM = 60;
const CEILING_RPM = 2000;
/** `COOLDOWN_WINDOWS`: no additive increase until this many windows have passed
 *  since the last multiplicative decrease. */
const COOLDOWN_WINDOWS = 2;

const WINDOW_MS = 60_000;
/** The module's additive step: `max(10, 5%)`, and the slow-start step: doubling. */
const additiveStep = (rpm: number) => Math.max(10, Math.round(rpm * 0.05));

/** Advance past the end of the current window and take one slot, which is what
 *  rolls the window and applies the increase rules. */
async function rollCleanWindow(slug: string) {
  vi.advanceTimersByTime(WINDOW_MS + 1);
  await acquireProviderSlot(slug);
}

async function rpmOf(slug: string): Promise<number> {
  return (await getProviderThrottleMetrics())[slug]!.currentRpm;
}

beforeEach(() => {
  vi.useRealTimers();
  resetThrottleStateForTests();
});

describe("acquireProviderSlot", () => {
  it("starts at the configured initial rate, optimistic rather than cautious", async () => {
    await acquireProviderSlot("test-provider");
    const metrics = await getProviderThrottleMetrics();
    expect(metrics["test-provider"].currentRpm).toBe(INIT_RPM);
    expect(metrics["test-provider"].inSlowStart).toBe(true);
  });

  it("throttles exactly when the prorated window budget runs out", async () => {
    vi.useFakeTimers();
    const slug = "test-throttle";

    // At t=0 the elapsed-time proration allows a single slot, so the second
    // call inside the same instant is already blocked.
    expect((await acquireProviderSlot(slug)).ok).toBe(true);
    expect((await acquireProviderSlot(slug)).ok).toBe(false);

    // Half way through the window the budget is half the rate; the one slot
    // already taken leaves the rest available, and the next is refused.
    vi.advanceTimersByTime(30_000);
    const budget = Math.max(1, Math.floor(INIT_RPM * 30_000 / WINDOW_MS));
    for (let i = 0; i < budget - 1; i++) {
      expect((await acquireProviderSlot(slug)).ok).toBe(true);
    }
    const blocked = await acquireProviderSlot(slug);
    expect(blocked.ok).toBe(false);
    expect((blocked as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
  });

  it("doubles the rate in slow start after a clean window", async () => {
    vi.useFakeTimers();
    const slug = "test-slowstart";

    await acquireProviderSlot(slug);
    expect(await rpmOf(slug)).toBe(INIT_RPM);

    await rollCleanWindow(slug);
    expect(await rpmOf(slug)).toBe(INIT_RPM * 2);
  });

  it("caps slow start at the configured ceiling instead of doubling forever", async () => {
    vi.useFakeTimers();
    const slug = "test-ceiling";

    await acquireProviderSlot(slug);
    // 600 → 1200 → 2000, and every further clean window stays at the ceiling.
    await rollCleanWindow(slug);
    await rollCleanWindow(slug);
    expect(await rpmOf(slug)).toBe(CEILING_RPM);
    await rollCleanWindow(slug);
    await rollCleanWindow(slug);
    expect(await rpmOf(slug)).toBe(CEILING_RPM);
  });

  it("honors declaredRpm by starting at 80% and skipping slow start", async () => {
    vi.useFakeTimers();
    const slug = "test-declared";

    await acquireProviderSlot(slug, 500);
    expect(await rpmOf(slug)).toBe(400);
    expect((await getProviderThrottleMetrics())[slug]!.inSlowStart).toBe(false);
  });

  it("never starts a declared rate below the usable floor", async () => {
    vi.useFakeTimers();
    const slug = "test-declared-floor";

    await acquireProviderSlot(slug, 10);
    expect(await rpmOf(slug)).toBe(FLOOR_RPM);
  });
});

describe("reportProviderResult", () => {
  it("halves the rate on rate_limited (multiplicative decrease)", async () => {
    vi.useFakeTimers();
    const slug = "test-decrease";

    await acquireProviderSlot(slug);
    await rollCleanWindow(slug);
    expect(await rpmOf(slug)).toBe(INIT_RPM * 2);

    await reportProviderResult(slug, "rate_limited");
    expect(await rpmOf(slug)).toBe(INIT_RPM);
    expect((await getProviderThrottleMetrics())[slug]!.inSlowStart).toBe(false);
  });

  it("stops decreasing at the floor rather than collapsing", async () => {
    vi.useFakeTimers();
    const slug = "test-floor";

    await acquireProviderSlot(slug, 100);
    await reportProviderResult(slug, "rate_limited");
    await reportProviderResult(slug, "rate_limited");
    await reportProviderResult(slug, "rate_limited");
    expect(await rpmOf(slug)).toBe(FLOOR_RPM);
  });

  it("holds through the cooldown window, then increases additively", async () => {
    vi.useFakeTimers();
    const slug = "test-cooldown";

    await acquireProviderSlot(slug);
    await rollCleanWindow(slug);           // slow start: 600 → 1200
    await reportProviderResult(slug, "rate_limited"); // → 600, decrease clock starts
    expect(await rpmOf(slug)).toBe(INIT_RPM);

    // The first clean window after a decrease is a hold, not an increase.
    await rollCleanWindow(slug);
    expect(await rpmOf(slug)).toBe(INIT_RPM);

    // Only once the cooldown has passed does the additive step apply.
    vi.advanceTimersByTime((COOLDOWN_WINDOWS - 1) * WINDOW_MS + 1);
    await acquireProviderSlot(slug);
    expect(await rpmOf(slug)).toBe(INIT_RPM + additiveStep(INIT_RPM));
  });

  it("honors Retry-After by pausing new slots", async () => {
    vi.useFakeTimers();
    const slug = "test-retry-after";

    await acquireProviderSlot(slug);
    await reportProviderResult(slug, "rate_limited", 30_000);

    const blocked = await acquireProviderSlot(slug);
    expect(blocked.ok).toBe(false);
    expect((blocked as { retryAfterMs: number }).retryAfterMs)
      .toBeGreaterThanOrEqual(30_000 - 100);
  });

  it("does not change the rate on 'ok' — increase happens at the window boundary only", async () => {
    vi.useFakeTimers();
    const slug = "test-ok";

    await acquireProviderSlot(slug);
    const before = await rpmOf(slug);
    await reportProviderResult(slug, "ok");
    expect(await rpmOf(slug)).toBe(before);
  });
});

describe("getProviderThrottleMetrics", () => {
  it("returns empty object when no state exists", async () => {
    expect(Object.keys(await getProviderThrottleMetrics())).toHaveLength(0);
  });

  it("returns state for providers that have been touched", async () => {
    await acquireProviderSlot("prov-a");
    await acquireProviderSlot("prov-b");

    const metrics = await getProviderThrottleMetrics();
    expect(metrics["prov-a"]?.currentRpm).toBe(INIT_RPM);
    expect(metrics["prov-b"]?.currentRpm).toBe(INIT_RPM);
  });
});
