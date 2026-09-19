// Pipeline worker (F0.5): consumes `swarm-runs` queue jobs and executes
// pipelines via executeSwarmRun. Long work runs here, not in HTTP requests.
//
// With Redis: BullMQ-backed, multi-node. Without Redis: in-memory queue,
// jobs run in-process (dev / single node).

import { createQueue, createWorker, type AppQueue, type AppWorker } from "../infra/queue";
import { executeSwarmRun } from "../services/swarmService";
import { logger } from "../lib/logger";

export const SWARM_QUEUE_NAME = "swarm-runs";
export const SWARM_JOB_EXECUTE = "execute";

export interface SwarmJobPayload {
  swarmRunId: number;
  userId: number;
}

// Single shared queue instance for all producers (mutations, boot heal)
const swarmQueue: AppQueue = createQueue(SWARM_QUEUE_NAME);

let worker: AppWorker | null = null;

/** Enqueue a run for worker execution. Returns the queue job id. */
export async function enqueueSwarmRun(
  swarmRunId: number,
  userId: number,
  opts?: { bypassDedup?: boolean; delayMs?: number },
): Promise<string> {
  const payload: SwarmJobPayload = { swarmRunId, userId };
  return swarmQueue.enqueue(SWARM_JOB_EXECUTE, payload, {
    idempotencyKey: opts?.bypassDedup ? undefined : `run-${swarmRunId}`,
    ...(opts?.delayMs ? { delayMs: opts.delayMs } : {}),
  });
}

/** Register the worker. Safe to call once at boot. */
export function startSwarmWorker(): void {
  if (worker) return;
  worker = createWorker(SWARM_QUEUE_NAME, async (jobName, payload) => {
    if (jobName !== SWARM_JOB_EXECUTE) {
      logger.warn("swarmWorker: unknown job name — dropping", { jobName });
      return;
    }
    const { swarmRunId, userId } = payload as SwarmJobPayload;
    if (!swarmRunId || !userId) {
      logger.warn("swarmWorker: malformed job payload — dropping", { payload: JSON.stringify(payload) });
      return;
    }
    logger.info("swarmWorker: picked up run", { swarmRunId, userId });
    // executeSwarmRun handles its own pipeline errors (marks run failed and
    // emits pipeline_error); anything thrown here is a setup-level failure
    // already logged + marked failed inside the service.
    await executeSwarmRun({ swarmRunId, userId }, async (delayMs) => {
      await enqueueSwarmRun(swarmRunId, userId, { bypassDedup: true, delayMs });
      logger.info("swarmWorker: requeued throttled run", { swarmRunId, delayMs });
    });
  });
  logger.info("swarmWorker: started", { queue: SWARM_QUEUE_NAME });
}

/** Close the worker + queue (graceful shutdown). */
export async function stopSwarmWorker(): Promise<void> {
  if (worker) {
    try { await worker.close(); } catch { /* ignore */ }
    worker = null;
  }
  try { await swarmQueue.close(); } catch { /* ignore */ }
}

/** Whether the pipeline worker is registered in this process (health/readiness). */
export function isSwarmWorkerRunning(): boolean {
  return worker !== null;
}
