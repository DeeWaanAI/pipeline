import { env } from "./env";

/**
 * Resolve the client IP for rate limiting.
 *
 * When `TRUSTED_PROXY` is true (the default — Railway's edge sanitizes/sets
 * the forwarding headers), the first entry of `x-forwarded-for` is the real
 * client IP. When false (app exposed directly to the internet), those headers
 * are attacker-controlled and MUST be ignored — the direct socket address is
 * used instead. If no socket address is available in that mode we fall back
 * to "unknown", which intentionally buckets all such callers together
 * (fail-closed: brute-force protection still holds, just shared).
 */
export interface ClientIpOptions {
  /** Override for tests; defaults to env.trustedProxy. */
  trustedProxy?: boolean;
}

export function getClientIp(
  headers: Headers,
  remoteAddress?: string | null,
  options?: ClientIpOptions,
): string {
  const trustedProxy = options?.trustedProxy ?? env.trustedProxy;

  if (trustedProxy) {
    return (
      headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      headers.get("x-real-ip") ||
      remoteAddress ||
      "unknown"
    );
  }

  return remoteAddress || "unknown";
}
