// ═══════════════════════════════════════════════════════════════════
//  ON-PREM RELAY — cloud side (Phase 3)
// ═══════════════════════════════════════════════════════════════════
// Lets data-residency / on-prem customers serve remote-only hosts (e.g.
// ChatGPT) without opening any inbound port. The on-prem connector
// (relay/connector.mjs) long-polls these endpoints over outbound HTTPS,
// executes each request against a LOCAL service, and posts the result back.
//
// Endpoints (ALL behind the `enterprise_relay` feature flag → 404 when off):
//   POST /api/relay/register   admin local-auth → mint a one-time relay token
//   GET  /api/relay/poll       relay-auth, long-poll oldest pending request
//   POST /api/relay/result     relay-auth, mark a request completed/failed
//   POST /api/relay/enqueue    admin local-auth, push a request (smoke/test)
//
// Relay tokens are opaque random strings stored SHA-256 hashed (same pattern
// as OAuth refresh tokens in services/tokenService). The raw token is shown
// exactly once at registration.
//
// Worker C wires this up in boot.ts with a single call:
//   import { registerRelayRoutes } from "./relay-route";
//   registerRelayRoutes(app);

import type { Context, Hono, MiddlewareHandler } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { createHash, randomBytes } from "crypto";
import { eq, and, asc } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { relayRegistrations, relayRequests, users } from "@db/schema";
import { verifyLocalToken } from "./routers/localAuth";
import { isFeatureEnabled } from "./plugins/featureFlags";
import { logger } from "./lib/logger";

const FLAG_KEY = "enterprise_relay";

// Long-poll bounds. The connector defaults to wait=25s; clamp generously.
const MAX_WAIT_SECONDS = 60;
const DEFAULT_WAIT_SECONDS = 25;

type App = Hono<{ Bindings: HttpBindings }>;
type Ctx = Context<{ Bindings: HttpBindings }>;
type Db = ReturnType<typeof getDb>;
type RelayRow = typeof relayRegistrations.$inferSelect;
type RelayRequestRow = typeof relayRequests.$inferSelect;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Feature-flag gate ──────────────────────────────────────────────
// Master switch for the whole relay surface. OFF → 404 (indistinguishable
// from an unmounted route). A flag-store failure denies by default but never
// breaks other routes.
const relayFlagGate: MiddlewareHandler<{ Bindings: HttpBindings }> = async (c, next) => {
  let enabled = false;
  try {
    enabled = await isFeatureEnabled(FLAG_KEY);
  } catch (err) {
    logger.error("Relay: feature-flag check failed — denying", { error: (err as Error).message });
  }
  if (!enabled) return c.notFound();
  await next();
};

// ─── Admin auth (local-auth token + role check) ─────────────────────
// Accepts the standard x-local-auth-token header (canonical) and, as a
// convenience for scripting/smoke tests, Authorization: Bearer <jwt>.
type AdminResult = { userId: number; username: string } | "unauthenticated" | "forbidden";

async function resolveAdmin(c: Ctx): Promise<AdminResult> {
  const bearer = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const token = c.req.header("x-local-auth-token") ?? bearer;
  if (!token) return "unauthenticated";

  const claim = await verifyLocalToken(token);
  if (!claim?.userId) return "unauthenticated";

  try {
    const [user] = await getDb()
      .select({ id: users.id, role: users.role, username: users.username })
      .from(users)
      .where(eq(users.id, claim.userId))
      .limit(1);
    if (!user) return "unauthenticated";
    if (user.role !== "admin") return "forbidden";
    return { userId: user.id, username: user.username ?? "admin" };
  } catch (err) {
    logger.error("Relay: admin user lookup failed", { error: (err as Error).message });
    return "unauthenticated";
  }
}

// ─── Relay auth (Bearer relay token → hash lookup) ──────────────────
// Verifies the token, requires status=active, and bumps last_seen_at
// (fire-and-forget so a slow write never delays a poll).
async function authenticateRelay(c: Ctx): Promise<RelayRow | null> {
  const token = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;

  const tokenHash = sha256Hex(token);
  const db = getDb();
  try {
    const [relay] = await db
      .select()
      .from(relayRegistrations)
      .where(eq(relayRegistrations.tokenHash, tokenHash))
      .limit(1);
    if (!relay || relay.status !== "active") return null;

    void (async () => {
      try {
        await db
          .update(relayRegistrations)
          .set({ lastSeenAt: new Date() })
          .where(eq(relayRegistrations.id, relay.id));
      } catch (err) {
        logger.debug("Relay: last_seen bump failed", { relayId: relay.id, error: (err as Error).message });
      }
    })();

    return relay;
  } catch (err) {
    logger.error("Relay: token lookup failed", { error: (err as Error).message });
    return null;
  }
}

