# Batch A: Pre-Public Hardening (2 hours)

> Saved 2026-07-19 from the owner's handoff into the new chat. Status: **planned, not started.**

## 1. Automated DB Backups
**File:** `api/routers/marketplace.ts` (or new `backup-schedule.ts`)
**What:** Add a scheduled job that runs `backup-db.sh` daily.
**How:**
- Option A: GitHub Actions cron (`0 3 * * *`) that SSHs into Railway and runs the script
- Option B: Railway native cron (if available on your plan) calling a new HTTP endpoint `/api/admin/backup`
- The script already exists and is secure (process-substitution for credentials)

**Deliverable:** Daily `.sql` dump saved to S3/R2 or Gitee repo `backups/`.

---

## 2. Redis-Backed Auth Rate Limiter
**File:** `api/lib/rateLimiter.ts`
**What:** Replace the in-memory `Map` in `checkRateLimit` with Redis fixed-window (same pattern as `checkCustomerRateLimit`).
**Key changes:**
- Import `getRedisClient()` from the existing Redis setup
- Use `redis.incr(key)` with `EXPIRE` for window-based counting
- Keys: `ratelimit:auth:{ip}`, `ratelimit:execute:{customerId}`, `ratelimit:read:{customerId}`
- Fallback to in-memory if Redis is offline (graceful degradation)

**Deliverable:** Auth brute-force protection works across all instances.

---

## 3. SVG Upload Block
**File:** `api/upload-route.ts`
**What:** Reject `image/svg+xml` uploads.
**Change:** Add to the mime-type filter:
```typescript
if (file.type === "image/svg+xml") throw new Error("SVG uploads are not supported for security reasons.");
```

**Deliverable:** SVGs cannot be uploaded (no script injection risk).

---

## 4. Trusted Proxy IP Flag
**File:** `api/lib/env.ts` + `api/middleware.ts` (or wherever `getClientIp` lives)
**What:** Add `TRUSTED_PROXY` env var. When `false`, ignore `x-forwarded-for` and use direct connection IP.
**Change:**
```typescript
trustedProxy: process.env.TRUSTED_PROXY !== "false", // defaults true (Railway)
```

**Deliverable:** Safe if the app is ever exposed without a proxy.

---

## Files to Touch
| # | File | Change |
|---|------|--------|
| 1 | `api/lib/rateLimiter.ts` | Redis-backed auth limiter |
| 2 | `api/upload-route.ts` | SVG block |
| 3 | `api/lib/env.ts` | `TRUSTED_PROXY` flag |
| 4 | `api/middleware.ts` or `api/lib/getClientIp.ts` | Respect `TRUSTED_PROXY` |
| 5 | New `.github/workflows/backup.yml` or `api/routers/backup.ts` | Scheduled backup trigger |
| 6 | `DEPLOY.md` / `README.md` | Document Batch B deferred items |

---

## Verification Gate
```
npm run check
npm test
npm run build
git commit -m "harden: db backups + redis rate limiter + svg block + trusted proxy"
git push origin main
```

---

## Overlap check against already-shipped work (as of 2026-07-19, from PROGRESS.md)

Verify each item against the current tree before implementing — some pieces exist in some form:

- **Item 3 (SVG block)** — already shipped in the 2026-07-15 expert-audit hardening (#15): `image/svg+xml` / `.svg` rejected at upload with explicit 400. Confirm the check in `api/upload-route.ts` matches the plan's intent; likely a no-op / verify-only.
- **Item 2 (Redis limiter)** — partially shipped: `checkRateLimitAsync` (Redis fixed-window + in-memory fallback) already exists and auth/audit/SSO limiters were migrated to it in the audit (#5/#6). Batch A's remaining delta: confirm `checkRateLimit` (the sync one) has no in-memory-only callers left, and confirm the key namespaces (`ratelimit:auth:{ip}`, `ratelimit:execute:{customerId}`, `ratelimit:read:{customerId}`) match the plan.
- **Item 1 (backups)** — `scripts/backup-db.sh` (process-substitution creds, 7-day retention) + `docker-compose.backup.yml` / `scripts/backup-cron.sh` exist for operator-run cron. Batch A's delta: *scheduled, unattended* execution (GitHub Actions cron or Railway cron + `/api/admin/backup` endpoint) and off-site storage (S3/R2/Gitee) — current setup writes to local `./backups` only.
- **Item 4 (trusted proxy)** — not yet shipped; audit #7 only documented the trusted-proxy assumption in code + ENGINEERING.md §6. This is genuinely new work.
