# FINAL SPRINT — Cleanup & Handover: Coordination Spec (2026-07-13)

Goal (roadmap §FINAL SPRINT): the repo reads as ONE coherent product — no dead code, no dual paths, any new engineer can navigate it.
Reference: `DeeWaanAI-Code-Update-Roadmap.md` Final Sprint + `DeeWaanAI-Next/PROGRESS.md`.

## Already done by main agent (do not redo)

- **Flag burial: `companion_mcp`** — flag gate removed from `api/mcp/register.ts` (MCP surface now always-on, still OAuth + rate-limited + metered), DB row deleted, tsc green.
- **Kept flags (NOT buried — live acceptance pending)**: `store_relaunch` (live Stripe card test), `teamsync` (two-desktop acceptance), `enterprise_sso`/`enterprise_relay` (live IdP/relay). Burial checklist for these is a docs deliverable.
- **Recon facts**: `src/pages/Login.tsx` is orphaned (nothing imports it; `/login` renders Dashboard). `npm test` currently finds ZERO test files and exits 1. No UI-facing capabilities endpoint exists. Tier authorization checks live in: `api/routers/marketplace.ts` (consumer checks), `src/pages/{PipelineEditor,ReviewerPortal,MyAgents,ProjectWorkspace}.tsx`, `src/components/pipeline/PipelineConfigurator.tsx`. Display-only tier usage (TierBadge, localAuth payloads, setTier/devTierSwitch/admin tier management, voucher.redeem as entitlement SOURCE) stays.

## Stack / conventions

- Hono + tRPC + MySQL/drizzle + React 19 + i18next. No git repo — workers edit DISJOINT file sets.
- Entitlements brain: `api/services/entitlements.ts` — `can(userId, capability)`, vocabulary: `pipeline:fixed`, `pipeline:custom`, `pipeline:autodesign`, `llm:1`, `llm:3`, `marketplace:publish`, plus grant-based `pipeline:run:<listingId>`, `tier:<tier>`, `team:sync`. Resolution: entitlement rows → subscription plan → user tier → voucher redemption (behavior-preserving superset of raw tier checks).
- `npm test` = vitest, include `api/**/*.test.ts|spec.ts`. Currently zero files.
- Gates: `npm run check` (tsc -b), `npm run i18n:check`, `npm run build`, `npm test` — all must end green.

## Worker A — Entitlement migration sweep

Owns (write): any file containing a tier/voucher AUTHORIZATION check (expected: `api/routers/marketplace.ts`, `src/pages/PipelineEditor.tsx`, `src/pages/ReviewerPortal.tsx`, `src/pages/MyAgents.tsx`, `src/pages/ProjectWorkspace.tsx`, `src/components/pipeline/PipelineConfigurator.tsx`), PLUS `api/routers/billing.ts` (add `myCapabilities` procedure) and NEW `src/hooks/useCapabilities.ts`.
Do NOT touch: `src/components/TierBadge.tsx`, `api/routers/localAuth.ts`, `api/routers/admin.ts`, `api/routers/voucher.ts` (redemption is an entitlement SOURCE — keep writing tier), display-only tier reads.

