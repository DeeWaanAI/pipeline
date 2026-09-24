import { getRedis } from "../infra/redis";
import { logger } from "./logger";

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitConfig {
  maxTokens: number;      // max requests in window
  refillRate: number;     // tokens per second
  windowMs: number;       // cleanup window
}

const DEFAULT_CONFIG: RateLimitConfig = {
  maxTokens: 60,
  refillRate: 1,          // 1 token per second = 60/min
  windowMs: 60_000,
};

// Periodic cleanup of stale buckets
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastRefill > 300_000) buckets.delete(key); // 5 min stale
  }
}, 60_000);

export function checkRateLimit(
  key: string,
  config: RateLimitConfig = DEFAULT_CONFIG
): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket) {
    bucket = { tokens: config.maxTokens, lastRefill: now };
    buckets.set(key, bucket);
  }

  // Refill tokens
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(config.maxTokens, bucket.tokens + elapsed * config.refillRate);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, retryAfterMs: 0 };
  }

  const retryAfterMs = Math.ceil((1 - bucket.tokens) / config.refillRate * 1000);
  return { allowed: false, retryAfterMs };
}

/**
 * Async rate limit backed by Redis when available.
 *
 * Enforces a FIXED WINDOW counter (redis key `rl:${key}:${windowIndex}`,
 * INCR + PEXPIRE) so the budget is shared across nodes. On any Redis error
 * or absence, falls back to the in-memory token bucket above — never throws.
 */
export async function checkRateLimitAsync(
  key: string,
  config: RateLimitConfig = DEFAULT_CONFIG
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  try {
    const redis = await getRedis();
    if (redis) {
      const now = Date.now();
      const windowIndex = Math.floor(now / config.windowMs);
      // Key embeds the window index → each window is a fresh, collision-free key.
      const redisKey = `rl:${key}:${windowIndex}`;
      const count = await redis.incr(redisKey);
      if (count === 1) {
        // First hit in this window — expire shortly after the window ends.
        await redis.pexpire(redisKey, config.windowMs + 1000);
      }
      if (count > config.maxTokens) {
        const windowElapsed = now - windowIndex * config.windowMs;
        return { allowed: false, retryAfterMs: Math.max(0, config.windowMs - windowElapsed) };
      }
      return { allowed: true, retryAfterMs: 0 };
    }
  } catch (err) {
    logger.warn("Rate limit: Redis path failed — using in-memory fallback", {
      key,
      error: (err as Error).message,
    });
  }
  return checkRateLimit(key, config);
}

// Predefined rate limit profiles
export const RATE_LIMITS = {
  auth: { maxTokens: 5, refillRate: 5 / 60, windowMs: 60_000 } as RateLimitConfig,       // 5/min
  execute: { maxTokens: 10, refillRate: 10 / 60, windowMs: 60_000 } as RateLimitConfig,  // 10/min
  batch: { maxTokens: 2, refillRate: 2 / 60, windowMs: 60_000 } as RateLimitConfig,      // 2 batch submissions/min
  read: { maxTokens: 100, refillRate: 100 / 60, windowMs: 60_000 } as RateLimitConfig,   // 100/min
  screenshotUpload: { maxTokens: 20, refillRate: 20 / 60, windowMs: 60_000 } as RateLimitConfig,   // 20/min per user
  screenshotServe: { maxTokens: 120, refillRate: 120 / 60, windowMs: 60_000 } as RateLimitConfig,  // 120/min per IP
};

// ═══════════════════════════════════════════════════════════════════
//  PER-CUSTOMER RATE-LIMIT TIERS (Phase 3)
// ═══════════════════════════════════════════════════════════════════
// Applied on the MCP surface. Distinct from the token-bucket checkRateLimit
// above, which is intentionally left untouched for its existing callers.
//
// Budgets are requests-per-minute enforced as a FIXED WINDOW counter
// (maxTokens doubles as the per-window cap):
//
//   solo  (default)          60 req/min  — everyone who is not an admin
//   admin (~10× solo)       600 req/min  — users.role = 'admin'
//
// A "team" tier used to sit between them and multiply the budget of anyone on a
// billed team. Teams were removed (ticket #26); the tier goes with them rather
// than lingering as an entitlement no product page offers.
export type CustomerTier = "solo" | "admin";

