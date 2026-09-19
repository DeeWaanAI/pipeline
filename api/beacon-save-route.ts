/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * BEACON SAVE-PREFERENCES ROUTE (Raw HTTP POST)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dedicated endpoint for navigator.sendBeacon() calls that persist
 * user preferences (chat messages, UI state) on page unload.
 *
 * sendBeacon cannot set custom headers, so auth token is read from
 * the query string instead of the x-local-auth-token header.
 *
 * POST /api/beacon/save-preferences?token=<jwt>
 *   Body: { preferences: { savedMessages: {...}, uiState: {...}, ... } }
 *   Returns: { ok: true }
 */

import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { verifyLocalToken } from "./routers/localAuth";
import { getDb } from "./queries/connection";
import { users } from "@db/schema";
import { eq } from "drizzle-orm";
import { logger } from "./lib/logger";

const MAX_BODY_SIZE = 2 * 1024 * 1024; // 2MB — preferences can be large with chat history

// ─── Auth helper (token from query string for sendBeacon compat) ──
async function getAuthUserFromQuery(req: Request) {
  // Primary: query-string token (sendBeacon path)
  const url = new URL(req.url);
  const queryToken = url.searchParams.get("token");
  if (queryToken) {
    const claim = await verifyLocalToken(queryToken);
    if (claim) {
      const [user] = await getDb()
        .select()
        .from(users)
        .where(eq(users.id, claim.userId))
        .limit(1);
      if (user) return user;
    }
  }
  // Fallback: header (in case a normal fetch is used instead of sendBeacon)
  const headerToken = req.headers.get("x-local-auth-token");
  if (headerToken) {
    const claim = await verifyLocalToken(headerToken);
    if (claim) {
      const [user] = await getDb()
        .select()
        .from(users)
        .where(eq(users.id, claim.userId))
        .limit(1);
      if (user) return user;
    }
  }
  return null;
}

export function registerBeaconSaveRoute(app: Hono<{ Bindings: HttpBindings }>) {
  app.post("/api/beacon/save-preferences", async (c) => {
    // ─── Auth ───
    const user = await getAuthUserFromQuery(c.req.raw);
    if (!user) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // ─── Parse JSON body ───
    let body: { preferences?: Record<string, unknown> };
    try {
      // sendBeacon sends as Blob with application/json type
      const text = await c.req.text();
      if (!text || text.length === 0) {
        return c.json({ error: "Empty body" }, 400);
      }
      if (text.length > MAX_BODY_SIZE) {
        return c.json({ error: "Body too large" }, 413);
      }
      body = JSON.parse(text);
    } catch (err) {
      logger.error("Beacon JSON parse failed", { error: (err as Error).message });
      return c.json({ error: "Invalid JSON" }, 400);
    }

    if (!body.preferences) {
      return c.json({ error: "Missing preferences field" }, 400);
    }

    // ─── Save to DB ───
    try {
      await getDb()
        .update(users)
        .set({ preferences: body.preferences })
        .where(eq(users.id, user.id));

      return c.json({ ok: true });
    } catch (err) {
      logger.error("Beacon DB write failed", { error: (err as Error).message });
      return c.json({ error: "Save failed" }, 500);
    }
  });
}
