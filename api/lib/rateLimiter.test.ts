// Pure-function tests for the in-memory token-bucket rate limiter
// (checkRateLimit) and the static rate-limit profile maps.
// No DB/network: checkRateLimit never touches Redis — the Redis path only
// exists in checkCustomerRateLimit, which is intentionally NOT exercised
// here (it depends on deployment env).

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  checkRateLimit,
  checkRateLimitAsync,
  RATE_LIMITS,
  CUSTOMER_RATE_LIMITS,
  type RateLimitConfig,
} from "./rateLimiter";

const BURST: RateLimitConfig = { maxTokens: 3, refillRate: 1, windowMs: 60_000 };

afterEach(() => {
  vi.useRealTimers();
});

describe("checkRateLimit (token bucket)", () => {
  it("allows a burst up to maxTokens, then denies with a retry hint", () => {
    vi.useFakeTimers();
    const key = "rl-test-burst";
    expect(checkRateLimit(key, BURST)).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(checkRateLimit(key, BURST)).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(checkRateLimit(key, BURST)).toEqual({ allowed: true, retryAfterMs: 0 });

    const denied = checkRateLimit(key, BURST);
    expect(denied.allowed).toBe(false);
    // Bucket is empty; refillRate 1/s → 1s until the next token.
    expect(denied.retryAfterMs).toBe(1000);
  });

  it("refills tokens over time", () => {
    vi.useFakeTimers();
    const key = "rl-test-refill";
    for (let i = 0; i < 3; i++) checkRateLimit(key, BURST);
    expect(checkRateLimit(key, BURST).allowed).toBe(false);

    vi.advanceTimersByTime(1500); // ~1.5 tokens refilled
    expect(checkRateLimit(key, BURST).allowed).toBe(true);
    expect(checkRateLimit(key, BURST).allowed).toBe(false); // only ~0.5 left
  });

  it("caps the bucket at maxTokens after a long idle window", () => {
    vi.useFakeTimers();
    const key = "rl-test-cap";
    checkRateLimit(key, BURST); // create + consume → 2 left
    vi.advanceTimersByTime(10 * 60_000); // way past the window
    // Full burst available again — exactly maxTokens, not more.
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit(key, BURST).allowed).toBe(true);
    }
    expect(checkRateLimit(key, BURST).allowed).toBe(false);
  });

  it("tracks keys independently", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 3; i++) checkRateLimit("rl-test-keyA", BURST);
    expect(checkRateLimit("rl-test-keyA", BURST).allowed).toBe(false);
    expect(checkRateLimit("rl-test-keyB", BURST).allowed).toBe(true);
  });
});

describe("RATE_LIMITS profiles", () => {
  it("auth is the strictest profile (5/min)", () => {
    expect(RATE_LIMITS.auth.maxTokens).toBe(5);
    expect(RATE_LIMITS.auth.windowMs).toBe(60_000);
  });

  it("orders auth < execute < read by budget", () => {
    expect(RATE_LIMITS.auth.maxTokens).toBeLessThan(RATE_LIMITS.execute.maxTokens);
    expect(RATE_LIMITS.execute.maxTokens).toBeLessThan(RATE_LIMITS.read.maxTokens);
  });

  it("screenshotUpload is 20/min per user (spec 0.9d)", () => {
    expect(RATE_LIMITS.screenshotUpload).toEqual({
      maxTokens: 20,
      refillRate: 20 / 60,
      windowMs: 60_000,
    });
  });

  it("screenshotServe is 120/min per IP (spec 0.9d)", () => {
    expect(RATE_LIMITS.screenshotServe).toEqual({
      maxTokens: 120,
      refillRate: 120 / 60,
      windowMs: 60_000,
    });
  });
});

describe("CUSTOMER_RATE_LIMITS (per-customer tiers)", () => {
  it("team ≈ 4× solo and admin = 10× solo", () => {
    expect(CUSTOMER_RATE_LIMITS.solo.maxTokens).toBe(60);
    expect(CUSTOMER_RATE_LIMITS.team.maxTokens).toBe(240);
    expect(CUSTOMER_RATE_LIMITS.admin.maxTokens).toBe(600);
    expect(CUSTOMER_RATE_LIMITS.team.maxTokens).toBe(4 * CUSTOMER_RATE_LIMITS.solo.maxTokens);
    expect(CUSTOMER_RATE_LIMITS.admin.maxTokens).toBe(10 * CUSTOMER_RATE_LIMITS.solo.maxTokens);
  });

  it("all tiers use a one-minute fixed window", () => {
    for (const cfg of Object.values(CUSTOMER_RATE_LIMITS)) {
      expect(cfg.windowMs).toBe(60_000);
    }
  });
});

describe("checkRateLimitAsync (no-Redis fallback)", () => {
  // The test env has no Redis (REDIS_URL unset → getRedis() resolves null),
  // so every call degrades to the in-memory token bucket and must behave
  // exactly like checkRateLimit. No fake timers needed: burst denial happens
  // on immediate sequential calls without advancing the clock.

  it("allows a burst up to maxTokens, then denies with retryAfterMs > 0", async () => {
    const key = "rl-async-burst";
    expect(await checkRateLimitAsync(key, BURST)).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(await checkRateLimitAsync(key, BURST)).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(await checkRateLimitAsync(key, BURST)).toEqual({ allowed: true, retryAfterMs: 0 });

    const denied = await checkRateLimitAsync(key, BURST);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it("tracks keys independently through the fallback path", async () => {
    for (let i = 0; i < 3; i++) await checkRateLimitAsync("rl-async-keyA", BURST);
    expect((await checkRateLimitAsync("rl-async-keyA", BURST)).allowed).toBe(false);
    expect((await checkRateLimitAsync("rl-async-keyB", BURST)).allowed).toBe(true);
  });

  it("never throws when Redis is absent (resolves, not rejects)", async () => {
    await expect(checkRateLimitAsync("rl-async-never-throws", BURST)).resolves.toEqual({
      allowed: true,
      retryAfterMs: 0,
    });
  });
});
