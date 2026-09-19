/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PROVIDER THROTTLE — AIMD (Additive-Increase / Multiplicative-Decrease)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Discovers each provider's sustainable RPM using TCP-congestion-control-style
 * AIMD. Per-provider state is stored in Redis (hash) with in-memory fallback.
 *
 * Grounding: Jacobson 1988 (TCP congestion control); Chiu & Jain 1989
 * (AIMD converges to fair, efficient allocation).
 */

import { getRedis } from "../infra/redis";
import { logger } from "./logger";
import { env } from "./env";

interface ProviderState {
  currentRpm: number;
  windowStart: number;   // timestamp of current 60s window
  windowCount: number;   // slots used in current window
  lastDecrease: number;  // timestamp of last multiplicative decrease
  inSlowStart: boolean;
}

interface ThrottleConfig {
  initRpm: number;
  floorRpm: number;
  ceilingRpm: number;
}

const DEFAULT_CONFIG: ThrottleConfig = {
  initRpm: 600,   // was 30 — start optimistic; 429s are the discovery signal
  floorRpm: 60,   // was 6 — never collapse below a usable floor
  ceilingRpm: 2000,
};

// In-memory fallback state (when Redis unavailable)
const memoryState = new Map<string, ProviderState>();

/** Reset in-memory throttle state (for tests only). */
export function resetThrottleStateForTests(): void {
  memoryState.clear();
}

// Parse per-provider env config
function parseEnvConfig(): Map<string, ThrottleConfig> {
  const map = new Map<string, ThrottleConfig>();
  map.set("*", { ...DEFAULT_CONFIG });
  if (!env.providerThrottle) return map;
  try {
    const parsed = JSON.parse(env.providerThrottle);
    for (const [slug, cfg] of Object.entries(parsed)) {
      const c = cfg as Record<string, number>;
      map.set(slug, {
        initRpm: c.init ?? DEFAULT_CONFIG.initRpm,
        floorRpm: c.floor ?? DEFAULT_CONFIG.floorRpm,
        ceilingRpm: c.ceiling ?? DEFAULT_CONFIG.ceilingRpm,
      });
    }
  } catch {
    logger.warn("[providerThrottle] Failed to parse PROVIDER_THROTTLE env");
  }
  return map;
}

const envConfig = parseEnvConfig();

function getConfig(slug: string): ThrottleConfig {
  return envConfig.get(slug) ?? envConfig.get("*") ?? DEFAULT_CONFIG;
}

function makeInitialState(declaredRpm?: number): ProviderState {
  const cfg = getConfig("*");
  const init = declaredRpm ? Math.round(declaredRpm * 0.8) : cfg.initRpm;
  return {
    currentRpm: Math.max(cfg.floorRpm, Math.min(init, cfg.ceilingRpm)),
    windowStart: Date.now(),
    windowCount: 0,
    lastDecrease: 0,
    inSlowStart: !declaredRpm, // skip slow start if user declared a rate
  };
}

const REDIS_KEY_PREFIX = "provider-throttle:";
const WINDOW_MS = 60_000;
const COOLDOWN_WINDOWS = 2; // no increase for 2 windows after a decrease

async function loadState(slug: string, declaredRpm?: number): Promise<ProviderState> {
  // Try Redis first
  const redis = await getRedis();
  if (redis) {
    try {
      const raw = await redis.hgetall(`${REDIS_KEY_PREFIX}${slug}`);
      if (raw && Object.keys(raw).length > 0) {
        return {
          currentRpm: parseInt(raw.currentRpm, 10) || getConfig(slug).initRpm,
          windowStart: parseInt(raw.windowStart, 10) || Date.now(),
          windowCount: parseInt(raw.windowCount, 10) || 0,
          lastDecrease: parseInt(raw.lastDecrease, 10) || 0,
          inSlowStart: raw.inSlowStart === "1",
        };
      }
    } catch {
      // fall through to memory
    }
  }
  // Memory fallback
  const mem = memoryState.get(slug);
  if (mem) return mem;
  // Fresh state
  const fresh = makeInitialState(declaredRpm);
  await saveState(slug, fresh);
  return fresh;
}

async function saveState(slug: string, state: ProviderState): Promise<void> {
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.hmset(`${REDIS_KEY_PREFIX}${slug}`, {
        currentRpm: String(state.currentRpm),
        windowStart: String(state.windowStart),
        windowCount: String(state.windowCount),
        lastDecrease: String(state.lastDecrease),
        inSlowStart: state.inSlowStart ? "1" : "0",
      });
      return;
    } catch {
      // fall through to memory
    }
  }
  memoryState.set(slug, state);
}