// Atomically claim the oldest pending request for a relay. Returns null when
// none is pending or a concurrent claim won the race (caller re-polls).
async function claimOldestPending(db: Db, relayId: number): Promise<RelayRequestRow | null> {
  const [row] = await db
    .select()
    .from(relayRequests)
    .where(and(eq(relayRequests.relayId, relayId), eq(relayRequests.status, "pending")))
    .orderBy(asc(relayRequests.id))
    .limit(1);
  if (!row) return null;

  const res = await db
    .update(relayRequests)
    .set({ status: "claimed", claimedAt: new Date() })
    .where(and(eq(relayRequests.id, row.id), eq(relayRequests.status, "pending")));
  const affected = Array.isArray(res)
    ? (res[0] as { affectedRows?: number })?.affectedRows
    : (res as { affectedRows?: number })?.affectedRows;
  if (!affected) return null;
  return row;
}

// ─── Route registration ─────────────────────────────────────────────
export function registerRelayRoutes(app: App) {
  // Flag gate runs first so every relay endpoint 404s when the feature is off.
  app.use("/api/relay/*", relayFlagGate);

  // ── POST /api/relay/register (admin) ──────────────────────────────
  // Mint a new relay registration. Returns the raw token ONCE; only its
  // SHA-256 hash is persisted.
  app.post("/api/relay/register", async (c) => {
    const admin = await resolveAdmin(c);
    if (admin === "unauthenticated") {
      return c.json({ error: "unauthorized", error_description: "A valid admin token is required" }, 401);
    }
    if (admin === "forbidden") {
      return c.json({ error: "forbidden", error_description: "Admin role required" }, 403);
    }

    let body: { name?: unknown };
    try {
      body = (await c.req.json()) as { name?: unknown };
    } catch {
      return c.json({ error: "invalid_request", error_description: "Body must be valid JSON" }, 400);
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return c.json({ error: "invalid_request", error_description: "name is required" }, 400);
    }

    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = sha256Hex(rawToken);

    let relayId: number;
    try {
      const [inserted] = await getDb().insert(relayRegistrations).values({
        name,
        tokenHash,
        ownerUserId: admin.userId,
        status: "active",
      });
      relayId = Number(inserted.insertId);
    } catch (err) {
      logger.error("Relay: registration insert failed", { name, error: (err as Error).message });
      return c.json({ error: "internal_error", error_description: "Could not register relay" }, 500);
    }

    logger.info("Relay registered", { relayId, name, ownerUserId: admin.userId });
    return c.json(
      {
        relayId,
        name,
        // Shown exactly once — store it as RELAY_TOKEN on the connector.
        token: rawToken,
        pollUrl: "/api/relay/poll",
        resultUrl: "/api/relay/result",
      },
      201,
    );
  });

  // ── GET /api/relay/poll?wait=25 (relay-auth, long-poll) ───────────
  // Returns the oldest pending request (marked claimed), or 204 after the
  // wait window elapses with no work.
  app.get("/api/relay/poll", async (c) => {
    const relay = await authenticateRelay(c);
    if (!relay) {
      return c.json({ error: "unauthorized", error_description: "A valid relay token is required" }, 401);
    }

    const rawWait = parseInt(c.req.query("wait") ?? "", 10);
    const waitSec = Number.isNaN(rawWait)
      ? DEFAULT_WAIT_SECONDS
      : Math.min(Math.max(rawWait, 0), MAX_WAIT_SECONDS);
    const deadline = Date.now() + waitSec * 1000;
    const db = getDb();

    for (;;) {
      const claimed = await claimOldestPending(db, relay.id);
      if (claimed) {
        return c.json({
          requestId: claimed.id,
          kind: claimed.kind,
          payload: claimed.payloadJson,
          createdAt: claimed.createdAt,
        });
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return c.body(null, 204);
      await sleep(Math.min(1000, remaining));
    }
  });

  // ── POST /api/relay/result (relay-auth) ───────────────────────────
  // Mark a claimed request completed (with result) or failed (with error).
  app.post("/api/relay/result", async (c) => {
    const relay = await authenticateRelay(c);
    if (!relay) {
      return c.json({ error: "unauthorized", error_description: "A valid relay token is required" }, 401);
    }

    let body: { requestId?: unknown; result?: unknown; error?: unknown };
    try {
      body = (await c.req.json()) as { requestId?: unknown; result?: unknown; error?: unknown };
    } catch {
      return c.json({ error: "invalid_request", error_description: "Body must be valid JSON" }, 400);
    }

    const requestId = Number(body.requestId);
    if (!requestId || Number.isNaN(requestId)) {
      return c.json({ error: "invalid_request", error_description: "requestId is required" }, 400);
    }

    const db = getDb();
    // Only touch a request that belongs to THIS relay (prevents cross-relay writes).
    const [req] = await db
      .select({ id: relayRequests.id })
      .from(relayRequests)
      .where(and(eq(relayRequests.id, requestId), eq(relayRequests.relayId, relay.id)))
      .limit(1);
    if (!req) {
      return c.json({ error: "not_found", error_description: "Unknown request for this relay" }, 404);
    }

    const error = typeof body.error === "string" && body.error.length > 0 ? body.error : null;
    const status = error ? "failed" : "completed";
    try {
      await db
        .update(relayRequests)
        .set({
          status,
          resultJson: error ? null : body.result ?? null,
          error,
          completedAt: new Date(),
        })
        .where(eq(relayRequests.id, requestId));
    } catch (err) {
      logger.error("Relay: result update failed", { requestId, error: (err as Error).message });
      return c.json({ error: "internal_error", error_description: "Could not record result" }, 500);
    }

    logger.info("Relay request resolved", { requestId, relayId: relay.id, status });
    return c.json({ ok: true, requestId, status });
  });

  // ── POST /api/relay/enqueue (admin, smoke/testing) ────────────────
  // Push a pending request for a relay. kind `http_proxy` payloads look like
  // { method, path, body } and are executed by the connector against LOCAL_URL.
  app.post("/api/relay/enqueue", async (c) => {
    const admin = await resolveAdmin(c);
    if (admin === "unauthenticated") {
      return c.json({ error: "unauthorized", error_description: "A valid admin token is required" }, 401);
    }
    if (admin === "forbidden") {
      return c.json({ error: "forbidden", error_description: "Admin role required" }, 403);
    }

    let body: { relayId?: unknown; kind?: unknown; payload?: unknown };
    try {
      body = (await c.req.json()) as { relayId?: unknown; kind?: unknown; payload?: unknown };
    } catch {
      return c.json({ error: "invalid_request", error_description: "Body must be valid JSON" }, 400);
    }

    const relayId = Number(body.relayId);
    const kind = typeof body.kind === "string" ? body.kind.trim() : "";
    if (!relayId || Number.isNaN(relayId)) {
      return c.json({ error: "invalid_request", error_description: "relayId is required" }, 400);
    }
    if (!kind) {
      return c.json({ error: "invalid_request", error_description: "kind is required" }, 400);
    }

    const db = getDb();
    const [relay] = await db
      .select({ id: relayRegistrations.id })
      .from(relayRegistrations)
      .where(eq(relayRegistrations.id, relayId))
      .limit(1);
    if (!relay) {
      return c.json({ error: "not_found", error_description: "Unknown relayId" }, 404);
    }

    let requestId: number;
    try {
      const [inserted] = await db.insert(relayRequests).values({
        relayId,
        kind,
        payloadJson: body.payload ?? {},
        status: "pending",
      });
      requestId = Number(inserted.insertId);
    } catch (err) {
      logger.error("Relay: enqueue insert failed", { relayId, kind, error: (err as Error).message });
      return c.json({ error: "internal_error", error_description: "Could not enqueue request" }, 500);
    }

    logger.info("Relay request enqueued", { requestId, relayId, kind, by: admin.userId });
    return c.json({ requestId, relayId, kind, status: "pending" }, 201);
  });

  logger.info("Relay routes registered (behind enterprise_relay flag)");
}