Contract:
1. Add `billing.myCapabilities` (authedQuery): returns `{ capabilities: string[], tier: string }` — resolve via TIER_CAPABILITIES + PLAN_CAPABILITIES + getActiveEntitlements + unexpired voucher redemption tier caps (mirror `can()`'s union; you may add a `resolveCapabilities(userId)` export to `api/services/entitlements.ts` — that file IS in your write scope for this one additive function).
2. `src/hooks/useCapabilities.ts`: `useCapabilities()` → `{ has(cap), capabilities, tier, isLoading }` backed by `trpc.billing.myCapabilities.useQuery()`.
3. Replace every AUTHORIZATION tier check (gates a feature/action) with capability checks:
   - `tier === "pro_designer" || tier === "pro_auto"` → `has("pipeline:custom")` (adjust per actual gate meaning — read each site; marketplace publishing → `marketplace:publish`; auto-design → `pipeline:autodesign`; multi-LLM → `llm:3`).
   - Server-side in marketplace.ts: use `can(userId, "<cap>")` from the entitlements service.
4. Grep-verify at the end: `grep -rn "tier === \|tier !== " api/ src/` shows ZERO authorization checks remaining (only management/display/payload sites). List every replaced site + kept site with reason in your report.

## Worker B — Route & page audit + navigation repositioning

Owns (write): `src/App.tsx`, `src/components/layout/AppShell.tsx`, `src/locales/en/common.json` + `src/locales/zh/common.json` (nav labels), deletion of `src/pages/Login.tsx` + `src/pages/TestFixtures.tsx` ONLY IF verified unreferenced (Login: already verified orphaned — delete it). `api/test-fixture-route.ts` + `api/routers/testFixture.ts` (dev-gate only), `api/boot.ts` (ONLY the registerTestFixtureRoute call — coordinate: main agent owns other boot.ts lines; report the exact change instead of editing if unsure — you MAY make this single targeted edit).
Do NOT touch: any other page, router registration in `api/router.ts` (report findings instead).

Contract:
1. Audit table (in your report): every App.tsx route → page exists + has nav/consumer; every tRPC router in `api/router.ts` → has a UI/MCP/consumer caller (grep `trpc.<router>.` in src/ + api/mcp/). Report orphans; delete ONLY `src/pages/Login.tsx` (verified) — report any others for main-agent decision.
2. Test fixtures: keep the dev tooling but remove it from the product surface: delete the `/test-fixtures` nav item; gate `testFixtureRouter` procedures + `test-fixture-route.ts` handler to `env.isDevelopment` (clean 404/throw in production). Keep the route registration (dev convenience) — the gate is in-handler.
3. Navigation repositioning (AppShell): group the sidebar into sections with small uppercase group labels, order: **Studio** (Dashboard, My Pipelines, My Agents), **Market** (Marketplace, Review), **Teams** (Team Dashboard `/team`, Team Connect `/team/connect`), **Account** (My Data, Settings; Admin for admins). Contextual Audit link stays. Projects list stays. All new labels via `t()` in common.json (en+zh parity — i18n:check must pass).

## Worker C — Dead-code elimination

Owns (write): deletions of verified-dead files/exports under `api/` (EXCEPT files other workers own: `api/routers/marketplace.ts`, `api/routers/billing.ts`, `api/services/entitlements.ts`, `api/test-fixture-route.ts`, `api/routers/testFixture.ts`, `api/boot.ts`), and deletion of dead non-page modules under `src/` EXCEPT `src/pages/**`, `src/App.tsx`, `src/components/layout/AppShell.tsx`, `src/hooks/**`, `src/locales/**`.
Do NOT delete: anything referenced dynamically (string imports, plugin registry `api/plugins/**`, workers `api/workers/**`, scripts `scripts/**`, drizzle config, contracts `contracts/**`).

Contract:
1. Run `npx knip --reporter json` (installs on demand; if npx fetch fails, fall back to manual analysis: for each exported symbol, grep its importers).
2. For EVERY deletion candidate, verify by grepping the whole repo for: the filename, the export name, and dynamic-import patterns (`import(`, `require(`). Check the plugin registry, workers, boot.ts dynamic imports, and scripts before deleting.
3. Delete in small batches; after each batch run `npx tsc -b` — must stay green. If a deletion breaks anything, restore and move on.
4. Conservative rule: when in doubt, KEEP and list as "candidate — needs human decision" in your report. False deletions are worse than leftovers.
5. Report: deleted files/exports with verification evidence; kept candidates.

## Worker D — Docs handover + test seed

Owns (write): `README.md` (full rewrite), NEW `ENGINEERING.md`, NEW `api/**/*.test.ts` files, moving root strategy docs (`DeeWaanAI-Business-Transformation-Plan.md`, `DeeWaanAI-Code-Update-Roadmap.md`, `DeeWaanAI-Features-Report.md`) into `DeeWaanAI-Next/` (mv, don't copy).
Do NOT touch: source code, `DeeWaanAI-Next/PROGRESS.md` (main agent owns), package.json.

Contract:
1. `README.md`: what DeeWaanAI is (Companion MCP + certified marketplace + TeamSync + enterprise), quickstart (`docker compose up -d`, `npm ci`, `npm run db:push`, `npm run dev`, `npm run build && npm start`), env var table (from `.env.example`), key scripts, deploy notes (Dockerfile, ecosystem.config.cjs), links to ENGINEERING.md + DeeWaanAI-Next/.
2. `ENGINEERING.md`: module map (api/ boot → routers/services/mcp/infra/workers; db/; src/; contracts/), request flows (tRPC call, MCP tool call incl. OAuth, pipeline run via worker, Stripe webhook), and HOW-TO recipes: add a language, add an MCP tool, add a billing plan, add an LLM provider, add a feature flag (+ burial checklist for the 4 kept flags), apply a migration. Verify every path/command you mention EXISTS before writing it.
3. Test seed (`api/` only, vitest): pure-function tests, NO database/network — use dependency injection or test the pure helpers. Cover: `api/services/auditExport.ts` (canonical JSON stability, sign/verify round-trip, tamper rejection, CSV quoting), `api/lib/messages.ts` (locale resolution + key fallback), `api/lib/rateLimiter.ts` (checkRateLimit token bucket behavior), `api/services/tokenService.ts` (issue/verify access token round-trip — jose only, no DB paths), `api/services/entitlements.ts` TIER_CAPABILITIES matrix (pure map assertions). If a module can't be tested without DB, skip it — do not mock the world. `npm test` must pass.
4. Move the 3 strategy docs into `DeeWaanAI-Next/` and fix any links in README/ENGINEERING that referenced them at root.

## Merge & verification (main agent)

1. Review all diffs; resolve scope violations.
2. `npm run check` → `npm run i18n:check` → `npm test` → `npm run build` green.
3. Final gate: clean copy (no node_modules/dist) → `npm ci` → all gates → boot smoke (`scripts/smoke-teamsync.mjs` + `scripts/smoke-enterprise.mjs`, incl. post-burial MCP auth + rate-limit checks).
4. Update `DeeWaanAI-Next/PROGRESS.md` FINAL SPRINT section.
