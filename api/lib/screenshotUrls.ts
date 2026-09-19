// Short-lived, file-scoped signed URLs for feedback screenshots.
//
// Why: <img> tags can't send auth headers, and putting the 7-day session JWT
// in a query param leaks it into server/proxy logs, browser history, and
// Referer headers. Instead, list endpoints decorate screenshot paths with
// ?exp=<epochMs>&sig=<hmac> where sig = HMAC-SHA256("<filename>.<exp>").
// The signature authorizes ONE file, expires in 15 minutes, and reveals
// nothing about the session. Header auth on the GET route is unchanged, so
// API clients are unaffected.

import { createHash, createHmac, timingSafeEqual } from "crypto";
import { basename } from "path";
import { env } from "./env";

export const SCREENSHOT_URL_TTL_MS = 15 * 60 * 1000; // 15 minutes
const PREFIX = "/feedback-screenshots/";

function key(): Buffer {
  return createHash("sha256").update(env.appSecret).digest();
}

function signature(filename: string, exp: number): string {
  return createHmac("sha256", key()).update(`${filename}.${exp}`).digest("hex");
}

/**
 * Decorate a stored screenshot path with a short-lived signature.
 * Non-screenshot URLs pass through unchanged (defensive — mirrors the
 * previous frontend guard).
 */
export function signScreenshotUrl(rawUrl: string, nowMs: number = Date.now()): string {
  if (!rawUrl.startsWith(PREFIX)) return rawUrl;
  const filename = basename(rawUrl);
  const exp = nowMs + SCREENSHOT_URL_TTL_MS;
  return `${PREFIX}${filename}?exp=${exp}&sig=${signature(filename, exp)}`;
}

/** Verify exp/sig query params from the screenshot GET route (timing-safe). */
export function verifyScreenshotSignature(
  filename: string,
  exp: unknown,
  sig: unknown,
  nowMs: number = Date.now(),
): boolean {
  const expNum = typeof exp === "string" ? Number(exp) : NaN;
  if (!Number.isFinite(expNum) || expNum <= nowMs) return false;
  if (typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const expected = Buffer.from(signature(basename(filename), expNum), "hex");
  const provided = Buffer.from(sig, "hex");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
