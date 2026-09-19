// ═══════════════════════════════════════════════════════════════════
//  ADMIN BACKUP ENDPOINT (Batch A) — POST /api/admin/backup
// ═══════════════════════════════════════════════════════════════════
// Triggers a mysqldump → gzip → S3 backup (api/services/backup.ts). Called
// daily by the GitHub Actions cron (.github/workflows/backup.yml); can also
// be wired to Railway cron or invoked manually:
//
//   curl -X POST -H "Authorization: Bearer $BACKUP_TOKEN" \
//     https://<host>/api/admin/backup
//
// Auth: dedicated BACKUP_TOKEN bearer (constant-time compared), NOT a user
// session — cron callers have no login. 503 when backups are not configured
// (token or S3 missing). Rate-limited per IP as a second layer.

import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { timingSafeEqual } from "crypto";
import { env } from "./lib/env";
import { logger } from "./lib/logger";
import { getClientIp } from "./lib/clientIp";
import { checkRateLimitAsync, RATE_LIMITS } from "./lib/rateLimiter";
import { isBackupConfigured, runBackup } from "./services/backup";

function tokenOk(provided: string): boolean {
  const expected = Buffer.from(env.backupToken);
  const actual = Buffer.from(provided);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function registerBackupRoute(app: Hono<{ Bindings: HttpBindings }>) {
  app.post("/api/admin/backup", async (c) => {
    if (!isBackupConfigured()) {
      return c.json(
        { error: "Backups not configured (BACKUP_TOKEN and S3_* required)" },
        503,
      );
    }

    // Second layer: per-IP throttle in front of the token check.
    const ip = getClientIp(c.req.raw.headers, c.env?.incoming?.socket?.remoteAddress);
    const rl = await checkRateLimitAsync(`backup:${ip}`, RATE_LIMITS.auth);
    if (!rl.allowed) {
      c.header("Retry-After", String(Math.ceil(rl.retryAfterMs / 1000)));
      return c.json({ error: "Too many requests" }, 429);
    }

    const auth = c.req.header("authorization") ?? "";
    const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!provided || !tokenOk(provided)) {
      logger.warn("Backup: rejected unauthorized trigger", { ip });
      return c.json({ error: "Unauthorized" }, 401);
    }

    try {
      const result = await runBackup();
      return c.json({ ok: true, ...result });
    } catch (err) {
      logger.error("Backup: run failed", { error: (err as Error).message });
      // Generic message outward — details stay in the logs.
      return c.json({ ok: false, error: "Backup failed" }, 500);
    }
  });
}
