// ═══════════════════════════════════════════════════════════════════
//  DEVICE AUTHORIZATION (V3 local-first, L3) — /api/device/*
// ═══════════════════════════════════════════════════════════════════
// OAuth 2.0 Device Flow, minimal: a local install (which has no password
// and no account of ours) links itself to a marketplace account.
//
//   POST /api/device/code    (public, rate-limited)
//     → { deviceCode, userCode, verificationUrl, expiresIn, interval }
//   POST /api/device/approve (authed: the marketplace account's JWT)
//     { userCode } → marks the code approved for that account
//   POST /api/device/token   (public; polled by the local install)
//     { deviceCode } → 428 { error: "authorization_pending" } until the
//     user approves, then 200 { token } (90d, type "device"). Single-use:
//     once exchanged, the device code is deleted.
//
// The verification page lives in the hosted web app at /link.

import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import crypto from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { deviceCodes, users } from "@db/schema";
import { getClientIp } from "./lib/clientIp";
import { checkRateLimitAsync, RATE_LIMITS } from "./lib/rateLimiter";
import { logger } from "./lib/logger";
import { signLocalToken, verifyLocalToken } from "./routers/localAuth";

const CODE_TTL_SECONDS = 600; // 10 minutes to approve
const POLL_INTERVAL_SECONDS = 3;

/** Human-typable code: unambiguous alphabet, grouped XXXX-XXXX. */
function userCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  const raw = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function hostedBaseUrl(): string {
  return process.env.HOSTED_WEB_URL || "https://app.deewaanai.com";
}

export function registerDeviceRoutes(app: Hono<{ Bindings: HttpBindings }>) {
  // ── 1. Local install requests a code ─────────────────────────────
  app.post("/api/device/code", async (c) => {
    const ip = getClientIp(c.req.raw.headers, c.env?.incoming?.socket?.remoteAddress);
    const rl = await checkRateLimitAsync(`device-code:${ip}`, RATE_LIMITS.auth);
    if (!rl.allowed) return c.json({ error: "rate_limited" }, 429);

    const db = getDb();
    // Opportunistic sweep of expired codes (cheap, keeps the table small).
    await db.delete(deviceCodes).where(lt(deviceCodes.expiresAt, new Date()));

    const row = {
      deviceCode: crypto.randomBytes(24).toString("base64url"),
      userCode: userCode(),
      status: "pending" as const,
      expiresAt: new Date(Date.now() + CODE_TTL_SECONDS * 1000),
    };
    await db.insert(deviceCodes).values(row);

    return c.json({
      deviceCode: row.deviceCode,
      userCode: row.userCode,
      verificationUrl: `${hostedBaseUrl()}/link?code=${row.userCode}`,
      expiresIn: CODE_TTL_SECONDS,
      interval: POLL_INTERVAL_SECONDS,
    });
  });

  // ── 2. Signed-in marketplace user approves a code ────────────────
  app.post("/api/device/approve", async (c) => {
    const token = c.req.header("x-local-auth-token");
    const claim = token ? await verifyLocalToken(token) : null;
    if (!claim) return c.json({ error: "unauthorized" }, 401);

    const body = await c.req.json().catch(() => ({}));
    const code = String(body.userCode ?? "").trim().toUpperCase();
    if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) {
      return c.json({ error: "invalid_code_format" }, 400);
    }

    const db = getDb();
    const [pending] = await db.select().from(deviceCodes)
      .where(and(eq(deviceCodes.userCode, code), eq(deviceCodes.status, "pending")))
      .limit(1);
    if (!pending || pending.expiresAt < new Date()) {
      return c.json({ error: "code_not_found_or_expired" }, 404);
    }

    await db.update(deviceCodes)
      .set({ status: "approved", userId: claim.userId })
      .where(eq(deviceCodes.id, pending.id));
    logger.info("device link approved", { userId: claim.userId });
    return c.json({ ok: true });
  });

  // ── 3. Local install polls for its token ─────────────────────────
  app.post("/api/device/token", async (c) => {
    const ip = getClientIp(c.req.raw.headers, c.env?.incoming?.socket?.remoteAddress);
    const rl = await checkRateLimitAsync(`device-token:${ip}`, RATE_LIMITS.auth);
    if (!rl.allowed) return c.json({ error: "rate_limited" }, 429);

    const body = await c.req.json().catch(() => ({}));
    const dc = String(body.deviceCode ?? "");
    if (!dc || dc.length > 64) return c.json({ error: "invalid_device_code" }, 400);

    const db = getDb();
    const [row] = await db.select().from(deviceCodes)
      .where(eq(deviceCodes.deviceCode, dc)).limit(1);
    if (!row) return c.json({ error: "authorization_pending" }, 428);
    if (row.expiresAt < new Date()) {
      await db.delete(deviceCodes).where(eq(deviceCodes.id, row.id));
      return c.json({ error: "expired_token" }, 410);
    }
    if (row.status === "denied") {
      await db.delete(deviceCodes).where(eq(deviceCodes.id, row.id));
      return c.json({ error: "access_denied" }, 403);
    }
    if (row.status !== "approved" || !row.userId) {
      return c.json({ error: "authorization_pending" }, 428);
    }

    // Single-use: exchange deletes the code.
    await db.delete(deviceCodes).where(eq(deviceCodes.id, row.id));
    const [user] = await db.select({ username: users.username }).from(users)
      .where(eq(users.id, row.userId)).limit(1);
    const token = await signLocalToken(row.userId, user?.username ?? "user", "90d", "device");
    logger.info("device link token issued", { userId: row.userId });
    return c.json({ token, tokenType: "device", expiresInDays: 90 });
  });
}
