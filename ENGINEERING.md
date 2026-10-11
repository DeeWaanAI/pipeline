# ENGINEERING.md

Orientation for engineers working on DeeWaanAI: where things live, how requests flow,
and how to perform the most common changes. Every path below was verified against the
repository at the time of writing (Final Sprint, 2026-07-13).

---

## 1. Module map

```
api/
  boot.ts                  Hono app: middleware (request-id, security headers, 50MB
                           body limit), /api/health, route registration, tRPC handler,
                           worker lifecycle, crash-resume DB-heal, graceful shutdown.
                           In production also serves dist/public static + listens on PORT.
  router.ts                appRouter — composes every tRPC sub-router + plugin routers.
  middleware.ts            tRPC procedure builders (publicQuery / authed* / admin*).
  context.ts               tRPC context creation (auth, locale).
  auth-router.ts           Kimi OAuth session auth router.
  middleware/route files   Raw Hono endpoints outside tRPC:
                           stream-route.ts (SSE), upload-route.ts,
                           feedback-screenshot-route.ts, project-import-route.ts,
                           beacon-save-route.ts, billing-webhook-route.ts (Stripe),
                           certification-badge-route.ts (public SVG), sso-route.ts,
                           relay-route.ts, test-fixture-route.ts (dev-only tooling).

  routers/                 tRPC sub-routers: localAuth, project, agent, customAgent,
                           pipeline, template, swarm, llm, marketplace, certification,
                           team, billing, voucher, export, admin, feedback, issues,
                           notification, search, projectFiles, projectImport, response,
                           debug, gitee, github, testFixture (dev-gated).

  services/                Domain logic, one concern per file:
                           entitlements.ts      the "can user X do Y" brain (see §3)
                           tokenService.ts      OAuth access/refresh tokens (jose HS256)
                           billingService.ts    Stripe checkout + webhook event handling
                           entitlementSync.ts   marketplace purchase fulfill/refund
                           auditExport.ts       signed compliance ledger + CSV (admin)
                           swarmService.ts      executeSwarmRun — pipeline execution
                           sso.ts               OIDC/SAML connections (secrets AES-256-GCM)
                           eventBus.ts          pipeline event fan-out (local + Redis)
                           memoryManager, projectIntelligence, projectFilesDisk,
                           stateSummarizer, cryptoService, gitee*/github* services.

  mcp/                     Companion MCP server (public API contract):
                           register.ts    mounts OAuth + /mcp endpoints, per-customer
                                        rate limits, customer-tier resolution
                           auth.ts        OAuth 2.1 endpoints: RFC 9728/8414 discovery,
                                        RFC 7591 DCR, authorize, token, consent
                           transport.ts   streamable HTTP (POST/GET/DELETE /mcp) +
                                        legacy SSE (/mcp/sse, /mcp/messages)
                           server.ts      JSON-RPC dispatch: tools/list + tools/call,
                                        scope gate, feature-flag gate, audit logging
                           context.ts     Bearer-token authentication → McpAuthContext
                           types.ts       McpTool / McpAuthContext contract
                           tools/         16 tools (8 core + 8 team/ behind `teamsync`)

  infra/                   Pluggable infrastructure with in-memory fallbacks:
                           redis.ts   lazy ioredis singleton, gives up after 3 attempts
                           queue.ts   BullMQ backend + in-memory queue (createQueue,
                                      createWorker, 24h idempotency-key dedupe)
                           pubsub.ts  Redis pub/sub + EventEmitter fallback, origin
                                      tagging to drop self-echoes

  workers/swarmWorker.ts   Consumes `swarm-runs` queue jobs → executeSwarmRun.

  plugins/                 registry.ts (plugin sub-routers), featureFlags.ts (runtime
                           flag checks, 60s cache), circuit-breaker/.

  lib/                     env.ts (validated env), logger.ts (JSON lines), messages.ts
                           (server i18n), rateLimiter.ts (token bucket + per-customer
                           fixed windows), observability.ts (Sentry), providers/
                           (LLM adapters: openai.ts, anthropic.ts, base.ts, index.ts),
                           marketplaceCrypto.ts, http.ts, cookies.ts, extractJson.ts,
                           vite.ts (prod static serving).

  config/plans.ts          Billing plan catalog (PLANS, PLAN_CAPABILITIES).
  locales/{en,zh}/         Server-side message bundles (server.json).
  queries/                 connection.ts (lazy drizzle getDb/getReadDb), users.ts.

db/
  schema.ts                All drizzle table definitions (users, runs, marketplace,
                           teams, subscriptions, entitlements, oauth_*, feature_flags…).
  relations.ts             drizzle relations.
  migrations/              meta/ (drizzle journal + snapshot) + hand-written phase SQL
                           (009_foundation.sql … 013_enterprise.sql, applied manually).
  seed.ts                  Seed data.

contracts/                 Shared client/server constants, error codes, types
                           (constants.ts: Session cookie, Paths).

src/                       React 19 SPA: App.tsx (routes), pages/, components/, hooks/,
                           stores/ (zustand), providers/, locales/{en,zh}/ (14 namespaces),
                           i18n-languages.ts (language registry — single source of truth),
                           lib/ (trpc client, utils).

scripts/                   check-i18n.cjs (parity gate), make-admin.cjs,
                           smoke-teamsync.mjs, smoke-enterprise.mjs (boot smokes).

relay/connector.mjs        On-prem relay connector (outbound-only, zero deps).
deploy/                    Alibaba Cloud install/setup scripts + notes.
DeeWaanAI-Next/            Transformation tracking: README, PROGRESS, phase specs,
                           archived strategy docs.
```

