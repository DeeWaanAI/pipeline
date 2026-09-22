// Queue abstraction with two backends behind one API:
//   - BullMQ when Redis is available (durable, multi-node)
//   - In-memory (Map + setTimeout, process-local) otherwise, so dev works
//     without Redis.
//
// Idempotency: the same idempotencyKey within 24h must not double-enqueue
// (Redis: SET NX EX dedupe key; memory: Map with expiry).

import Redis from "ioredis";
import { Queue as BullQueue, Worker as BullWorker } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { getRedis, isRedisEnabled } from "./redis";

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60; // 24h

interface EnqueueOptions {
  idempotencyKey?: string;
  delayMs?: number;
  /**
   * Dispatch even when a dedupe key for this job is still live. The window is
   * 24h, which is longer than any job's life, so a reconciler that finds work
   * abandoned cannot re-dispatch it without this: a benchmark left `queued` by
   * a restart stayed `queued` for a day while the reconciler ran every 60
   * seconds and logged nothing (D9 finding 24). Only callers that have already
   * proved the work is unfinished should use it, and only where the consumer
   * dedupes by lease — which is what makes a forced re-add harmless.
   */
  force?: boolean;
}

export interface AppQueue {
  readonly name: string;
  enqueue(jobName: string, payload: unknown, opts?: EnqueueOptions): Promise<string>;
  close(): Promise<void>;
}

export type JobHandler = (jobName: string, payload: unknown) => Promise<void>;

export interface AppWorker {
  readonly name: string;
  close(): Promise<void>;
}

// ─── Backend selection (decided once, memoized) ─────────────────────
type Backend = "bullmq" | "memory";
let backendPromise: Promise<Backend> | null = null;
// Dedicated ioredis connection for BullMQ — BullMQ workers require
// maxRetriesPerRequest: null, which the shared client in redis.ts doesn't use.
let bullConnection: Redis | null = null;

async function resolveBackend(): Promise<Backend> {
  if (!backendPromise) {
    backendPromise = (async () => {
      if (!isRedisEnabled()) return "memory";
      const shared = await getRedis();
      if (!shared) return "memory";
      try {
        bullConnection = new Redis(env.redisUrl, {
          maxRetriesPerRequest: null, // required by BullMQ workers
          enableReadyCheck: false,
        });
        bullConnection.on("error", (err) => {
          logger.warn("BullMQ Redis connection error", { error: err.message });
        });
        await bullConnection.ping();
        logger.info("Queue backend: bullmq");
        return "bullmq";
      } catch (err) {
        logger.warn("BullMQ connection failed — falling back to in-memory queue", {
          error: (err as Error).message,
        });
        try { bullConnection?.disconnect(); } catch { /* ignore */ }
        bullConnection = null;
        return "memory";
      }
    })();
  }
  return backendPromise;
}

// ─── In-memory backend ──────────────────────────────────────────────
interface MemoryJob {
  id: string;
  jobName: string;
  payload: unknown;
  runAt: number;
}

interface MemoryQueueState {
  jobs: Map<string, MemoryJob>;
  timer: ReturnType<typeof setTimeout> | null;
}

const memoryQueues = new Map<string, MemoryQueueState>();
const memoryWorkers = new Map<string, JobHandler>();
const memoryIdempotency = new Map<string, number>(); // key -> expiry ts
let memSeq = 0;

function getMemoryQueue(name: string): MemoryQueueState {
  let q = memoryQueues.get(name);
  if (!q) {
    q = { jobs: new Map(), timer: null };
    memoryQueues.set(name, q);
  }
  return q;
}

function sweepMemoryIdempotency(): void {
  const now = Date.now();
  for (const [key, expiry] of memoryIdempotency) {
    if (expiry <= now) memoryIdempotency.delete(key);
  }
}

function scheduleMemoryQueue(name: string): void {
  const q = getMemoryQueue(name);
  if (q.timer) return;
  let nextRunAt = Infinity;
  for (const job of q.jobs.values()) {
    if (job.runAt < nextRunAt) nextRunAt = job.runAt;
  }
  if (!isFinite(nextRunAt)) return;
  const delay = Math.max(0, nextRunAt - Date.now());
  q.timer = setTimeout(() => {
    q.timer = null;
    void drainMemoryQueue(name);
  }, delay);
}

async function drainMemoryQueue(name: string): Promise<void> {
  const q = getMemoryQueue(name);
  const handler = memoryWorkers.get(name);
  const now = Date.now();
  const due: MemoryJob[] = [];
  for (const job of q.jobs.values()) {
    if (job.runAt <= now) due.push(job);
  }
  for (const job of due) {
    q.jobs.delete(job.id);
    if (!handler) {
      // No worker yet — re-queue with a short delay so registration can happen
      job.runAt = Date.now() + 250;
      q.jobs.set(job.id, job);
      continue;
    }
    handler(job.jobName, job.payload).catch((err) => {
      logger.error("In-memory job handler failed", {
        queue: name,
        jobId: job.id,
        error: (err as Error).message,
      });
    });
  }
  scheduleMemoryQueue(name);
}

