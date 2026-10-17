import { z } from "zod";
import bcrypt from "bcryptjs";
import * as jose from "jose";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { users } from "@db/schema";
import { eq, count } from "drizzle-orm";
import { env } from "../lib/env";
import { checkRateLimitAsync, RATE_LIMITS } from "../lib/rateLimiter";
import { getClientIp } from "../lib/clientIp";
import { logger } from "../lib/logger";

const SECRET = () => new TextEncoder().encode(env.appSecret);

// Trivial-password blocklist (all lowercase; compared case-insensitively).
// Applied at signup only — existing users are unaffected (login untouched).
const TRIVIAL_PASSWORDS = [
  "password", "password1", "12345678", "123456789", "qwerty123", "qwertyuiop",
  "iloveyou", "11111111", "abc12345", "letmein123", "welcome123", "admin1234",
  "changeme1", "87654321", "00000000", "deewaanai",
];

function dbErr(err: unknown): never {
  const m = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: Error }).cause;
  const causeMsg = cause?.message ?? "";
  const fullMsg = causeMsg ? `${m} | Cause: ${causeMsg}` : m;

  if (fullMsg.includes("ECONNREFUSED") || fullMsg.includes("connect") || fullMsg.includes("socket")) {
    throw new Error("Database not connected. Run: docker compose up -d && npm run db:push");
  }
  if (fullMsg.includes(" Unknown column") || fullMsg.includes("doesn't exist")) {
    throw new Error(`Database schema out of sync. Run: npm run db:push | ${causeMsg}`);
  }
  throw new Error(fullMsg);
}

export async function signLocalToken(
  userId: number,
  username: string,
  expiresIn = "7d",
  tokenType: "local" | "device" = "local",
): Promise<string> {
  return new jose.SignJWT({ userId, username, type: tokenType })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(SECRET());
}

export async function verifyLocalToken(token: string): Promise<{ userId: number; username: string } | null> {
  try {
    const { payload } = await jose.jwtVerify(token, SECRET(), { clockTolerance: 60 });
    // "local" = interactive login (7d); "device" = device-flow link token
    // issued to a local install (90d, V3 L3). Same trust domain, same secret.
    if (!payload.userId || (payload.type !== "local" && payload.type !== "device")) return null;
    return { userId: payload.userId as number, username: payload.username as string };
  } catch {
    return null;
  }
}

// Client-IP resolution for rate limiting lives in api/lib/clientIp.ts — it
// honors TRUSTED_PROXY (env.ts) and falls back to the direct socket address
// (ctx.remoteIp) when no trusted edge proxy is in front of the app.

/** The only `users` columns that may cross to the browser: the SPA reads id,
 *  name and role (plus username, which login and signup already hand back).
 *  Anything added here is published to every logged-in client, so a secret
 *  column — `passwordHash` above all — must never be listed. */
export const PUBLIC_USER_COLUMNS = {
  id: users.id,
  username: users.username,
  name: users.name,
  role: users.role,
} as const;

export async function readSessionUser(
  token: string | null,
): Promise<{ id: number; username: string | null; name: string | null; role: string | null } | null> {
  if (!token) return null;
  const claim = await verifyLocalToken(token);
  if (!claim) return null;
  try {
    const [user] = await getDb()
      .select(PUBLIC_USER_COLUMNS)
      .from(users)
      .where(eq(users.id, claim.userId))
      .limit(1);
    return user ?? null;
  } catch { return null; }
}