export const CUSTOMER_RATE_LIMITS: Record<CustomerTier, RateLimitConfig> = {
  solo: { maxTokens: 60, refillRate: 60 / 60, windowMs: 60_000 },
  admin: { maxTokens: 600, refillRate: 600 / 60, windowMs: 60_000 },
};

export interface CustomerRateLimitResult {
  allowed: boolean;
  retryAfterMs: number;   // ms until the current window resets (for Retry-After)
  limit: number;          // per-window cap for the resolved tier
  remaining: number;      // requests left in the current window
}

// In-memory fixed-window fallback (per-process). Used when Redis is absent or
// errors. Not shared across nodes — the documented trade-off of running
// without Redis (mirrors the app's broader graceful-degradation stance).
interface FixedWindow {
  count: number;
  windowIndex: number;
}
const customerWindows = new Map<string, FixedWindow>();

// Evict windows older than the previous minute so the map can't grow unbounded.
setInterval(() => {
  const current = Math.floor(Date.now() / 60_000);
  for (const [key, win] of customerWindows) {
    if (win.windowIndex < current - 1) customerWindows.delete(key);
  }
}, 60_000);

function memoryFixedWindow(key: string, config: RateLimitConfig): CustomerRateLimitResult {
  const now = Date.now();
  const windowIndex = Math.floor(now / config.windowMs);
  let win = customerWindows.get(key);
  if (!win || win.windowIndex !== windowIndex) {
    win = { count: 0, windowIndex };
    customerWindows.set(key, win);
  }
  win.count += 1;
  const windowElapsed = now - windowIndex * config.windowMs;
  const retryAfterMs = Math.max(0, config.windowMs - windowElapsed);
  const remaining = Math.max(0, config.maxTokens - win.count);
  if (win.count > config.maxTokens) {
    return { allowed: false, retryAfterMs, limit: config.maxTokens, remaining: 0 };
  }
  return { allowed: true, retryAfterMs: 0, limit: config.maxTokens, remaining };
}

async function redisFixedWindow(
  redis: NonNullable<Awaited<ReturnType<typeof getRedis>>>,
  key: string,
  config: RateLimitConfig,
): Promise<CustomerRateLimitResult> {
  const now = Date.now();
  const windowIndex = Math.floor(now / config.windowMs);
  // Key embeds the window index → each window is a fresh, collision-free key.
  const redisKey = `rlc:${key}:${windowIndex}`;
  const count = await redis.incr(redisKey);
  if (count === 1) {
    // First hit in this window — expire shortly after the window ends.
    await redis.pexpire(redisKey, config.windowMs + 1000);
  }
  const windowElapsed = now - windowIndex * config.windowMs;
  const retryAfterMs = Math.max(0, config.windowMs - windowElapsed);
  const remaining = Math.max(0, config.maxTokens - count);
  if (count > config.maxTokens) {
    return { allowed: false, retryAfterMs, limit: config.maxTokens, remaining: 0 };
  }
  return { allowed: true, retryAfterMs: 0, limit: config.maxTokens, remaining };
}

/**
 * Per-customer rate limit (Phase 3).
 *
 * Fixed-window counter backed by Redis (INCR + PEXPIRE) when available so the
 * budget is shared across nodes; transparent in-memory per-process fallback
 * otherwise. Never throws — a Redis failure degrades to the in-memory path.
 */
export async function checkCustomerRateLimit(
  key: string,
  tier: CustomerTier = "solo",
): Promise<CustomerRateLimitResult> {
  const config = CUSTOMER_RATE_LIMITS[tier] ?? CUSTOMER_RATE_LIMITS.solo;
  try {
    const redis = await getRedis();
    if (redis) {
      return await redisFixedWindow(redis, key, config);
    }
  } catch (err) {
    logger.warn("Customer rate limit: Redis path failed — using in-memory fallback", {
      key,
      error: (err as Error).message,
    });
  }
  return memoryFixedWindow(key, config);
}
