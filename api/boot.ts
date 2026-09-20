import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext } from "./context";
import { env } from "./lib/env";
import { Paths } from "@contracts/constants";
import { registerStreamRoute } from "./stream-route";
import { registerUploadRoute } from "./upload-route";
import { registerFeedbackScreenshotRoute } from "./feedback-screenshot-route";
import { registerProjectImportRoute } from "./project-import-route";
import { registerBeaconSaveRoute } from "./beacon-save-route";
import { registerBackupRoute } from "./backup-route";
import { registerWaitlistRoute } from "./waitlist-route";
import { registerTestFixtureRoute } from "./test-fixture-route";
import { registerBillingWebhookRoute } from "./billing-webhook-route";
import { registerCertificationBadgeRoute } from "./certification-badge-route";
import { registerMcpRoutes } from "./mcp/register";
import { registerSsoRoutes } from "./sso-route";
import { registerRelayRoutes } from "./relay-route";
import { startSwarmWorker, stopSwarmWorker, enqueueSwarmRun, isSwarmWorkerRunning } from "./workers/swarmWorker";
import { startDesignWorker, startDesignOutboxReconciler, stopDesignWorker } from "./workers/designWorker";
import { startBenchmarkWorker, startBenchmarkReconciler, stopBenchmarkWorker } from "./workers/benchmarkWorker";
import { closeAllQueues, getQueueBackend } from "./infra/queue";
import { getRedis, isRedisEnabled } from "./infra/redis";
import { logger } from "./lib/logger";
import { initObservability } from "./lib/observability";

// Allow typed c.set("requestId", ...) / c.get("requestId") across the app.
declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
  }
}

const app = new Hono<{ Bindings: HttpBindings }>();

// ─── Request ID ────────────────────────────────────────────────────
// Read an inbound x-request-id or generate one, expose it to downstream
// handlers via c.get("requestId"), and echo it on the response headers.
app.use(async (c, next) => {
  const id = c.req.header("x-request-id") ?? crypto.randomUUID();
  c.set("requestId", id);
  await next();
  c.res.headers.set("x-request-id", id);
});