export const localAuthRouter = createRouter({
  signup: publicQuery
    .input(z.object({
      username: z.string().min(3).max(50),
      password: z.string().min(8).max(100),
      name: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      // Rate limit: 5 signups per minute per IP
      const ip = getClientIp(ctx.req.headers, ctx.remoteIp);
      const rl = await checkRateLimitAsync(`signup:${ip}`, RATE_LIMITS.auth);
      if (!rl.allowed) {
        throw new Error(`Too many signup attempts. Try again in ${Math.ceil(rl.retryAfterMs / 1000)}s.`);
      }

      // Password policy: reject trivial/common passwords before hashing
      // (blocklist is lowercase; comparison is case-insensitive).
      if (TRIVIAL_PASSWORDS.includes(input.password.toLowerCase())) {
        throw new Error("Password is too common — choose a stronger one.");
      }

      try {
        const db = getDb();
        const existing = await db.select().from(users).where(eq(users.username, input.username)).limit(1);
        if (existing[0]) throw new Error("Username already taken");

        const hash = await bcrypt.hash(input.password, 10);
        await db.insert(users).values({
          username: input.username,
          passwordHash: hash,
          name: input.name || input.username,
          role: "user",
        });

        const [created] = await db.select().from(users).where(eq(users.username, input.username)).limit(1);
        if (!created) throw new Error("User creation failed");

        // ─── Auto-admin bootstrap ───────────────────────────────────
        // Promote the user to admin if:
        //   (a) they are the very first user in the system (bootstrap convenience), OR
        //   (b) their username matches the AUTO_ADMIN_USERNAME env var (manual override).
        // This is a dev/beta convenience; production deployments should set roles explicitly.
        let role = created.role;
        const autoAdminUsername = process.env.AUTO_ADMIN_USERNAME?.trim();
        const isAutoAdminMatch = autoAdminUsername && created.username === autoAdminUsername;
        if (isAutoAdminMatch) {
          logger.warn(`[AUTO-ADMIN] Promoting user "${created.username}" to admin (matched AUTO_ADMIN_USERNAME env var)`);
          await db.update(users).set({ role: "admin" }).where(eq(users.id, created.id));
          role = "admin";
        } else {
          const [userCount] = await db.select({ count: count() }).from(users);
          if (userCount?.count === 1) {
            logger.warn(`[AUTO-ADMIN] Promoting first-ever user "${created.username}" to admin`);
            await db.update(users).set({ role: "admin" }).where(eq(users.id, created.id));
            role = "admin";
          }
        }

        logger.info("User signed up", { userId: created.id, username: created.username, role });
        const token = await signLocalToken(created.id, created.username ?? "user");
        return { token, user: { id: created.id, name: created.name, username: created.username, role } };
      } catch (e) { dbErr(e); }
    }),

  login: publicQuery
    .input(z.object({ username: z.string(), password: z.string() }))
    .mutation(async ({ input, ctx }) => {
      // Rate limit: 5 login attempts per minute per IP
      const ip = getClientIp(ctx.req.headers, ctx.remoteIp);
      const rl = await checkRateLimitAsync(`login:${ip}`, RATE_LIMITS.auth);
      if (!rl.allowed) {
        throw new Error(`Too many login attempts. Try again in ${Math.ceil(rl.retryAfterMs / 1000)}s.`);
      }

      try {
        const db = getDb();
        const [user] = await db.select().from(users).where(eq(users.username, input.username)).limit(1);
        if (!user?.passwordHash) throw new Error("Invalid username or password");

        const valid = await bcrypt.compare(input.password, user.passwordHash);
        if (!valid) throw new Error("Invalid username or password");

        await db.update(users).set({ lastSignInAt: new Date() }).where(eq(users.id, user.id));

        // Auto-admin bootstrap: if this user matches AUTO_ADMIN_USERNAME, ensure
        // they always have admin role on login (re-promotes after accidental demotion).
        let role = user.role;
        const autoAdminUsername = process.env.AUTO_ADMIN_USERNAME?.trim();
        if (autoAdminUsername && user.username === autoAdminUsername && role !== "admin") {
          logger.warn(`[AUTO-ADMIN] Re-promoting user "${user.username}" to admin on login`);
          await db.update(users).set({ role: "admin" }).where(eq(users.id, user.id));
          role = "admin";
        }

        logger.info("User logged in", { userId: user.id, username: user.username, role });
        const token = await signLocalToken(user.id, user.username ?? "user");
        return { token, user: { id: user.id, name: user.name, username: user.username, role } };
      } catch (e) { dbErr(e); }
    }),

  me: publicQuery.query(async ({ ctx }) => {
    // A bare `select()` here returned the whole `users` row — bcrypt hash and
    // all — to whoever held the token. readSessionUser() lists the columns.
    return readSessionUser(ctx.req.headers.get("x-local-auth-token"));
  }),

  // `setTier` and `devTierSwitch` were removed with the tier ladder (owner
  // decision 2026-09-22). There is no plan to switch to, so the dev-only
  // mutation that wrote `users.tier` is gone; the column stays in the
  // database untouched and unread (additive-only rule).
});
