// ═══════════════════════════════════════════════════════════════════
//  WAITLIST ENDPOINTS (Wave W, Pioneer 100) — /api/waitlist/*
// ═══════════════════════════════════════════════════════════════════
// Public, unauthenticated contract consumed by the marketing site
// (DeeWaanAI-Next/WEBSITE-SPEC.md §6):
//
//   POST /api/waitlist/join   { email, role, ref } →
//     201 { position, referralCode }
//     409 { error: "already_joined", position, referralCode }  (treat as success)
//   GET  /api/waitlist/count  → 200 { claimed }
//
// Abuse controls: per-IP rate limit on join (token bucket via Redis with
// in-memory fallback), strict email/role validation, referral codes are
// random (not enumerable). Position = 1-based insertion rank.

import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { cors } from "hono/cors";
import { eq, sql } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { waitlistEntries } from "@db/schema";
import { logger } from "./lib/logger";
import { getClientIp } from "./lib/clientIp";
import { checkRateLimitAsync, RATE_LIMITS } from "./lib/rateLimiter";
import { env } from "./lib/env";
import {
  normalizeEmail,
  isValidEmail,
  generateReferralCode,
  isWaitlistRole,
} from "./lib/waitlist";

async function positionOf(entryId: number): Promise<number> {
  const [{ n }] = await getDb()
    .select({ n: sql<number>`COUNT(*)` })
    .from(waitlistEntries)
    .where(sql`${waitlistEntries.id} <= ${entryId}`);
  return Math.max(1, Number(n));
}

export function registerWaitlistRoute(app: Hono<{ Bindings: HttpBindings }>) {
  // Browser CORS: the static marketing site calls these endpoints
  // cross-origin. Public, unauthenticated, cookie-free — "*" is acceptable
  // (default); tighten via WAITLIST_CORS_ORIGINS once the domain is final.
  const origins = env.waitlistCorsOrigins.split(",").map((o) => o.trim()).filter(Boolean);
  app.use(
    "/api/waitlist/*",
    cors({
      origin: origins.length === 1 ? origins[0] : origins,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["content-type"],
      maxAge: 3600,
    }),
  );

  app.post("/api/waitlist/join", async (c) => {
    const ip = getClientIp(c.req.raw.headers, c.env?.incoming?.socket?.remoteAddress);
    const rl = await checkRateLimitAsync(`waitlist-join:${ip}`, RATE_LIMITS.auth);
    if (!rl.allowed) {
      return c.json(
        { error: "rate_limited", message: `Too many attempts. Try again in ${Math.ceil(rl.retryAfterMs / 1000)}s.` },
        429,
        { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      );
    }

    let body: { email?: unknown; role?: unknown; ref?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_body", message: "Send JSON: { email, role, ref? }" }, 400);
    }

    const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
    if (!isValidEmail(email)) {
      return c.json({ error: "invalid_email", message: "Please enter a valid email address." }, 400);
    }
    if (!isWaitlistRole(body.role)) {
      return c.json({ error: "invalid_role", message: "Role must be creator, user, or both." }, 400);
    }
    const ref = typeof body.ref === "string" && body.ref.length > 0 && body.ref.length <= 64
      ? body.ref
      : null;

    const db = getDb();
    // Insert (retry once on the astronomically rare referral-code collision).
    for (let attempt = 0; attempt < 2; attempt++) {
      const referralCode = generateReferralCode();
      try {
        const [result] = await db.insert(waitlistEntries).values({
          email, role: body.role, ref, referralCode,
        });
        const id = Number(result.insertId);
        const position = await positionOf(id);
        logger.info("Waitlist joined", { position, role: body.role, hasRef: !!ref });
        return c.json({ position, referralCode }, 201);
      } catch (err) {
        const e = err as { code?: string; cause?: { code?: string }; message?: string };
        const code = e.code ?? e.cause?.code ?? "";
        if (code === "ER_DUP_ENTRY") {
          if ((e.message ?? "").includes("uq_waitlist_referral_code") && attempt === 0) continue;
          // Email already joined → 409 per contract, treated as success by the site.
          const [existing] = await db.select().from(waitlistEntries)
            .where(eq(waitlistEntries.email, email)).limit(1);
          if (existing) {
            return c.json({
              error: "already_joined",
              position: await positionOf(existing.id),
              referralCode: existing.referralCode,
            }, 409);
          }
        }
        throw err;
      }
    }
    return c.json({ error: "try_again", message: "Something went wrong — please try again." }, 500);
  });

  app.get("/api/waitlist/count", async (c) => {
    const [{ n }] = await getDb()
      .select({ n: sql<number>`COUNT(*)` })
      .from(waitlistEntries);
    return c.json({ claimed: Number(n) }, 200, {
      // Short shared cache: the counter is public and non-personalized.
      "Cache-Control": "public, max-age=60",
    });
  });
}