---

## 2. Request flows

### 2.1 tRPC call (web app)

```
React client (src/lib trpc)  →  POST /api/trpc/<router>.<procedure>
  → boot.ts request-id + security-header middleware
  → fetchRequestHandler (router.ts appRouter, createContext from context.ts)
  → procedure (middleware.ts builders enforce auth/role)
  → service layer (api/services/*) → drizzle (getDb / getReadDb) → MySQL
```

### 2.2 MCP tool call (including OAuth)

```
Desktop app (Claude/ChatGPT/Qwen/Kimi)
  1. Discovery:  GET /.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server
  2. Register:   POST /oauth/register (RFC 7591 DCR)
  3. Authorize:  GET  /oauth/authorize → 302 /login?next=… → /oauth/consent → auth code
  4. Token:      POST /oauth/token → scoped HS256 access JWT (tokenService, scopes from
                 TOKEN_SCOPES) + opaque refresh token (SHA-256 at rest, rotating)
  5. Call:       POST /mcp (Authorization: Bearer <jwt>)
                 → mcp/context.ts authenticate → McpAuthContext (userId, scopes, locale)
                 → register.ts mcpGate: resolveCustomerTier (solo/team/admin, cached 60s)
                   → checkCustomerRateLimit (Redis INCR+PEXPIRE, in-memory fallback)
                 → server.ts tools/call: scope gate → feature-flag gate (isFeatureEnabled)
                   → tool.handler(args, ctx) → mcp_audit_log + usage counters
```

Errors are localized per session (`McpAuthContext.locale` captured at initialize;
`msg()` from `api/lib/messages.ts`).

### 2.3 Pipeline run via worker

```
tRPC swarm.execute / resumePipeline / approveStep (or MCP run_pipeline / team_run_resume)
  → enqueueSwarmRun(runId, userId)  →  `swarm-runs` queue
       (BullMQ when REDIS_URL set, in-memory otherwise)
  → workers/swarmWorker.ts → services/swarmService.ts executeSwarmRun
       → step execution via LLM providers (api/lib/providers)
       → progress events: services/eventBus.ts → infra/pubsub.ts → SSE (stream-route.ts)
Crash safety: at boot, boot.ts DB-heal resets stale "running" rows to "pending" and
re-enqueues them ("awaiting_approval" rows are left for humans).
```

### 2.4 Stripe webhook