// ─── Security Headers ──────────────────────────────────────────────
app.use(async (c, next) => {
  await next();
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("X-Frame-Options", "DENY");
  c.res.headers.set("X-XSS-Protection", "0");
  c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (env.isProduction) {
    c.res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
});

app.use(bodyLimit({ maxSize: 50 * 1024 * 1024 }));

// ─── Observability (Sentry) — best-effort, never blocks boot ───────
void initObservability();

// ─── Pipeline worker (F0.5) ────────────────────────────────────────
// Consume swarm-runs queue jobs in-process. Long pipeline work runs in the
// worker, not in HTTP requests. Safe to call once at boot.
// Set START_WORKER=false when running a dedicated worker process
// (node dist/workerEntry.js) so the web dyno serves HTTP only — see DEPLOY.md.
if (process.env.START_WORKER !== "false") {
  startSwarmWorker();
  // v2 durable design jobs (offering redesign spec §5.3). The worker
  // consumes only when its feature flag gates producers; the reconciler is
  // harmless (no-op with an empty outbox) and MUST run in every process so
  // accepted intent is always dispatched.
  startDesignWorker();
  startBenchmarkWorker();
}
startDesignOutboxReconciler();
startBenchmarkReconciler();

// ─── Health Check (liveness) ───────────────────────────────────────
// 200 as long as the process is up and MySQL answers; degraded when the DB
// is down. Docker/Railway healthchecks should target this endpoint.
app.get("/api/health", async (c) => {
  let dbOk = false;
  try {
    const { getDb } = await import("./queries/connection");
    const db = getDb();
    await db.execute("SELECT 1");
    dbOk = true;
  } catch { /* db unavailable */ }

  const status = dbOk ? 200 : 503;
  return c.json({
    status: dbOk ? "ok" : "degraded",
    ts: Date.now(),
    uptime: process.uptime(),
    memory: {
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    },
    db: dbOk ? "connected" : "disconnected",
    redis: isRedisEnabled() ? "enabled" : "disabled",
    queue: await getQueueBackend(),
    worker: isSwarmWorkerRunning() ? "running" : "disabled",
  }, status);
});

// ─── Readiness Check ───────────────────────────────────────────────
// 200 only when the app can actually do work: MySQL reachable AND Redis
// connected (when Redis is configured). Use for load-balancer/orchestrator
// readiness probes; a 503 here means "don't route traffic yet".
app.get("/api/ready", async (c) => {
  let dbOk = false;
  try {
    const { getDb } = await import("./queries/connection");
    const db = getDb();
    await db.execute("SELECT 1");
    dbOk = true;
  } catch { /* db unavailable */ }

  let redisOk = true;
  let redisStatus: string = "disabled";
  if (isRedisEnabled()) {
    try {
      const redis = await getRedis();
      redisOk = !!redis && (await redis.ping()) === "PONG";
      redisStatus = redisOk ? "connected" : "disconnected";
    } catch {
      redisOk = false;
      redisStatus = "disconnected";
    }
  }

  const ready = dbOk && redisOk;
  return c.json({
    status: ready ? "ready" : "not-ready",
    db: dbOk ? "connected" : "disconnected",
    redis: redisStatus,
    queue: await getQueueBackend(),
    worker: isSwarmWorkerRunning() ? "running" : "disabled",
  }, ready ? 200 : 503);
});

// Register SSE streaming route
registerStreamRoute(app);

// Register raw file upload route (bypasses tRPC for large binary files)
registerUploadRoute(app);

// Register feedback screenshot upload (raw HTTP POST for large base64 images)
// Also serves uploaded screenshots statically
registerFeedbackScreenshotRoute(app);

// Register project ZIP import (raw HTTP POST for large binary ZIP files)
registerProjectImportRoute(app);

// Register beacon save-preferences (raw HTTP POST for navigator.sendBeacon)
registerBeaconSaveRoute(app);
registerTestFixtureRoute(app);

// Register Stripe billing webhook (raw body + signature verification)
registerBillingWebhookRoute(app);

// Register public certification badge (SVG, CDN-cacheable)
registerCertificationBadgeRoute(app);

// Register scheduled-backup trigger (BACKUP_TOKEN bearer → mysqldump → S3).
// Self-gates to 503 when BACKUP_TOKEN / S3_* are unconfigured.
registerBackupRoute(app);

// Register public waitlist contract (Pioneer 100, consumed by the marketing site).
registerWaitlistRoute(app);

// Register Companion MCP server (OAuth + streamable HTTP + legacy SSE).
// Guarded so a registration failure can never prevent the app from booting.
try {
  registerMcpRoutes(app);
} catch (err) {
  logger.error("MCP route registration failed — MCP endpoints disabled", {
    error: (err as Error).message,
  });
}

// Register Enterprise SSO routes (OIDC + SAML). Endpoints self-gate behind
// the `enterprise_sso` feature flag (404 when disabled).
try {
  registerSsoRoutes(app);
} catch (err) {
  logger.error("SSO route registration failed — SSO endpoints disabled", {
    error: (err as Error).message,
  });
}

// Register on-prem relay routes (outbound-only connector bridge). Endpoints
// self-gate behind the `enterprise_relay` feature flag (404 when disabled).
try {
  registerRelayRoutes(app);
} catch (err) {
  logger.error("Relay route registration failed — relay endpoints disabled", {
    error: (err as Error).message,
  });
}

// ─── DB Healing: requeue stale "running" and "pending" runs from previous crashes ───
// Runs left in "running" belong to a process that died. Reset them to
// "pending" and re-enqueue so the worker resumes them. "awaiting_approval"
// runs are left untouched (they wait on a human, not the worker).
// Pending runs that were never picked up are also re-enqueued (lost job).
(async () => {
  try {
    const { getDb } = await import("./queries/connection");
    const { swarmRuns } = await import("@db/schema");
    const { eq, inArray, sql, isNull, and } = await import("drizzle-orm");
    const db = getDb();

    // 1. Heal stale "running" runs (worker crash)
    const staleRunning = await db.select({ id: swarmRuns.id, userId: swarmRuns.userId })
      .from(swarmRuns)
      .where(eq(swarmRuns.status, "running"))
      .limit(100);

    if (staleRunning.length > 0) {
      await db.update(swarmRuns)
        .set({ status: "pending" })
        .where(inArray(swarmRuns.id, staleRunning.map((r) => r.id)));

      let enqueued = 0;
      for (const run of staleRunning) {
        try {
          await enqueueSwarmRun(run.id, run.userId, { bypassDedup: true });
          enqueued++;
        } catch (err) {
          logger.error("DB-HEAL: failed to re-enqueue run", { swarmRunId: run.id, error: (err as Error).message });
        }
      }
      logger.info("DB-HEAL: re-queued stale running runs", { found: staleRunning.length, enqueued });
    }

    // 2. Heal stale "pending" runs (lost queue job) — startedAt > 5 min ago
    // Exclude batch members: they legitimately queue for hours at low concurrency.
    const stalePending = await db.select({ id: swarmRuns.id, userId: swarmRuns.userId, startedAt: swarmRuns.startedAt })
      .from(swarmRuns)
      .where(
        and(eq(swarmRuns.status, "pending"), isNull(swarmRuns.batchId)),
      )
      .limit(100);

    const now = Date.now();
    const PENDING_STALE_MS = 5 * 60 * 1000; // 5 minutes
    const lostPending = stalePending.filter((r) => {
      const startedMs = r.startedAt ? new Date(r.startedAt).getTime() : 0;
      return startedMs > 0 && now - startedMs > PENDING_STALE_MS;
    });

    if (lostPending.length > 0) {
      let enqueued = 0;
      for (const run of lostPending) {
        try {
          await enqueueSwarmRun(run.id, run.userId, { bypassDedup: true });
          enqueued++;
        } catch (err) {
          logger.error("DB-HEAL: failed to re-enqueue pending run", { swarmRunId: run.id, error: (err as Error).message });
        }
      }
      logger.info("DB-HEAL: re-queued stale pending runs", { found: lostPending.length, enqueued });
    }
  } catch (err) {
    logger.error("DB-HEAL failed", { error: (err as Error).message });
  }
})();

// ─── Periodic Runtime Reconciler (batch + run liveness) ────────────
// Every 60s: heal lost pending jobs, stale running claims, and finalize
// batches whose members are all terminal but were never counted.
const RECONCILER_INTERVAL_MS = 60_000;
const CLAIM_TTL_MS = 30 * 60 * 1000;
const PENDING_STALE_MS = 5 * 60 * 1000;

setInterval(async () => {
  try {
    const { getDb } = await import("./queries/connection");
    const { swarmRuns, swarmBatches } = await import("@db/schema");
    const { eq, inArray, and, or, sql, isNull } = await import("drizzle-orm");
    const db = getDb();
    const now = Date.now();

    // 1. Re-enqueue stale pending runs (lost job)
    // Exclude batch members: they legitimately queue for hours at low concurrency.
    const stalePending = await db
      .select({ id: swarmRuns.id, userId: swarmRuns.userId, startedAt: swarmRuns.startedAt })
      .from(swarmRuns)
      .where(and(eq(swarmRuns.status, "pending"), isNull(swarmRuns.batchId)))
      .limit(50);

    for (const run of stalePending) {
      const startedMs = run.startedAt ? new Date(run.startedAt).getTime() : 0;
      if (startedMs > 0 && now - startedMs > PENDING_STALE_MS) {
        try {
          await enqueueSwarmRun(run.id, run.userId, { bypassDedup: true });
          logger.debug("RECONCILER: re-enqueued stale pending run", { runId: run.id });
        } catch (err) {
          logger.error("RECONCILER: failed to re-enqueue pending run", { runId: run.id, error: (err as Error).message });
        }
      }
    }

    // 2. Reset+re-enqueue stale running runs (no active claim)
    const staleRunning = await db
      .select({ id: swarmRuns.id, userId: swarmRuns.userId, startedAt: swarmRuns.startedAt })
      .from(swarmRuns)
      .where(eq(swarmRuns.status, "running"))
      .limit(50);

    for (const run of staleRunning) {
      const startedMs = run.startedAt ? new Date(run.startedAt).getTime() : 0;
      if (startedMs > 0 && now - startedMs > CLAIM_TTL_MS) {
        try {
          await db.update(swarmRuns)
            .set({ status: "pending" })
            .where(eq(swarmRuns.id, run.id));
          await enqueueSwarmRun(run.id, run.userId, { bypassDedup: true });
          logger.info("RECONCILER: reset and re-enqueued stale running run", { runId: run.id, ageMs: now - startedMs });
        } catch (err) {
          logger.error("RECONCILER: failed to heal running run", { runId: run.id, error: (err as Error).message });
        }
      }
    }

    // 3. Batch reconciliation: finalize batches where all members are terminal
    const runningBatches = await db
      .select({ id: swarmBatches.id })
      .from(swarmBatches)
      .where(eq(swarmBatches.status, "running"))
      .limit(20);

    for (const batch of runningBatches) {
      const members = await db
        .select({ status: swarmRuns.status })
        .from(swarmRuns)
        .where(eq(swarmRuns.batchId, batch.id));

      const allTerminal = members.length > 0 && members.every((m) =>
        m.status === "completed" || m.status === "failed" || m.status === "cancelled",
      );

      if (allTerminal) {
        const completed = members.filter((m) => m.status === "completed").length;
        const failed = members.filter((m) => m.status === "failed" || m.status === "cancelled").length;
        const finalStatus = failed > 0 ? "completed_with_failures" : "completed";

        await db.update(swarmBatches)
          .set({
            status: finalStatus,
            completedAt: new Date(),
            completedRuns: completed,
            failedRuns: failed,
          })
          .where(eq(swarmBatches.id, batch.id));

        logger.info("RECONCILER: finalized batch", { batchId: batch.id, completed, failed, status: finalStatus });
      }
    }
  } catch (err) {
    logger.error("RECONCILER failed", { error: (err as Error).message });
  }
}, RECONCILER_INTERVAL_MS);

// ─── tRPC handler ──────────────────────────────────────────────────
app.use("/api/trpc/*", async (c) => {
  // Direct socket address, threaded into the tRPC context so rate-limit IP
  // resolution can fall back to it when TRUSTED_PROXY=false (lib/clientIp).
  const remoteIp = c.env?.incoming?.socket?.remoteAddress;
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: (opts) => createContext(opts, remoteIp),
  });
});
app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

