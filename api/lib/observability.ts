// ═══════════════════════════════════════════════════════════════════
//  OBSERVABILITY — Sentry bootstrap (F0)
// ═══════════════════════════════════════════════════════════════════
// Best-effort error reporting. When SENTRY_DSN is empty the SDK is never
// imported. Every failure path is swallowed so observability can never take
// down the server.

import { env } from "./env";
import { logger } from "./logger";

type SentryModule = typeof import("@sentry/node");

// Holds the loaded SDK only after a successful init; null otherwise.
let sentry: SentryModule | null = null;

/** Initialize Sentry when a DSN is configured. Never throws. */
export async function initObservability(): Promise<void> {
  try {
    if (!env.sentryDsn) {
      logger.info("Sentry disabled");
      return;
    }
    const environment = env.isProduction ? "production" : "development";
    const mod: SentryModule = await import("@sentry/node");
    mod.init({ dsn: env.sentryDsn, environment });
    sentry = mod;
    logger.info("Sentry initialized", { environment });
  } catch (err) {
    logger.warn("Observability init failed — continuing without Sentry", {
      error: (err as Error).message,
    });
  }
}