```
Stripe → POST /api/billing/stripe-webhook (raw body)
  → 503 unless STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET configured
  → signature verification (services/billingService.handleStripeEvent)
  → checkout.session.completed → subscriptions upsert / marketplace entitlement grant
     (entitlementSync.fulfill, idempotent per session)
  → subscription.updated / .deleted → seat reconcile + revoke
  → charge.refunded → entitlementSync.revoke
```

### 2.5 Marketplace certification (trust flow, spec Phase 0)

```
submitForReview (creator, draft/rejected listing)
  → [1] scanListingSecurity (services/promptSecurityScan — NO LLM: unicode
        hygiene, injection phrases, exfiltration, secrets/PII; decrypts
        prompts in-memory, never logs them; fail-closed)
        fail → status=rejected, aiFeedback='[SECURITY] …'
  → [2] test-data generation (creator's own provider — unchanged)
  → [3] runAiTriage (flag marketplace_ai_triage + AI_TRIAGE_* env; platform
        model, test I/O only, score computed in code, null=skip; NON-GATING
        except floor: score < 2.5 → rejected) → status=certifying
  → enqueueBlindReviewTasks: MIN_UNIQUE_REVIEWERS pooled copies per prompt
certifying = VISIBLE in browse, NOT buyable (purchase + Stripe-fulfillment
  both re-check status='published', fail-closed)
getNextReviewTask / submitReviewTask (tRPC + MCP get_next_review_task /
  submit_review_task): active reviewers only; self-review ban + no
  clustering + never-same-prompt-twice enforced server-side via the hidden
  listingId; payload is ONLY {taskId, inputText, actualOutput, rubric}
quorum: ≥ MARKETPLACE_MIN_REVIEWERS distinct reviewers ×
  MARKETPLACE_MIN_REVIEWS_PER_REVIEWER each → avg ≥ 3.5 && kappa > 0.60
  → published + certifiedAt (+ marketplace.certify.outcome log), else
  rejected; no quorum → stays certifying
```

Invariants: AI never sets `published`; `encryptedPrompts` never reach triage,
reviewers, or free tiers; every error/missing-config path fails closed. The
legacy `submitReview` 5×3+kappa path is kept intact as the anchor.

---

## 3. Entitlements (read this before touching auth checks)

`api/services/entitlements.ts` is the single brain. `can(userId, capability)`
resolves in order:

1. unexpired `entitlements` rows (user scope — the only scope),
2. nothing else. Everything not gated by a row below is open to every signed-in account.

The old arms — an active/trialing subscription through `PLAN_CAPABILITIES`, `users.tier`
through `TIER_CAPABILITIES`, and voucher redemptions — were removed with the plan and tier
ladders (owner decision 2026-09-22). DeeWaanAI sells one flat per-account subscription.

Capability vocabulary: grant-based `pipeline:run:<listingId>` (a marketplace purchase) and
whatever an admin records manually. `team:sync` is retired: no code reads it, and a legacy
`team_seats` Stripe event is now claimed and ignored. New authorization checks should call
`can()` — do not add raw `tier ===` comparisons. Tier reads that are display-only (badges,
admin management) are fine.

---

## 4. How-to recipes

### Add a language

1. Create `src/locales/<code>/` with **all** namespace JSON files (mirror
   `src/locales/en/` — 14 namespaces: common, login, dashboard, workspace, settings,
   audit, agents, pipeline, pages, connect, mcp, certification, pricing, teamsync).
2. Create `api/locales/<code>/server.json` (server-side messages).
3. Add a `LANGUAGES` entry in `src/i18n-languages.ts` (imports + `code` + `label` +
   `namespaces`). `i18n.ts` and the language switcher pick it up automatically.
4. Run `npm run i18n:check` — `scripts/check-i18n.cjs` fails the build on any key
   mismatch between locales (client and server bundles alike).

### Add an MCP tool

MCP tools are a **public API contract: never rename, only add.**