// ─── Global Error Handlers ─────────────────────────────────────────
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", { error: err.message, stack: err.stack });
});
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", { reason: String(reason) });
});

// ─── Graceful Shutdown ─────────────────────────────────────────────
let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info("Graceful shutdown initiated", { signal });

  // Give in-flight requests time to complete (max 30s)
  const shutdownTimeout = setTimeout(() => {
    logger.error("Shutdown timeout exceeded, forcing exit");
    process.exit(1);
  }, 30_000);

  try {
    // Stop the worker gracefully, then close all queues/Redis. In-flight
    // "running" runs are intentionally left as-is: the DB-heal on next boot
    // resets them to "pending" and re-enqueues them. Same for design jobs
    // (lease expiry + reconciler heal).
    await stopSwarmWorker();
    await stopDesignWorker();
    await stopBenchmarkWorker();
    await closeAllQueues();
    logger.info("Shutdown: worker stopped and queues closed");
  } catch (err) {
    logger.error("Shutdown: failed to stop worker/queues", { error: (err as Error).message });
  }

  clearTimeout(shutdownTimeout);
  logger.info("Graceful shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

export default app;

if (env.isProduction) {
  const { serve } = await import("@hono/node-server");
  const { serveStaticFiles } = await import("./lib/vite");
  serveStaticFiles(app);

  const port = parseInt(process.env.PORT || "3000");
  serve({ fetch: app.fetch, port }, () => {
    logger.info("Server started", { port });
  });
}