class MemoryAppQueue implements AppQueue {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  async enqueue(jobName: string, payload: unknown, opts?: EnqueueOptions): Promise<string> {
    if (opts?.idempotencyKey && !opts.force) {
      sweepMemoryIdempotency();
      const key = `${this.name}:${opts.idempotencyKey}`;
      if (memoryIdempotency.has(key)) {
        logger.debug("Idempotent enqueue skipped (memory)", { queue: this.name, key: opts.idempotencyKey });
        return `dedup:${opts.idempotencyKey}`;
      }
      memoryIdempotency.set(key, Date.now() + IDEMPOTENCY_TTL_SECONDS * 1000);
    }
    const q = getMemoryQueue(this.name);
    const id = `mem-${this.name}-${++memSeq}`;
    q.jobs.set(id, {
      id,
      jobName,
      payload,
      runAt: Date.now() + (opts?.delayMs ?? 0),
    });
    scheduleMemoryQueue(this.name);
    return id;
  }

  async close(): Promise<void> {
    const q = memoryQueues.get(this.name);
    if (q?.timer) clearTimeout(q.timer);
    memoryQueues.delete(this.name);
  }
}

class MemoryAppWorker implements AppWorker {
  readonly name: string;

  constructor(name: string, handler: JobHandler) {
    this.name = name;
    memoryWorkers.set(name, handler);
    // Drain anything that was enqueued before the worker registered
    void drainMemoryQueue(name);
  }

  async close(): Promise<void> {
    memoryWorkers.delete(this.name);
  }
}

// ─── BullMQ backend ─────────────────────────────────────────────────
class BullAppQueue implements AppQueue {
  readonly name: string;
  private bull: BullQueue;

  constructor(name: string, connection: Redis) {
    this.name = name;
    this.bull = new BullQueue(name, { connection: connection as unknown as ConnectionOptions });
  }

  async enqueue(jobName: string, payload: unknown, opts?: EnqueueOptions): Promise<string> {
    if (opts?.idempotencyKey && !opts.force) {
      const dedupeKey = `idem:${this.name}:${opts.idempotencyKey}`;
      const set = await bullConnection!.set(
        dedupeKey, "1", "EX", IDEMPOTENCY_TTL_SECONDS, "NX",
      );
      if (set === null) {
        logger.debug("Idempotent enqueue skipped (redis)", { queue: this.name, key: opts.idempotencyKey });
        return `dedup:${opts.idempotencyKey}`;
      }
    }
    const job = await this.bull.add(jobName, payload as object, {
      delay: opts?.delayMs,
      attempts: 1,
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 24 * 3600 },
    });
    return job.id ?? `bull:${jobName}:${Date.now()}`;
  }

  async close(): Promise<void> {
    await this.bull.close();
  }
}

class BullAppWorker implements AppWorker {
  readonly name: string;
  private bull: BullWorker;

  constructor(name: string, handler: JobHandler, connection: Redis) {
    this.name = name;
    this.bull = new BullWorker(
      name,
      async (job) => {
        await handler(job.name, job.data);
      },
      { connection: connection as unknown as ConnectionOptions, concurrency: env.swarmWorkerConcurrency },
    );
    this.bull.on("failed", (job, err) => {
      logger.error("BullMQ job failed", {
        queue: name,
        jobId: job?.id,
        jobName: job?.name,
        error: err.message,
      });
    });
  }

  async close(): Promise<void> {
    await this.bull.close();
  }
}

// ─── Public API ─────────────────────────────────────────────────────
const registeredQueues = new Set<AppQueue>();
const registeredWorkers = new Set<AppWorker>();

/** Active queue backend name (for health/readiness reporting). */
export async function getQueueBackend(): Promise<Backend> {
  return resolveBackend();
}

export function createQueue(name: string): AppQueue {
  let impl: AppQueue | null = null;
  // Wrapper defers backend selection to first use (enqueue is always async)
  const wrapper: AppQueue = {
    name,
    async enqueue(jobName, payload, opts) {
      if (!impl) {
        const backend = await resolveBackend();
        impl = backend === "bullmq" && bullConnection
          ? new BullAppQueue(name, bullConnection)
          : new MemoryAppQueue(name);
      }
      return impl.enqueue(jobName, payload, opts);
    },
    async close() {
      if (impl) await impl.close();
      registeredQueues.delete(wrapper);
    },
  };
  registeredQueues.add(wrapper);
  return wrapper;
}

export function createWorker(name: string, handler: JobHandler): AppWorker {
  let impl: AppWorker | null = null;
  const initPromise = resolveBackend().then((backend) => {
    impl = backend === "bullmq" && bullConnection
      ? new BullAppWorker(name, handler, bullConnection)
      : new MemoryAppWorker(name, handler);
  }).catch((err) => {
    logger.error("Worker init failed — using in-memory worker", {
      queue: name,
      error: (err as Error).message,
    });
    impl = new MemoryAppWorker(name, handler);
  });

  const wrapper: AppWorker = {
    name,
    async close() {
      await initPromise;
      if (impl) await impl.close();
      registeredWorkers.delete(wrapper);
    },
  };
  registeredWorkers.add(wrapper);
  return wrapper;
}

/** Graceful shutdown helper — closes every queue, worker and the BullMQ connection. */
export async function closeAllQueues(): Promise<void> {
  for (const w of [...registeredWorkers]) {
    try { await w.close(); } catch { /* ignore */ }
  }
  for (const q of [...registeredQueues]) {
    try { await q.close(); } catch { /* ignore */ }
  }
  if (bullConnection) {
    try { bullConnection.disconnect(); } catch { /* ignore */ }
    bullConnection = null;
  }
}
