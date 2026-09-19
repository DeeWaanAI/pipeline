/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * FEEDBACK SCREENSHOT UPLOAD ROUTE (Raw HTTP POST)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dedicated endpoint for uploading feedback screenshots.
 * Bypasses tRPC entirely to handle large base64 images without
 * JSON serialization overhead or payload limits.
 *
 * POST /api/upload-screenshot
 *   Body: { image: "data:image/jpeg;base64,/9j/4AAQ..." }
 *   Returns: { id: "uuid", url: "/feedback-screenshots/uuid.jpg" }
 */

import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { verifyLocalToken } from "./routers/localAuth";
import { verifyScreenshotSignature } from "./lib/screenshotUrls";
import { basename } from "path";
import { eq } from "drizzle-orm";
import { users } from "@db/schema";
import { getDb } from "./queries/connection";
import { getStorage } from "./lib/storage";
import { getClientIp } from "./lib/clientIp";
import { checkRateLimitAsync, RATE_LIMITS } from "./lib/rateLimiter";
import { logger } from "./lib/logger";

const MAX_SIZE_MB = 5;

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function contentTypeFor(filename: string): string {
  const ext = filename.split(".").pop();
  return ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
}

export type ScreenshotReadAccess = "allow" | "unauthorized" | "forbidden";

/**
 * Pure access decision for the screenshot GET route (spec 0.9c).
 *
 *  - A valid file-scoped signed URL (?exp/&sig) authorizes anyone — owners
 *    receive server-pre-signed URLs from the listing procedures, and plain
 *    <img src> loads cannot send headers.
 *  - Otherwise the x-local-auth-token header path is ADMIN-ONLY:
 *    a valid non-admin token is authenticated but not allowed → "forbidden"
 *    (403); a missing or invalid/expired token → "unauthorized" (401).
 */
export function decideScreenshotReadAccess(input: {
  signedUrlValid: boolean;
  tokenPresent: boolean;
  tokenValid: boolean;
  isAdmin: boolean;
}): ScreenshotReadAccess {
  if (input.signedUrlValid) return "allow";
  if (!input.tokenPresent || !input.tokenValid) return "unauthorized";
  return input.isAdmin ? "allow" : "forbidden";
}

export function registerFeedbackScreenshotRoute(app: Hono<{ Bindings: HttpBindings }>) {
  // Serve uploaded screenshots (auth required). Reads through the storage
  // abstraction — S3-compatible object storage when configured, local disk
  // otherwise. Objects stay private: we proxy, never redirect.
  app.get("/feedback-screenshots/:filename", async (c) => {
    // Per-IP throttle in front of all auth/file work (spec 0.9d).
    const ip = getClientIp(c.req.raw.headers, c.env?.incoming?.socket?.remoteAddress);
    const rl = await checkRateLimitAsync(`screenshot-serve:${ip}`, RATE_LIMITS.screenshotServe);
    if (!rl.allowed) {
      c.header("Retry-After", String(Math.ceil(rl.retryAfterMs / 1000)));
      return c.json({ error: "Too many requests" }, 429);
    }

    // Auth — either:
    //  (a) ?exp=<ms>&sig=<hmac> — a short-lived, file-scoped signed URL
    //      (plain <img src> loads can't send headers). The session JWT is
    //      deliberately NOT accepted via query param: it would leak into
    //      server/proxy logs, browser history, and Referer headers.
    //  (b) x-local-auth-token header — ADMIN users only (spec 0.9c): this
    //      path authorizes ANY file, so it is no longer available to
    //      ordinary users. Non-admin token → 403; invalid/expired → 401.
    const filename = c.req.param("filename");
    const safeFilename = basename(filename); // strips any directory traversal

    const signedUrlValid = verifyScreenshotSignature(
      safeFilename,
      c.req.query("exp"),
      c.req.query("sig"),
    );

    let tokenPresent = false;
    let tokenValid = false;
    let isAdmin = false;
    const token = c.req.header("x-local-auth-token");
    if (!signedUrlValid && token) {
      tokenPresent = true;
      const claim = await verifyLocalToken(token);
      if (claim) {
        tokenValid = true;
        const [user] = await getDb()
          .select({ role: users.role })
          .from(users)
          .where(eq(users.id, claim.userId))
          .limit(1);
        isAdmin = user?.role === "admin";
      }
    }

    const access = decideScreenshotReadAccess({ signedUrlValid, tokenPresent, tokenValid, isAdmin });
    if (access === "unauthorized") {
      return c.json({ error: "Authentication required" }, 401);
    }
    if (access === "forbidden") {
      return c.json({ error: "Admin access required" }, 403);
    }

    try {
      const obj = await getStorage().get(safeFilename);
      if (!obj) return c.json({ error: "Not found" }, 404);
      return new Response(new Uint8Array(obj.body), {
        headers: { "Content-Type": obj.contentType ?? contentTypeFor(safeFilename) },
      });
    } catch (err) {
      logger.error("[Screenshot] Read failed", { filename: safeFilename, error: (err as Error).message });
      return c.json({ error: "Read failed" }, 500);
    }
  });

  // Upload endpoint
  app.post("/api/upload-screenshot", async (c) => {
    try {
      // Auth check — same as upload-route
      let userId: number | null = null;

      const localToken = c.req.header("x-local-auth-token");
      if (localToken) {
        const result = await verifyLocalToken(localToken);
        if (result) userId = result.userId;
      }

      if (!userId) {
        return c.json({ error: "Authentication required" }, 401);
      }

      // Per-user throttle (spec 0.9d). Auth runs first because the bucket
      // key needs the authenticated user id; the limit still lands before
      // the expensive part (parsing the multi-MB base64 body).
      const rl = await checkRateLimitAsync(`screenshot-upload:${userId}`, RATE_LIMITS.screenshotUpload);
      if (!rl.allowed) {
        c.header("Retry-After", String(Math.ceil(rl.retryAfterMs / 1000)));
        return c.json({ error: "Too many requests" }, 429);
      }

      // Parse body
      const body = await c.req.json().catch(() => null);
      if (!body || !body.image || typeof body.image !== "string") {
        return c.json({ error: "Missing 'image' field (base64 data URL expected)" }, 400);
      }

      // Validate it's a data URL
      const match = body.image.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
      if (!match) {
        return c.json({ error: "Invalid image format. Expected data:image/jpeg;base64,..." }, 400);
      }

      const format = match[1];
      const base64Data = match[2];

      // Check size
      const sizeBytes = Buffer.byteLength(base64Data, "base64");
      if (sizeBytes > MAX_SIZE_MB * 1024 * 1024) {
        return c.json({ error: `Image too large. Max: ${MAX_SIZE_MB}MB` }, 413);
      }

      // Decode and store (S3 when configured, local disk otherwise)
      const id = generateId();
      const filename = `${id}.${format}`;
      const buffer = Buffer.from(base64Data, "base64");
      await getStorage().put(filename, buffer, `image/${format}`);

      logger.info("[Screenshot] Saved", { filename, sizeBytes, backend: getStorage().kind });

      return c.json({
        id,
        url: `/feedback-screenshots/${filename}`,
        size: sizeBytes,
        format,
      });
    } catch (err) {
      logger.error("[Screenshot Upload] Error", { error: (err as Error).message });
      return c.json({ error: "Upload failed" }, 500);
    }
  });
}
