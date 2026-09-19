// Design-job worker (offering redesign v2, spec §5.3).
// Consumes the `design-jobs` queue. The DB is authoritative for intent and
// state; the queue message carries identifiers only — never keys or prompts.
// Enqueue is driven by the transactional job_outbox, so a crash between
// commit and dispatch is reconciled by startDesignOutboxReconciler().

import { createQueue, createWorker, getQueueBackend, type AppQueue, type AppWorker } from "../infra/queue";
import { logger } from "../lib/logger";
import { env } from "../lib/env";
import {
  acquireDesignJob,
  dispatchPendingOutbox,
  healStaleDesignJobs,
  runDesignJobGeneration,
} from "../services/designJobService";

export const DESIGN_QUEUE_NAME = "design-jobs";
export const DESIGN_JOB_RUN = "run";

export interface DesignJobPayload {
  designJobId: number;
  userId: number;
}

const designQueue: AppQueue = createQueue(DESIGN_QUEUE_NAME);

let worker: AppWorker | null = null;
let reconcilerTimer: ReturnType<typeof setInterval> | null = null;

async function enqueueDesignJob(designJobId: number, userId: number): Promise<string> {
  return designQueue.enqueue(DESIGN_JOB_RUN, { designJobId, userId } satisfies DesignJobPayload, {
    idempotencyKey: `design-job-${designJobId}`,
  });
}

export function startDesignWorker(): void {
  if (worker) return;
  worker = createWorker(DESIGN_QUEUE_NAME, async (jobName, payload) => {
    if (jobName !== DESIGN_JOB_RUN) {
      logger.warn("designWorker: unknown job name — dropping", { jobName });
      return;
    }
    const { designJobId } = (payload ?? {}) as DesignJobPayload;
    if (!designJobId) return;
    const lease = await acquireDesignJob(designJobId);
    if (!lease) {
      logger.debug("designWorker: job not claimable (duplicate/lost lease) — no-op", { designJobId });
      return;
    }
    await runDesignJobGeneration(designJobId, lease);
  });
  logger.info("designWorker: started", { queue: DESIGN_QUEUE_NAME });
}

/** Boot heal + periodic reconciliation of outbox and stale leases.
 *  Mirrors the swarm DB-heal pattern in boot.ts. */
export function startDesignOutboxReconciler(periodMs = 60_000): void {
  if (reconcilerTimer) return;
  void (async () => {
    try {
      const healed = await healStaleDesignJobs();
      if (healed > 0) logger.info("designReconciler: recovered jobs", { flagged: healed });
      const n = await dispatchPendingOutbox(enqueueDesignJob);
      if (n > 0) logger.info("designReconciler: dispatched outbox rows", { n });
    } catch (err) {
      logger.error("designReconciler: pass failed", { error: (err as Error).message });
    }
  })();
  reconcilerTimer = setInterval(() => {
    void (async () => {
      try {
        await healStaleDesignJobs();
        await dispatchPendingOutbox(enqueueDesignJob);
      } catch { /* logged per-pass above */ }
    })();
  }, periodMs);
  reconcilerTimer.unref?.();
}

export async function stopDesignWorker(): Promise<void> {
  if (reconcilerTimer) { clearInterval(reconcilerTimer); reconcilerTimer = null; }
  if (worker) { try { await worker.close(); } catch { /* ignore */ } worker = null; }
  try { await designQueue.close(); } catch { /* ignore */ }
}

export function isDesignWorkerRunning(): boolean {
  return worker !== null;
}

/** Dispatch helper for startDesignJob callers (fire-and-forget with outbox
 *  guarantee behind it). In production protected paths, a memory backend is
 *  surfaced in the log so operators can see non-durable fallback. */
export async function dispatchDesignJob(jobId: number, userId: number): Promise<void> {
  const backend = await getQueueBackend();
  if (env.isProduction && backend !== "bullmq") {
    logger.warn("designWorker: Redis unavailable — durable dispatch degraded to in-memory", { jobId });
  }
  await dispatchPendingOutbox(async (id, uid) => enqueueDesignJob(id, uid || userId));
}
