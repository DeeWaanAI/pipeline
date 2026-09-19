// Pub/sub abstraction with two backends behind one API:
//   - Redis pub/sub when Redis is available (multi-node fan-out)
//   - In-process EventEmitter otherwise (dev / single node)
//
// Every published message is wrapped in an envelope tagged with an `origin`
// instance id (module-level nanoid) so subscribers can ignore their own
// process's echoes.

import { EventEmitter } from "events";
import { nanoid } from "nanoid";
import type Redis from "ioredis";
import { logger } from "../lib/logger";
import { getRedis, isRedisEnabled } from "./redis";

/** Unique id for this process — used to drop self-echoed pub/sub messages. */
export const INSTANCE_ID = nanoid(12);

export interface PubSubEnvelope<T = unknown> {
  origin: string;
  ts: number;
  message: T;
}

export type PubSubHandler<T = unknown> = (envelope: PubSubEnvelope<T>) => void;
export type Unsubscribe = () => void;

// ─── In-memory backend ──────────────────────────────────────────────
const emitter = new EventEmitter();
emitter.setMaxListeners(0); // unbounded — one listener per channel per process

// ─── Redis backend (single duplicate connection in subscriber mode) ──
let subscriber: Redis | null = null;
let subscriberReady: Promise<Redis | null> | null = null;
const redisHandlers = new Map<string, Set<PubSubHandler>>();

async function getSubscriber(): Promise<Redis | null> {
  if (!isRedisEnabled()) return null;
  if (subscriber && subscriber.status === "ready") return subscriber;
  if (!subscriberReady) {
    subscriberReady = (async () => {
      const base = await getRedis();
      if (!base) return null;
      try {
        const sub = base.duplicate();
        sub.on("error", (err) => {
          logger.warn("Redis subscriber connection error", { error: err.message });
        });
        sub.on("message", (channel, raw) => {
          dispatchRedisMessage(channel, raw);
        });
        // Attach handlers registered before the connection was ready
        for (const channel of redisHandlers.keys()) {
          await sub.subscribe(channel);
        }
        subscriber = sub;
        logger.info("Pub/sub backend: redis", { instanceId: INSTANCE_ID });
        return sub;
      } catch (err) {
        logger.warn("Redis subscriber setup failed — using in-memory pub/sub", {
          error: (err as Error).message,
        });
        return null;
      } finally {
        subscriberReady = null;
      }
    })();
  }
  return subscriberReady;
}

function dispatchRedisMessage(channel: string, raw: string): void {
  const handlers = redisHandlers.get(channel);
  if (!handlers || handlers.size === 0) return;
  let envelope: PubSubEnvelope;
  try {
    envelope = JSON.parse(raw) as PubSubEnvelope;
  } catch {
    logger.warn("Dropping malformed pub/sub message", { channel });
    return;
  }
  for (const handler of handlers) {
    try { handler(envelope); } catch (err) {
      logger.error("Pub/sub handler threw", { channel, error: (err as Error).message });
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────────

/** Publish a message on a channel. Never throws — failures are logged. */
export async function publish<T>(channel: string, message: T): Promise<void> {
  const envelope: PubSubEnvelope<T> = { origin: INSTANCE_ID, ts: Date.now(), message };
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.publish(channel, JSON.stringify(envelope));
      return;
    } catch (err) {
      logger.warn("Redis publish failed — falling back to local emit", {
        channel,
        error: (err as Error).message,
      });
    }
  }
  emitter.emit(channel, envelope);
}

/**
 * Subscribe to a channel. Returns an unsubscribe function.
 * Redis backend uses a duplicate connection in subscriber mode; in-memory
 * backend uses an EventEmitter. Setup is best-effort: if Redis is down the
 * subscription silently degrades to process-local delivery.
 */
export async function subscribe<T>(channel: string, handler: PubSubHandler<T>): Promise<Unsubscribe> {
  const typedHandler = handler as PubSubHandler;

  // Always register locally — covers memory mode and doubles as the fallback
  // path when Redis publish fails upstream.
  emitter.on(channel, typedHandler);

  let redisUnsub: Unsubscribe | null = null;
  const sub = await getSubscriber();
  if (sub) {
    let set = redisHandlers.get(channel);
    const firstHandler = !set || set.size === 0;
    if (!set) {
      set = new Set();
      redisHandlers.set(channel, set);
    }
    set.add(typedHandler);
    if (firstHandler) {
      try { await sub.subscribe(channel); } catch (err) {
        logger.warn("Redis SUBSCRIBE failed", { channel, error: (err as Error).message });
      }
    }
    redisUnsub = () => {
      const handlers = redisHandlers.get(channel);
      handlers?.delete(typedHandler);
      if (handlers && handlers.size === 0) {
        redisHandlers.delete(channel);
        sub.unsubscribe(channel).catch(() => { /* ignore */ });
      }
    };
  }

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    emitter.off(channel, typedHandler);
    redisUnsub?.();
  };
}
