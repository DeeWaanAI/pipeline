import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value ?? "";
}

// Refuse to boot with known insecure secrets in production
function validateSecret(name: string, value: string, forbidden: string[]): void {
  if (process.env.NODE_ENV === "production" && forbidden.includes(value)) {
    throw new Error(
      `SECURITY: ${name} is set to a known development default. ` +
      `Set a strong, unique value before deploying to production.`
    );
  }
}

const appSecret = required("APP_SECRET");
validateSecret("APP_SECRET", appSecret, ["dev-secret", "dev-app-secret-change-in-production", ""]);

export const env = {
  appId: required("APP_ID"),
  appSecret,
  isProduction: process.env.NODE_ENV === "production",
  isDevelopment: process.env.NODE_ENV !== "production",
  databaseUrl: required("DATABASE_URL"),
  // Optional MySQL read-replica (Phase 3). Empty = read-heavy queries use
  // the primary DATABASE_URL (zero behavior change when unconfigured).
  databaseReadUrl: process.env.DATABASE_READ_URL ?? "",
  ownerUnionId: process.env.OWNER_UNION_ID ?? "",
  masterKey: required("AI_SWARM_MASTER_KEY"),
  marketplaceKey: required("MARKETPLACE_MASTER_KEY"),
  // ─── Optional infrastructure (F0) — app degrades gracefully when absent ───
  redisUrl: process.env.REDIS_URL ?? "",
  // Stripe billing (routes return 503 when unconfigured)
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
  stripePriceSolo: process.env.STRIPE_PRICE_SOLO ?? "",
  // Dedicated HMAC key for signed compliance exports. Separating it from
  // APP_SECRET means session-secret rotation no longer breaks verification
  // of historical audit exports. Empty = fall back to APP_SECRET (legacy).
  auditExportKey: process.env.AUDIT_EXPORT_KEY ?? "",
  // Evidence attestation (v3): an Ed25519 key that signs published evidence so a
  // reader can prove WHO issued it, not merely that it is unedited. Symmetric
  // secrets cannot do this — anyone able to verify an HMAC can also forge it.
  // Accepts a PEM with escaped newlines, or base64 of the PEM. Empty = published
  // evidence is stored and labelled UNSIGNED rather than failing the seller.
  evidenceSigningPrivateKey: process.env.EVIDENCE_SIGNING_PRIVATE_KEY ?? "",
  evidenceSigningKeyId: process.env.EVIDENCE_SIGNING_KEY_ID ?? "deewaanai-platform-2026-1",
  // ─── Object storage for uploads (S3-compatible: AWS S3 / R2 / MinIO) ───
  // All three of bucket+key+secret must be set to activate; otherwise uploads
  // stay on local disk (fine for dev/beta, ephemeral on cloud hosts).
  s3Endpoint: process.env.S3_ENDPOINT ?? "", // empty = AWS; set for R2/MinIO
  s3Region: process.env.S3_REGION ?? "auto",
  s3Bucket: process.env.S3_BUCKET ?? "",
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
  // Local-disk base dir for uploads when S3 is unconfigured (test override).
  screenshotDir: process.env.SCREENSHOT_DIR ?? "./feedback-screenshots",
  // ─── Trusted proxy (rate-limit IP resolution) ───────────────────
  // When true (default), x-forwarded-for / x-real-ip are trusted because a
  // trusted edge proxy (Railway) sanitizes/sets them. Set TRUSTED_PROXY=false
  // if the app is ever exposed directly to the internet without such a proxy:
  // spoofed XFF headers would otherwise let attackers bypass IP rate limits.
  trustedProxy: process.env.TRUSTED_PROXY !== "false",
  // Observability (Sentry disabled when empty)
  sentryDsn: process.env.SENTRY_DSN ?? "",
  // ─── Scheduled DB backups (/api/admin/backup) ─────────────────────
  // Bearer token that authorizes the backup endpoint (called by the GitHub
  // Actions cron). Backups require S3_* (dumps are streamed to the bucket,
  // never to local disk — Railway's filesystem is ephemeral). Empty = the
  // endpoint returns 503 and no backup can be triggered.
  backupToken: process.env.BACKUP_TOKEN ?? "",
  // Marketplace certification: reviewer minimums (default 5 reviewers × 3 reviews each = 15 total)
  // Override for beta: set to 1/1 to allow self-certification with a single reviewer
  marketplaceMinReviewers: parseInt(process.env.MARKETPLACE_MIN_REVIEWERS ?? "5", 10) || 5,
  marketplaceMinReviewsPerReviewer: parseInt(process.env.MARKETPLACE_MIN_REVIEWS_PER_REVIEWER ?? "3", 10) || 3,
  // Public origin of the app, used for absolute links (spec §0.9b).
  publicAppUrl: process.env.PUBLIC_APP_URL ?? "https://app.deewaanai.com",
  // ─── Research Mode (batch runs + pipeline chaining) ───────────────
  swarmWorkerConcurrency: parseInt(process.env.SWARM_WORKER_CONCURRENCY ?? "2", 10) || 2,
  providerThrottle: process.env.PROVIDER_THROTTLE ?? "",
  // ─── Waitlist CORS (marketing site → this API) ────────────────────
  // The static site calls /api/waitlist/* cross-origin from the browser.
  // Comma-separated allowed origins; "*" is safe here (endpoint is public,
  // unauthenticated, no cookies) and stays the default until the site
  // domain is final. Set e.g. "https://deewaanai.com" to tighten.
  waitlistCorsOrigins: process.env.WAITLIST_CORS_ORIGINS ?? "*",
};
