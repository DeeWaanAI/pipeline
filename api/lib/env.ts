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
  stripePriceTeamSeat: process.env.STRIPE_PRICE_TEAM_SEAT ?? "",
  // Dedicated HMAC key for signed compliance exports. Separating it from
  // APP_SECRET means session-secret rotation no longer breaks verification
  // of historical audit exports. Empty = fall back to APP_SECRET (legacy).
  auditExportKey: process.env.AUDIT_EXPORT_KEY ?? "",
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
  // ─── Marketplace AI triage (Trust spec §0.3 / §2) ───────────────────
  // Platform-controlled, NON-GATING quality triage. Receives test I/O only —
  // never secret prompts (encryptedPrompts). Empty slug/model = triage
  // skipped entirely (submissions go straight to human review).
  // Recommended: Alibaba Cloud Model Studio, openai-compatible, qwen3.6-flash.
  aiTriageSlug: process.env.AI_TRIAGE_SLUG ?? "",
  aiTriageApiKey: process.env.AI_TRIAGE_API_KEY ?? "",
  aiTriageBaseUrl: process.env.AI_TRIAGE_BASE_URL ?? "",
  aiTriageModel: process.env.AI_TRIAGE_MODEL ?? "",
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

/**
 * True when the platform AI triage model is configured (Trust spec §0.3).
 * The API key is optional — self-hosted endpoints may not require one.
 * When false, triage is skipped (non-gating: absence of AI never blocks).
 */
export function isAiTriageConfigured(): boolean {
  return Boolean(env.aiTriageSlug && env.aiTriageModel);
}
