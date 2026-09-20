// ═══════════════════════════════════════════════════════════════════════════════
// DEDICATED PIPELINE WORKER PROCESS
// ═══════════════════════════════════════════════════════════════════════════════
//
// Optional production-scale entrypoint: consumes the same `swarm-runs` queue
// as the web dyno, but in its own process so long pipeline execution never
// competes with HTTP serving for CPU/heap.
//
// Deploy as a second service running `node dist/workerEntry.js` (same image,
// same env vars), and set START_WORKER=false on the web service so only this
// process consumes jobs. See DEPLOY.md — "Optional: dedicated worker service".
//
// Crash-resume note: the DB-heal (stale "running" → "pending" → re-enqueue)
// runs at web boot; enqueueing is idempotent (24h dedupe key), so overlap is
// safe. This process only CONSUMES.
// ═══════════════════════════════════════════════════════════════════════════════

import { startSwarmWorker, stopSwarmWorker } from "./workers/swarmWorker";
import { startDesignWorker, startDesignOutboxReconciler, stopDesignWorker } from "./workers/designWorker";
import { startBenchmarkWorker, startBenchmarkReconciler, stopBenchmarkWorker } from "./workers/benchmarkWorker";
import { closeAllQueues } from "./infra/queue";
import { logger } from "./lib/logger";
import { initObservability } from "./lib/observability";

void initObservability();

startSwarmWorker();
startDesignWorker();
startDesignOutboxReconciler();
startBenchmarkWorker();
startBenchmarkReconciler();
logger.info("Worker process started", { pid: process.pid });

// ─── Global Error Handlers ─────────────────────────────────────────
process.on("uncaughtException", (err) => {
  logger.error("Worker: uncaught exception", { error: err.message, stack: err.stack });
});
process.on("unhandledRejection", (reason) => {
  logger.error("Worker: unhandled rejection", { reason: String(reason) });
});

// ─── Graceful Shutdown ─────────────────────────────────────────────
let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info("Worker: graceful shutdown initiated", { signal });

  const shutdownTimeout = setTimeout(() => {
    logger.error("Worker: shutdown timeout exceeded, forcing exit");
    process.exit(1);
  }, 30_000);

  try {
    // Stop consuming, then close queues/Redis. In-flight "running" runs are
    // left as-is: the DB-heal at next web boot resets + re-enqueues them.
    await stopSwarmWorker();
    await stopDesignWorker();
    await stopBenchmarkWorker();
    await closeAllQueues();
    logger.info("Worker: shutdown complete");
  } catch (err) {
    logger.error("Worker: shutdown failed", { error: (err as Error).message });
  }

  clearTimeout(shutdownTimeout);
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