/** Advance to a new window and apply AIMD increase rules. */
function advanceWindow(slug: string, state: ProviderState): ProviderState {
  const now = Date.now();
  const cfg = getConfig(slug);
  const windowsSinceDecrease = Math.floor((now - state.lastDecrease) / WINDOW_MS);

  let nextRpm = state.currentRpm;

  if (state.inSlowStart) {
    // Slow start: double each clean window
    nextRpm = Math.min(cfg.ceilingRpm, state.currentRpm * 2);
    if (nextRpm >= cfg.ceilingRpm) {
      nextRpm = cfg.ceilingRpm;
    }
  } else if (windowsSinceDecrease >= COOLDOWN_WINDOWS) {
    // Congestion avoidance: additive increase
    const add = Math.max(10, Math.round(state.currentRpm * 0.05));
    nextRpm = Math.min(cfg.ceilingRpm, state.currentRpm + add);
  }

  return {
    currentRpm: Math.max(cfg.floorRpm, nextRpm),
    windowStart: now,
    windowCount: 0,
    lastDecrease: state.lastDecrease,
    inSlowStart: state.inSlowStart,
  };
}

/**
 * Try to acquire a slot for the given provider.
 * Returns { ok: true } if allowed, or { ok: false, retryAfterMs } if throttled.
 */
export async function acquireProviderSlot(
  slug: string,
  declaredRpm?: number,
): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
  const state = await loadState(slug, declaredRpm);
  const now = Date.now();

  // Window start is in the future (Retry-After pause)
  if (state.windowStart > now) {
    return { ok: false, retryAfterMs: state.windowStart - now };
  }

  // Roll window if expired
  if (now - state.windowStart >= WINDOW_MS) {
    const newState = advanceWindow(slug, state);
    await saveState(slug, newState);
    return acquireProviderSlot(slug, declaredRpm); // recurse once with fresh window
  }

  // Check slot availability
  const elapsed = now - state.windowStart;
  const proratedLimit = Math.max(1, Math.floor((state.currentRpm * elapsed) / WINDOW_MS));

  if (state.windowCount >= proratedLimit) {
    const retryAfterMs = WINDOW_MS - elapsed;
    return { ok: false, retryAfterMs };
  }

  state.windowCount++;
  await saveState(slug, state);
  return { ok: true };
}

/**
 * Report the result of a provider call to adjust the throttle.
 *
 * @param outcome "ok" = success, "rate_limited" = received 429/throttle signal
 * @param retryAfterMs optional Retry-After header value (ms)
 */
export async function reportProviderResult(
  slug: string,
  outcome: "ok" | "rate_limited",
  retryAfterMs?: number,
): Promise<void> {
  const state = await loadState(slug);
  const cfg = getConfig(slug);

  if (outcome === "rate_limited") {
    // Multiplicative decrease
    const nextRpm = Math.max(cfg.floorRpm, Math.floor(state.currentRpm * 0.5));
    state.currentRpm = nextRpm;
    state.lastDecrease = Date.now();
    state.inSlowStart = false; // exit slow start permanently

    // If provider told us to retry after N seconds, pause until then
    if (retryAfterMs && retryAfterMs > 0) {
      state.windowStart = Date.now() + retryAfterMs;
      state.windowCount = 0;
    }

    logger.info(`[providerThrottle] ${slug} rate-limited → RPM ${state.currentRpm}`, {
      retryAfterMs,
    });
  }
  // On "ok": no immediate change; increase happens at window boundary in advanceWindow

  await saveState(slug, state);
}

/**
 * Get live throttle metrics for all providers (for batch_status / admin).
 */
export async function getProviderThrottleMetrics(): Promise<
  Record<string, { currentRpm: number; windowCount: number; inSlowStart: boolean }>
> {
  const redis = await getRedis();
  const out: Record<string, { currentRpm: number; windowCount: number; inSlowStart: boolean }> = {};

  if (redis) {
    try {
      const keys = await redis.keys(`${REDIS_KEY_PREFIX}*`);
      for (const key of keys) {
        const raw = await redis.hgetall(key);
        const slug = key.replace(REDIS_KEY_PREFIX, "");
        out[slug] = {
          currentRpm: parseInt(raw.currentRpm, 10) || 0,
          windowCount: parseInt(raw.windowCount, 10) || 0,
          inSlowStart: raw.inSlowStart === "1",
        };
      }
    } catch {
      // fall through
    }
  }

  for (const [slug, state] of memoryState) {
    if (!out[slug]) {
      out[slug] = {
        currentRpm: state.currentRpm,
        windowCount: state.windowCount,
        inSlowStart: state.inSlowStart,
      };
    }
  }

  return out;
}