1. Create `api/mcp/tools/<name>.ts` exporting an `McpTool` (shape in `api/mcp/types.ts`):
   - `name` — permanent snake_case
   - `description`, `inputSchema` (zod), `annotations` (`readOnlyHint`, `destructiveHint`)
   - `requiredScopes` — from `TOKEN_SCOPES` in `api/services/tokenService.ts`
     (`mcp:read`, `mcp:run`, `mcp:write`, `team:read`, `team:write`)
   - optional `featureFlag` — tool is hidden from `tools/list` and calls are rejected
     unless the flag is enabled for the user (see `api/mcp/server.ts`)
   - `handler(args, ctx)` — returns JSON-serializable data; `ctx` carries userId,
     scopes, clientId, requestId, locale.
2. Register it in the `TOOLS` array in `api/mcp/tools/index.ts`.
3. If it needs a new scope, extend `TOKEN_SCOPES` (additive only — existing tokens keep working).

### Add a billing plan

1. Add the plan to `api/config/plans.ts`: extend `PlanId`, add a `PLANS` row, and define
   its `PLAN_CAPABILITIES` set (capabilities granted while the subscription is
   active/trialing).
2. Create the price in Stripe; add its env var to `.env.example` **and** `api/lib/env.ts`
   (follow `stripePriceSolo`), then wire it into the `PLANS` row.
3. Add any checkout/session helpers in `api/services/billingService.ts` and a tRPC
   procedure in `api/routers/billing.ts`. The webhook
   (`api/billing-webhook-route.ts` → `handleStripeEvent`) already reconciles
   subscription state generically; verify the new plan's metadata flows through.
4. Gates: `npm run check`, `npm test`.

### Add an LLM provider

1. If the provider is OpenAI-compatible: add a defaults entry (`name`, `baseUrl`,
   `models`) to `getProviderDefaults()` in `api/lib/providers/index.ts` and add the slug
   to `getBuiltInProviderSlugs()`. Done — `createProviderAdapter` routes unknown slugs
   to the OpenAI adapter.
2. If it needs a custom protocol: implement `LLMProviderAdapter` (`api/lib/providers/base.ts`)
   in a new `api/lib/providers/<slug>.ts` (see `anthropic.ts`) and branch on the slug in
   `createProviderAdapter()`.
3. Users/providers are DB rows (`llmProviders` table, managed via the llm router) — no
   migration is needed for a new built-in slug.

### Add a feature flag

Flags live in the `feature_flags` table (`db/schema.ts`: `key`, `name`, `enabled`,
`rolloutPercent`, `allowedUserIds`). Runtime checks go through
`isFeatureEnabled(key, userId)` in `api/plugins/featureFlags.ts` (60s in-memory cache;
checks: master switch → rollout % by deterministic userId hash → allowlist → deny).
Manage rows via the admin flag endpoints (`getAllFlags` in `api/plugins/featureFlags.ts`
backs the admin UI) or SQL. Gate new surfaces in-handler (fail closed), the way
`api/sso-route.ts` / `api/relay-route.ts` return 404 when their flag is off.

**Burial checklist** — when a kept flag (`store_relaunch`, `teamsync`, `enterprise_sso`,
`enterprise_relay`) reaches 100% and acceptance is done, remove it completely:

1. Delete the gate branches:
   - `store_relaunch` — purchase gate in `api/routers/marketplace.ts` (`isFeatureEnabled("store_relaunch", …)` around the checkout URL).
   - `teamsync` — `featureFlag: "teamsync"` on the 8 tools in `api/mcp/tools/team/*`
     and the flag-filter branch in `api/mcp/server.ts`.
   - `enterprise_sso` — the `FLAG_KEY` fail-closed 404 gate in `api/sso-route.ts`.
   - `enterprise_relay` — the `FLAG_KEY` fail-closed 404 gate in `api/relay-route.ts`.
2. Delete the flag's row from `feature_flags`; delete any now-dead off-branch code.
3. Update `DeeWaanAI-Next/PROGRESS.md` and this file.
4. Run all gates: `npm run check` → `npm run i18n:check` → `npm test` → `npm run build`.
5. Boot smoke: `scripts/smoke-teamsync.mjs` and `scripts/smoke-enterprise.mjs`
   (they assert the flag-off behavior — update them post-burial).

