// ═══════════════════════════════════════════════════════════════════
//  MCP ROUTE REGISTRATION — OAuth server + /mcp* endpoints
// ═══════════════════════════════════════════════════════════════════
// Mounts:
//   - OAuth 2.1 authorization-server endpoints:
//     /.well-known/*, /oauth/*
//   - /mcp (POST/GET/DELETE) streamable HTTP transport
//   - /mcp/sse + /mcp/messages legacy SSE transport
//
// Everything under /mcp* requires a valid Bearer access token (401 +
// WWW-Authenticate challenge otherwise). The companion_mcp rollout flag
// was buried in the Final Sprint (2026-07-13): the surface is always on,
// protected by OAuth + per-customer rate limits + usage metering.

import type { Hono, MiddlewareHandler } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { logger } from "../lib/logger";
import { checkCustomerRateLimit, type CustomerTier } from "../lib/rateLimiter";
import { getDb } from "../queries/connection";
import { users, teamMembers, teamSeats } from "@db/schema";
import { eq, and, isNotNull, sql } from "drizzle-orm";
import { authenticate } from "./context";
import { registerOAuthRoutes } from "./auth";
import {
  handleMcpPost,
  handleMcpGet,
  handleMcpDelete,
  handleLegacySse,
  handleLegacyMessage,
} from "./transport";
import type { McpAuthContext } from "./types";

declare module "hono" {
  interface ContextVariableMap {
    mcpAuth: McpAuthContext;
  }
}

// ─── Per-customer rate-limit tier resolution (Phase 3) ─────────────
// solo (default) / team / admin. Resolved once per request and cached
// briefly in-process so high-frequency MCP traffic doesn't hit the DB on
// every call. "team" = user is a member of any team whose team_seats row
// carries a stripeSubscriptionId (billed team); "admin" = users.role='admin'.
const TIER_CACHE_TTL_MS = 60_000;
const TIER_CACHE_MAX = 10_000;
const tierCache = new Map<number, { tier: CustomerTier; expiry: number }>();

async function resolveCustomerTier(userId: number): Promise<CustomerTier> {
  const now = Date.now();
  const cached = tierCache.get(userId);
  if (cached && cached.expiry > now) return cached.tier;

  let tier: CustomerTier = "solo";
  try {
    // Single join: role + whether ANY team membership is billed. groupBy +
    // MAX collapses many memberships into one row so we only need .limit(1).
    const [row] = await getDb()
      .select({
        role: users.role,
        billedTeamId: sql<number | null>`MAX(${teamSeats.id})`,
      })
      .from(users)
      .leftJoin(teamMembers, eq(teamMembers.userId, users.id))
      .leftJoin(
        teamSeats,
        and(
          eq(teamSeats.teamId, teamMembers.teamId),
          isNotNull(teamSeats.stripeSubscriptionId),
        ),
      )
      .where(eq(users.id, userId))
      .groupBy(users.id)
      .limit(1);

    if (row?.role === "admin") tier = "admin";
    else if (row?.billedTeamId != null) tier = "team";
  } catch (err) {
    logger.warn("MCP: tier resolution failed — defaulting to solo", {
      userId,
      error: (err as Error).message,
    });
  }

  // Safety valve against unbounded growth on long-lived processes.
  if (tierCache.size >= TIER_CACHE_MAX) tierCache.clear();
  tierCache.set(userId, { tier, expiry: now + TIER_CACHE_TTL_MS });
  return tier;
}

const mcpGate: MiddlewareHandler<{ Bindings: HttpBindings }> = async (c, next) => {
  // Hono matches BOTH "/mcp" and "/mcp/*" for the bare /mcp path, so this
  // middleware executes twice per request. The second pass must be a no-op —
  // otherwise every request double-charges the per-customer rate limit.
  if (c.get("mcpAuth")) {
    await next();
    return;
  }

  const auth = await authenticate(c);
  if (!auth) {
    const host = c.req.header("host") ?? "localhost";
    c.header(
      "WWW-Authenticate",
      `Bearer resource_metadata="https://${host}/.well-known/oauth-protected-resource"`,
    );
    return c.json(
      { error: "unauthorized", error_description: "A valid Bearer access token is required" },
      401,
    );
  }

  // Per-customer rate limit (Phase 3). Runs after auth so only
  // authenticated callers consume budget. Fails OPEN (allows the
  // request) if the limiter itself errors, consistent with the app's
  // graceful-degradation stance.
  try {
    const tier = await resolveCustomerTier(auth.userId);
    const rl = await checkCustomerRateLimit(`mcp:${auth.userId}`, tier);
    if (!rl.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(rl.retryAfterMs / 1000));
      c.header("Retry-After", String(retryAfterSec));
      return c.json(
        {
          error: "rate_limit_exceeded",
          error_description: `Rate limit exceeded for tier "${tier}". Retry in ${retryAfterSec}s.`,
          tier,
          limit: rl.limit,
          retry_after: retryAfterSec,
        },
        429,
      );
    }
  } catch (err) {
    logger.error("MCP: rate-limit check failed — allowing request", {
      userId: auth.userId,
      error: (err as Error).message,
    });
  }

  c.set("mcpAuth", auth);
  await next();
};

export function registerMcpRoutes(app: Hono<{ Bindings: HttpBindings }>) {
  // OAuth 2.1 authorization server (public endpoints — no Bearer auth).
  registerOAuthRoutes(app);

  // Register both exact and wildcard paths: Hono's "/mcp/*" also matches the
  // bare "/mcp" path, so the gate runs twice there — the idempotency guard at
  // the top of mcpGate makes the second pass a no-op.
  app.use("/mcp", mcpGate);
  app.use("/mcp/*", mcpGate);

  // Streamable HTTP transport (MCP 2025-03-26)
  app.post("/mcp", (c) => handleMcpPost(c, c.get("mcpAuth")));
  app.get("/mcp", (c) => handleMcpGet(c, c.get("mcpAuth")));
  app.delete("/mcp", (c) => handleMcpDelete(c, c.get("mcpAuth")));

  // Legacy SSE transport (MCP 2024-11-05)
  app.get("/mcp/sse", (c) => handleLegacySse(c, c.get("mcpAuth")));
  app.post("/mcp/messages", (c) => handleLegacyMessage(c, c.get("mcpAuth")));

  logger.info("MCP routes registered (OAuth + streamable HTTP + legacy SSE)");
}
