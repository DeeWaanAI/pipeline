// Lazy singleton Redis client (ioredis).
//
// The app must NEVER crash because Redis is down: after 3 quick connect
// attempts with backoff we give up and return null. Every subsystem that
// uses Redis (queue, pub/sub, run claims) has an in-memory fallback.

import Redis from "ioredis";
import { env } from "../lib/env";
import { logger } from "../lib/logger";

const MAX_CONNECT_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 150;

let client: Redis | null = null;
let connecting: Promise<Redis | null> | null = null;
let gaveUp = false;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function tryConnect(): Promise<Redis | null> {
  const url = env.redisUrl;
  if (!url) return null;

  const candidate = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2000,
    // We manage retry/backoff ourselves below
    retryStrategy: () => null,
  });

  // Swallow async error events — connection state is tracked explicitly
  candidate.on("error", (err) => {
    logger.warn("Redis connection error", { error: err.message });
  });

  for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt++) {
    try {
      await candidate.connect();
      logger.info("Redis connected", { attempt });
      return candidate;
    } catch (err) {
      logger.warn("Redis connect attempt failed", {
        attempt,
        maxAttempts: MAX_CONNECT_ATTEMPTS,
        error: (err as Error).message,
      });
      if (attempt < MAX_CONNECT_ATTEMPTS) {
        await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt - 1));
      }
    }
  }

  try { candidate.disconnect(); } catch { /* ignore */ }
  return null;
}

/**
 * Returns the shared Redis client, or null when REDIS_URL is unset or the
 * server is unreachable after a few quick attempts. Never throws.
 */
export async function getRedis(): Promise<Redis | null> {
  if (!isRedisEnabled()) return null;
  if (gaveUp) return null;
  if (client && client.status === "ready") return client;
  if (!connecting) {
    connecting = tryConnect().then((c) => {
      connecting = null;
      if (c) {
        client = c;
      } else {
        gaveUp = true;
        logger.warn("Redis unavailable after retries — running with in-memory fallbacks");
      }
      return client;
    });
  }
  return connecting;
}

/** True when a REDIS_URL is configured (connection itself may still be down). */
export function isRedisEnabled(): boolean {
  return env.redisUrl.length > 0;
}