Precedent: `companion_mcp` was buried this way on 2026-07-13 — see the header comment in
`api/mcp/register.ts` (MCP surface now always-on, still OAuth + rate-limited + metered).

### Apply a migration

- **Dev (schema push):** edit `db/schema.ts` (+ `db/relations.ts` if needed), then
  `npm run db:push`. Requires `DATABASE_URL` (see `drizzle.config.ts`).
- **Generated migrations:** `npm run db:generate` (emits into `db/migrations/` with a
  journal snapshot in `db/migrations/meta/`), review the SQL, then `npm run db:migrate`.
- **Phase-sized changes:** the project convention for the transformation phases is
  hand-written, numbered SQL in `db/migrations/` (`009_foundation.sql` …
  `013_enterprise.sql`) applied manually to each environment, with the drizzle defs kept
  in sync in `db/schema.ts` (see `DeeWaanAI-Next/PROGRESS.md` for how each phase did it).
- After any migration: `npm run check` and `npm test`; the boot DB-heal only touches
  `swarm_runs.status`, so no special deploy step is needed for additive tables.

---

## 5. Tests

`npm test` runs Vitest over `api/**/*.test.ts` (see `vitest.config.ts` — node
environment; aliases `@`, `@contracts`, `@db`). Tests are **pure-function only**: no
database, no network. Anything that needs MySQL/Redis/Stripe is exercised by the boot
smokes (`scripts/smoke-*.mjs`), not by unit tests. Current coverage:

| File | What it pins down |
|---|---|
| `api/services/auditExport.test.ts` | canonical JSON determinism, HMAC sign/verify round-trip + tamper rejection, RFC 4180 CSV quoting |
| `api/lib/messages.test.ts` | server i18n: dot-path lookup, locale fallback (requested → en → key), `{{param}}` interpolation, `resolveLocale` |
| `api/lib/rateLimiter.test.ts` | token-bucket burst/refill/window-cap behavior, per-customer tier maps |
| `api/services/tokenService.test.ts` | access-token issue/verify round-trip, garbage/tampered/expired rejection |
| `api/services/entitlements.test.ts` | `TIER_CAPABILITIES` / `PLAN_CAPABILITIES` matrices |
| `api/services/entitlements.integration.test.ts` | **Integration** — grant/can/revoke round-trip on real MySQL, Redis fixed-window limiter; skipped unless `DATABASE_URL`/`REDIS_URL` are set (CI `integration` job) |

## 6. Production operations

