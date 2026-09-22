// Benchmark worker (offering redesign v2, spec §5.3 pattern applied to
// evaluation jobs): queue carries identifiers only; DB is authoritative.

import { createQueue, createWorker, getQueueBackend, type AppQueue, type AppWorker } from "../infra/queue";
import { logger } from "../lib/logger";
import { env } from "../lib/env";
import { isFeatureEnabled } from "../plugins/featureFlags";
import { acquireBenchmark, executeBenchmark, healStaleBenchmarks } from "../services/benchmark/benchmarkService";
import { inArray } from "drizzle-orm";
import { benchmarks } from "@db/schema";
import { getDb } from "../queries/connection";

export const BENCHMARK_QUEUE_NAME = "benchmark-runs";
export const BENCHMARK_JOB_RUN = "run";

export interface BenchmarkJobPayload {
  benchmarkId: number;
}

const benchmarkQueue: AppQueue = createQueue(BENCHMARK_QUEUE_NAME);
let worker: AppWorker | null = null;
let healTimer: ReturnType<typeof setInterval> | null = null;

export async function enqueueBenchmark(benchmarkId: number, opts?: { force?: boolean }): Promise<string> {
  return benchmarkQueue.enqueue(BENCHMARK_JOB_RUN, { benchmarkId } satisfies BenchmarkJobPayload, {
    idempotencyKey: `benchmark-${benchmarkId}`,
    force: opts?.force,
  });
}

export function startBenchmarkWorker(): void {
  if (worker) return;
  worker = createWorker(BENCHMARK_QUEUE_NAME, async (jobName, payload) => {
    if (jobName !== BENCHMARK_JOB_RUN) return;
    const { benchmarkId } = (payload ?? {}) as BenchmarkJobPayload;
    if (!benchmarkId) return;
    // The flag must actually stop the worker, not just the UI: "disable
    // v2Benchmarks" is the rollback path, and a queued job must not spend
    // against a disabled feature. The row stays `queued` for a later pass.
    if (!(await isBenchmarkFeatureEnabled())) {
      logger.info("benchmarkWorker: v2Benchmarks disabled — leaving job queued", { benchmarkId });
      return;
    }
    const lease = await acquireBenchmark(benchmarkId);
    if (!lease) {
      logger.debug("benchmarkWorker: not claimable (duplicate or terminal) — no-op", { benchmarkId });
      return;
    }
    await executeBenchmark({ benchmarkId, leaseToken: lease });
  });
  logger.info("benchmarkWorker: started", { queue: BENCHMARK_QUEUE_NAME });
}

/** Global flag state (no user context in a worker): rollout percentages are
 *  per-user and therefore do NOT enable background execution. */
async function isBenchmarkFeatureEnabled(): Promise<boolean> {
  try {
    return await isFeatureEnabled("v2Benchmarks");
  } catch (err) {
    logger.error("benchmarkWorker: flag lookup failed — treating as disabled", { error: (err as Error).message });
    return false;
  }
}

/** Boot/periodic: lease-expiry heal + re-dispatch of queued benchmarks that
 *  were never enqueued (e.g. enqueue call failed after commit). */
export function startBenchmarkReconciler(periodMs = 60_000): void {
  if (healTimer) return;
  const pass = async () => {
    try {
      if (!(await isBenchmarkFeatureEnabled())) return;
      const healed = await healStaleBenchmarks();
      const db = getDb();
      const queued = await db.select({ id: benchmarks.id }).from(benchmarks).where(inArray(benchmarks.state, ["queued"]));
      for (const row of queued) {
        // Forced: the 24h dedupe window outlives the job it was meant to
        // protect, so a plain re-enqueue of a row the reconciler has PROVED is
        // still `queued` is silently swallowed and the row never runs
        // (D9 finding 24). Double execution is prevented by the lease in
        // `acquireBenchmark`, not by this key.
        try {
          await enqueueBenchmark(row.id, { force: true });
        } catch { /* next pass covers a queue that is briefly down */ }
      }
      if (healed > 0) logger.info("benchmarkReconciler: healed stale leases", { healed });
    } catch (err) {
      logger.error("benchmarkReconciler pass failed", { error: (err as Error).message });
    }
  };
  void pass();
  healTimer = setInterval(() => void pass(), periodMs);
  healTimer.unref?.();
}

export async function dispatchBenchmarkStart(benchmarkId: number): Promise<void> {
  const backend = await getQueueBackend();
  if (env.isProduction && backend !== "bullmq") {
    logger.warn("benchmarkWorker: Redis unavailable — dispatch degraded to in-memory", { benchmarkId });
  }
  try {
    await enqueueBenchmark(benchmarkId);
  } catch (err) {
    // The reconciler re-dispatches queued rows; commit already succeeded.
    logger.warn("benchmarkWorker: immediate dispatch failed; reconciler will retry", {
      benchmarkId, error: (err as Error).message,
    });
  }
}

export async function stopBenchmarkWorker(): Promise<void> {
  if (healTimer) { clearInterval(healTimer); healTimer = null; }
  if (worker) { try { await worker.close(); } catch { /* ignore */ } worker = null; }
  try { await benchmarkQueue.close(); } catch { /* ignore */ }
}

export function isBenchmarkWorkerRunning(): boolean {
  return worker !== null;
}
