# G0 — Inventory and Policy Boundary (offering redesign v2)

**Captured:** 2026-09-19 · workspace `app25_v2` @ baseline commit `3042b16` (copy of `app 25` @ `ee01f07`)
**Purpose:** spec §13 G0. This is the factual snapshot v2 migrations and rollouts are measured against.

## 1. Baseline verification (P0 results)

| Gate | Result |
|---|---|
| `npm ci` | ✅ clean install |
| `npm run check` (tsc) | ✅ after one baseline fix (below) |
| `npm test` | ✅ 232/236 — 4 failures in `api/lib/providerThrottle.test.ts` are **pre-existing** (identical files fail the same way in the original workspace) |
| `npm run build` | ✅ vite + esbuild bundles (`boot.js` 25.5 MB, `workerEntry.js` 8.9 MB) |
| `npm run i18n:check` | ✅ all locale bundles match |
| Local stack | ✅ `docker-compose.v2.yml` → `v2-mysql` :3307, `v2-redis` :6380, own volumes (`v2-mysql-data`) — cannot collide with the original `app25` compose project (`swarm-mysql` :3306) |
| Fresh schema | ✅ `db:push` → **58 tables** on empty local DB |
| Secrets | ✅ prod Railway DB/Redis URLs + master keys **removed** from `app25_v2/.env` (owner-authorized); fresh random dev keys; `.env` gitignored |
| Pre-existing defect fixed | `api/services/backup.ts:154` — `escape(v: unknown)` TS2345 (newer mysql2 typings); cast applied, no behavior change |
| `npm audit --omit=dev` | 9 vulnerabilities (4 moderate, 5 high) — **identical dependency set to prod lockfile**; not patched in P0 to preserve baseline parity; remediation belongs to a separate authorized dependency-update task |

## 1b. Owner decisions recorded (2026-09-19)

- **D-a** Fresh private git repo for v2: `github.com/deewaanai/pipeline` (private; rename planned later). Baseline tag `v2-baseline`.
- **D-b** P0 execution authorized and completed.
- **D-c** Staging DB will be seeded from the latest S3 prod-snapshot restore, cleared at product launch.
- **D-e (new)** Separate DB/Redis confirmed after split-brain risk review — v2 never shares the live prod database or queues, even within the same Railway project.

## 2. Schema & migration history state

- `db/migrations/` contains hand-written SQL **009–021** only; `meta/_journal.json` has one drizzle-kit entry (`0000_next_mindworm`). **No full replay chain exists** — the repo's actual up-to-date mechanism is `drizzle-kit push` from `db/schema.ts` (schema = source of truth).
- Pre-009 SQL lives loose in `db/` (`add_team_tables.sql`, `marketplace_migration.sql`, `migrate-007-*`, `migrate-008-*`); a separate top-level `migrations/` holds `001_add_pro_auto_tier.sql` only.
- **Consequence for v2:** additive v2 changes go into `db/schema.ts` + numbered SQL from **022**, but a fresh environment is provisioned via `db:push`, not replay. Rehearsals must test both paths (push onto empty; SQL onto restored snapshot).

## 3. Existing tables (58) — v2-relevant subset

Core: `users` (role, tier enum `standard|pro_designer|pro_auto`) · `projects` · `pipeline_steps` · `pipeline_templates` · `custom_agents` · `swarm_runs` · `swarm_batches` · `agents`/`agent_runs`/`agent_responses`
Marketplace/trust: `marketplace_listings` (status enum: `draft, generating, pending_review, reviewing, certifying, rejected, approved, …`), `marketplace_purchases` (status `active|refunded|cancelled`), `listing_reviews`, `blind_review_tasks`, `review_assignments`, `reviewer_profiles`, `creator_deposits` (`ai_test|human_review`; `pending|completed|refunded|partial_refund`), `refund_ledger`, `encrypted_prompts`, `voucher*`
Platform: `entitlements`, `subscriptions`, `feature_flags`, `idempotency_keys`, `usage_counters`, `api_key_store`, `llm_providers`, `oauth_*`, `teams/team_*`, `notifications`, `admin_audit_log`, `mcp_audit_log`, `activity_log`, `test_prompts` (research-mode), etc.

## 4. Feature flags (`feature_flags` DB-driven, `api/plugins/featureFlags.ts`)

Seeded defaults: `circuit_breaker` (on), `local_folder` (on), `marketplace_ai_triage` (on, non-gating), `batch_mode` (off), `pipeline_chaining` (off). Rollout % + per-user allowlist supported. v2 adds: `v2DesignJobs`, `v2Benchmarks`, `v2Publication`, `v2ProtectedExecution`, `v2Commercial` (last stays off until P1–P7 resolve).

## 5. Commercial/entitlement state today

- Plans (`api/config/plans.ts`): `solo`, `team_seat`; Stripe price IDs from env (`STRIPE_PRICE_SOLO`, …); capabilities feed `entitlements` service. No USD 9.99 mapping exists yet (Phase P4).
- Commission: `PLATFORM_FEE_RATE = 0.30` in `api/services/entitlementSync.ts`; purchases record `creatorEarnings`.
- Legacy human review: quorum = `env.marketplaceMinReviewers × env.marketplaceMinReviewsPerReviewer`, fail-closed at `certifying` (`api/routers/marketplace.ts:404–410, 842–909`). v2 publication must not route through this.
- No settlement/payout tables exist — only ledger-ish `creator_deposits`/`refund_ledger`. Payout lifecycle is net-new (P4, policy-blocked).

## 6. API clients of surfaces v2 will change

`swarm.autoDesign` consumers: `src/pages/ProjectWorkspace.tsx`, `src/pages/MyPipelines.tsx`, `api/routers/swarm.ts`, `api/mcp/tools/designPipeline.ts`, (service) `api/services/autoDesignService.ts`. Any return-shape change needs the compat/version rollout of spec §5.2.

## 7. Deployment versions to freeze against

- Prod code: `app 25` @ `ee01f07`, auto-deployed via GitHub Actions to Railway (`deewaanai.com`).
- Prod DB: public Railway proxy host (see `app 25/.env`, deliberately not reproduced here); daily S3 backups (bucket per backup workflow) — restore target for future v2 staging DB (owner decision D-c: snapshot-seeded, cleared at launch).
- v2 Railway service: not yet created (Phase P6).

## 8. Policy boundary (spec §1.3) — unchanged

P1–P7 remain open (payer matrix, license model, payout/refund policy, trial policy, limits/grace, approved endpoints + release source, public-data/moderation policy). Phases P0–P3 proceed; P4 and any public launch stay flag-disabled until each is resolved by the owner.