### Trusted proxy / client IP
`api/lib/clientIp.ts` resolves the rate-limit client IP for every consumer
(localAuth signup/login, SSO lookup, backup trigger). When `TRUSTED_PROXY` is
true (default) it trusts the first `x-forwarded-for` entry — safe only behind
an edge that sanitizes the header (Railway's router does). Set
`TRUSTED_PROXY=false` if the app is ever exposed without such a proxy: the
direct socket address is used instead (threaded into tRPC context as
`ctx.remoteIp` from the Hono mount in `boot.ts`), and spoofed XFF headers can
no longer bypass auth rate limits. With no socket address available it fails
closed to a shared `"unknown"` bucket.

### Rate limiting layers
- `checkRateLimitAsync` (Redis fixed-window, in-memory fallback): auth (`signup`/`login`, 5/min per IP), audit export, SSO lookup, and pipeline execution (`execute`/`resumePipeline`/`executeAgent`, 10/min per user).
- `checkCustomerRateLimit` (Redis, per-customer tiers solo/team/admin): the MCP surface.
- The sync `checkRateLimit` (in-memory token bucket) remains as the fallback path only.

### Worker placement
The pipeline worker runs in-process by default. For a dedicated worker process:
`node dist/workerEntry.js` (bundled by `npm run build`) with `START_WORKER=false`
on the web service. The DB-heal at web boot re-enqueues stale runs; enqueue is
idempotent (24h dedupe), so heal-on-web + worker-on-dyno is safe. BullMQ
requires `maxRetriesPerRequest: null` — always use the dedicated connection in
`api/infra/queue.ts`, never the shared `getRedis()` client, for BullMQ.

### Health vs readiness
- `/api/health` — **liveness**: 200 when the process is up and MySQL answers; reports db/redis/queue/worker status.
- `/api/ready` — **readiness**: 200 only when MySQL AND Redis (when configured) are reachable; 503 otherwise. Point load-balancer probes here.

### Secrets & key separation
- `APP_SECRET` signs local-auth session tokens (rotation invalidates all sessions).
- `AUDIT_EXPORT_KEY` (optional) HMAC-signs compliance exports. Exports carry a
  `keyId` (`app-secret` | `audit-export-key`) and verification accepts both, so
  rotating APP_SECRET — or adopting the dedicated key later — never breaks
  historical export verification.
- `AI_SWARM_MASTER_KEY` / `MARKETPLACE_MASTER_KEY` encrypt stored content (prompts, marketplace items). Losing these = unreadable data. Back them up offline.

### CI
`.github/workflows/ci.yml` runs the release gates on every push/PR:
`check → i18n:check → test → build`, a placeholder-contact block (mirrors the
local pre-push hook), and an `integration` job with MySQL/Redis service
containers (`db:push` + full test suite incl. integration tests). Railway
auto-deploys `main` — CI is the only automated safety net before production.

### Backups
**Scheduled (Batch A, primary):** `.github/workflows/backup.yml` runs daily
(`0 3 * * *` UTC + manual dispatch) and calls `POST /api/admin/backup` with a
`BACKUP_TOKEN` bearer (constant-time compared; 503 when token or S3 is
unconfigured). `api/services/backup.ts` runs `mysqldump` (mariadb-client in
the production image), gzips in-process, uploads to the `S3_*` bucket under
`backups/`, and prunes dumps older than 7 days. Credentials go to mysqldump
via a short-lived 0600 defaults file — never on the command line; the dump
never touches local disk. The gzipped dump is buffered in memory pre-upload —
fine at current DB size; switch to streamed multipart upload if the DB grows
large. Manual trigger: `curl -X POST -H "Authorization: Bearer $BACKUP_TOKEN"
https://<host>/api/admin/backup`.

**Operator-run (fallback):** `scripts/backup-db.sh` — gzipped `mysqldump` with
7-day retention; restore command in the script header.
`docker-compose.backup.yml` + `scripts/backup-cron.sh` package it as a
one-command daily scheduler (`docker compose -f docker-compose.backup.yml up -d`)
for any always-on machine that can reach the database.

### Object storage
`api/lib/storage.ts` — uploads (feedback screenshots) go to S3-compatible object
storage when `S3_BUCKET` + `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` are all set
(`S3_ENDPOINT` empty = AWS; set it for R2/MinIO), else local disk (`SCREENSHOT_DIR`
override). Objects stay private — the app proxies; the auth + signed-URL gate in
`feedback-screenshot-route.ts` applies either way. The S3 SDK is imported lazily so
disk-mode deploys never load it. Smoke: `scripts/smoke-storage.mjs` (MinIO recipe in
its header).

### Offline acceptance smokes
`scripts/smoke-stripe-webhook.mjs` — real-signature Stripe webhook test (purchase →
entitlement grant → idempotent replay → refund revoke) with zero Stripe network calls.
`scripts/smoke-relay-loop.mjs` — full on-prem relay loop against localhost (register →
connector child process → enqueue → completed in DB).
`scripts/smoke-marketplace-trust.mjs` — trust/certification flow (security-scan reject,
certifying visible-not-buyable, blind-pool privacy + self-review ban, 5×3 quorum →
published, below-threshold → rejected); no LLM/Stripe calls. Live-system steps that remain:
`DeeWaanAI-Next/ACCEPTANCE.md`.
