// Short-lived, run-scoped signed URLs for the pipeline SSE stream.
//
// Why: EventSource cannot set headers, so the only way a browser can authorize
// `/api/stream/:runId` is through the URL. The 7-day session token must not go
// there — it would land in nginx access logs, browser history and Referer
// headers, and it authorizes EVERYTHING. Instead the client asks an
// authenticated endpoint for a signature over ONE run id, valid for an hour.
//
// Same shape as `screenshotUrls.ts`: HMAC-SHA256 over `<runId>.<userId>.<exp>`
// keyed by APP_SECRET, timing-safe compare, expiry checked server-side.

import { createHash, createHmac, timingSafeEqual } from "crypto";
import { env } from "./env";

export const STREAM_URL_TTL_MS = 60 * 60 * 1000; // 1 hour: a long pipeline plus reconnects

function key(): Buffer {
  return createHash("sha256").update(env.appSecret).digest();
}

function signature(swarmRunId: number, userId: number, exp: number): string {
  return createHmac("sha256", key()).update(`${swarmRunId}.${userId}.${exp}`).digest("hex");
}

export function signStreamPath(swarmRunId: number, userId: number, nowMs: number = Date.now()): string {
  const exp = nowMs + STREAM_URL_TTL_MS;
  return `/api/stream/${swarmRunId}?userId=${userId}&exp=${exp}&sig=${signature(swarmRunId, userId, exp)}`;
}

/** True when `sig` authorizes exactly this (run, user) pair until `exp`. */
export function verifyStreamSignature(
  swarmRunId: number,
  userId: number,
  exp: unknown,
  sig: unknown,
  nowMs: number = Date.now(),
): boolean {
  const expNum = typeof exp === "string" ? Number(exp) : NaN;
  if (!Number.isFinite(expNum) || expNum <= nowMs) return false;
  if (typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const expected = Buffer.from(signature(swarmRunId, userId, expNum), "hex");
  const provided = Buffer.from(sig, "hex");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
