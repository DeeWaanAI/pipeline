# DeeWaanAI — Code Update Roadmap (All Products, All Phases)

*Engineering plan, July 2026. Maps onto the existing codebase: Hono + tRPC + MySQL/drizzle + React 19 + i18next.*

---

## 0. Design contract (the "never rewrite" rules)

Every phase below obeys these six rules. They are what makes the code survive fast user growth.

1. **Stateless app nodes.** All shared state lives in MySQL / object storage / Redis — never in process memory. The one violation today is the SSE `eventBus` (in-memory); the Foundation sprint fixes it. This is what lets you go from 1 node → N nodes behind a load balancer without touching business logic.
2. **Long work runs in workers, not requests.** Pipeline execution moves to a job queue. Web nodes stay sub-100ms responsive; runs survive deploys (your `swarmRuns.executionState` already makes runs resumable — today a deploy *fails* running pipelines; after this change they *resume*).
3. **One auth/entitlement brain.** A single `entitlements` service answers "can user X do Y" (tier + subscription + voucher + seat + purchase). No more scattered `tier === "pro_designer"` checks — adding a plan or product becomes data, not code.
4. **Feature-flag everything.** You already have `featureFlags` with rollout % and per-user allowlists. Every phase ships behind a flag: `companion_mcp`, `store_relaunch`, `teamsync`, `enterprise_sso`. Roll out 5% → 50% → 100%, roll back in seconds.
5. **i18n is one file + one folder.** Keep your existing rule (`src/i18n-languages.ts` + `src/locales/<code>/`): adding Japanese = create `locales/ja/`, add one block to `LANGUAGES`, done. Extend the same discipline to **server-side messages** (errors, emails, MCP tool descriptions) via a keyed message map resolved from the user's locale — never hard-coded English strings.
6. **MCP tools are a public API contract.** Versioned, never renamed, only added. Any MCP-compliant host (Claude Desktop, ChatGPT, Qwen Code, Kimi, and whatever ships next year) must work with zero host-specific code — host differences are handled by spec compliance (streamable HTTP + SSE fallback, OAuth discovery), not if-branches.

---

## FOUNDATION SPRINT (F0) — Week 0–1. Do first; everything depends on it.

| # | Task | Files (new → modified) | Notes |
|---|---|---|---|
| F0.1 | **Redis + queue infra** with in-memory fallback for dev | `api/infra/redis.ts`, `api/infra/queue.ts` (BullMQ) → `docker-compose.yml`, `api/lib/env.ts` | Interface-based: `Queue` adapter so single-node dev runs without Redis. Redis is also required for multi-node SSE. |
| F0.2 | **Distributed event bus** | `api/services/eventBus.ts` (modify) | Swap in-memory subscriber map for Redis pub/sub behind the same `subscribeClient/emitEvent` API. `stream-route.ts` unchanged. |
| F0.3 | **Pipeline worker** | `api/workers/swarmWorker.ts` → `api/routers/swarm.ts` | Move the execute loop out of the tRPC call into a BullMQ job. Job payload = `swarmRunId`; worker rehydrates from DB. On crash/deploy, stale `running` runs are re-queued instead of marked failed (upgrade your existing DB-heal + graceful-shutdown logic in `boot.ts`). |
| F0.4 | **Entitlements service** | `api/services/entitlements.ts` → `middleware.ts` | Single function `can(userId, capability, context?)`. Consumed by tRPC middleware, MCP layer, and UI. Tables: see F0.6. |
| F0.5 | **Billing (Stripe)** | `api/services/billingService.ts`, `api/stripe-webhook-route.ts` → `boot.ts` | Stripe Checkout for plans/seats; webhook → entitlements. Follows your `register*Route(app)` pattern. |
| F0.6 | **Core migrations** | `db/migrations/00X_foundation.sql` | New tables: `subscriptions` (userId/teamId, plan, status, stripe refs, period end), `entitlements` (subjectType, subjectId, capability, source, expiresAt), `usage_counters` (subjectId, metric, period, count), `idempotency_keys` (key, scope, responseHash, createdAt). |
| F0.7 | **Token service (OAuth 2.1)** | `api/services/tokenService.ts` | Scoped JWTs via `jose` (already installed): `mcp:read`, `mcp:run`, `mcp:write`, `team:read`, `team:write`. Refresh-token rotation table `oauth_refresh_tokens`. |
| F0.8 | **Server-side i18n** | `api/lib/messages.ts`, `api/locales/{en,zh}/server.json` → `contracts/constants.ts` | `ErrorMessages` becomes a key map; middleware resolves locale from user preference → `Accept-Language`. One CI check (`scripts/check-i18n.cjs`) fails the build if any language is missing keys — same rule client and server. |
| F0.9 | **Observability baseline** | `api/lib/logger.ts` (modify), Sentry init | Request IDs through tRPC context + MCP + workers; structured logs; Sentry on server. |

**Exit gate:** app runs identically to today on one node; `docker compose up` includes Redis; a pipeline run executed via worker completes and **resumes after a simulated kill -9**.

---

## PHASE 0 — Companion MCP Server (Weeks 1–6) — Product: Companion

Goal: any desktop LLM app connects to `https://<host>/mcp` with OAuth and can run the user's pipelines.

### New files

```
api/mcp/
  register.ts            # registerMcpRoutes(app) — same pattern as stream-route.ts
  server.ts              # McpServer instance (@modelcontextprotocol/sdk)
  transport.ts           # Streamable HTTP transport; legacy SSE endpoint for older hosts
  auth.ts                # OAuth metadata + token endpoints, consent flow
  context.ts             # MCP request → AuthedContext (validates scoped JWT, loads entitlements)
  tools/
    index.ts             # tool registry: name → {schema (zod), handler, scope, annotations}
    runPipeline.ts       # run_pipeline(v1): queues swarm run via F0.3 worker
    listPipelines.ts     # list_pipelines: mine + purchased + team-shared (entitlement-filtered)
    getRunStatus.ts      # run_status: status, current step, tokens, latency
    approveStep.ts       # approve_step: approve/reject/modify → resumes worker job
    projectContext.ts    # project_context: Intelligence Card + file fetch (projectIntelligence)
    memory.ts            # memory_get / memory_append (memoryManager, stateSummarizer)
    searchMarketplace.ts # search_marketplace: certified listings + grades
db/migrations/00Y_mcp.sql  # oauth_clients (dynamic client registration), mcp_audit_log
src/pages/Connect.tsx      # per-app setup guides (Claude / ChatGPT / Qwen / Kimi)
src/pages/OAuthConsent.tsx # "Allow Claude Desktop to access DeeWaanAI?" screen
src/locales/{en,zh}/connect.json, mcp.json
```

### Modified files

- `api/boot.ts` → add `registerMcpRoutes(app)` (2 lines, follows existing pattern)
- `api/routers/swarm.ts` → extract execution into `api/services/swarmService.ts` so tRPC and MCP share one code path (auth context passed as parameter, never `ctx` assumptions)
- `api/router.ts` → add `entitlements` + `billing` routers (list plans, create checkout session, subscription status)
- `src/App.tsx` → routes `/connect`, `/oauth/consent`
- `src/i18n-languages.ts` → register `connect`, `mcp` namespaces (the one-block rule)

### Protocol decisions (multi-host resilience)

- **Transport:** Streamable HTTP at `POST/GET/DELETE /mcp` (current MCP spec) **plus** `/mcp/sse` legacy endpoint — covers Claude Desktop, ChatGPT Apps, Qwen Code, Kimi today and the spec's future.
- **OAuth:** full discovery — `/.well-known/oauth-protected-resource` (RFC 9728) + `/.well-known/oauth-authorization-server` (RFC 8414) + **dynamic client registration** (RFC 7591). ChatGPT and Qwen Code both auto-discover; no per-host config.
- **Tool contract:** every tool annotated (`readOnlyHint`, `destructiveHint`) so hosts prompt for confirmation on writes; zod schemas reused from `@contracts` where shapes overlap; tool names are permanent, new behavior = new tool name.
- **Metering:** every MCP call passes through `entitlements` + increments `usage_counters` (per plan caps) + writes `mcp_audit_log` (host client ID, tool, latency) — this powers both billing and the hosts-matrix analytics.

### Acceptance gate
Run one pipeline end-to-end from **Claude Desktop, ChatGPT (Developer Mode), and Qwen Code**; kill the server mid-run, restart, watch it resume; rate-limit and plan-cap responses return clean MCP errors (localized).

---

## PHASE 1 — Certified Cross-App Store Relaunch (Weeks 6–14) — Product: DeeWaanAI Market

Goal: public certification reports, Stripe purchases, purchase → MCP entitlement.

### New files

```
api/routers/certification.ts   # public: report pages data (grade, kappa, samples), badge endpoint
api/services/entitlementSync.ts# purchase/refund → entitlements table writes
src/pages/CertificationReport.tsx  # public, SEO-critical page
src/pages/Pricing.tsx
```

### Modified files

- `api/routers/marketplace.ts` → `purchase` becomes: create Stripe Checkout Session → webhook fulfills → `entitlements` grant (`capability: pipeline:run:<listingId>`, source `purchase`). Refunds revoke. **All your existing deposit/refund-ledger/Kappa logic stays untouched** — it's the product.
- `api/mcp/tools/listPipelines.ts` → union of: owned + team-shared + **purchased entitlements** (this is the "buy once, run in your app" moment).
- `src/pages/MarketplaceDetail.tsx` → certification report preview + buy button (Stripe); encrypted prompts stay encrypted — buyers never see them (already implemented in schema).
- Public pages: add `hreflang` + locale negotiation (Accept-Language → en/zh), `og:` tags, JSON-LD `Product`/`Review` structured data so certification grades show in search results.
- Reviewer economy: payout path changes from "subscription days" field → `entitlements` grant (capability `tier:master`, duration N days) — data-driven, no user-row mutation.

### Scale notes
- Certification report pages: static-friendly JSON → CDN-cacheable (Cloudflare), revalidated on grade change.
- Marketplace search: keep SQL for now; isolate behind `api/services/search.ts` interface so Meilisearch drops in later without router changes.

### Acceptance gate
Buy a listing with Stripe test card → appears in Claude Desktop tool list within 60s → runs → refund revokes it. Public report page indexed and localized.

---

## PHASE 2 — TeamSync (Weeks 10–18, overlaps Phase 1) — Product: TeamSync

Goal: mixed-app teams share memory, runs, handoffs, feedback — nobody switches desktop apps.

### New files

```
api/mcp/tools/team/
  teamContext.ts      # team_context_get / team_memory_append (shared project brain)
  teamRuns.ts         # team_runs_list, team_run_resume
  teamHandoff.ts      # team_handoff: assign pending approval → notification → appears in teammate's app
  teamFeedback.ts     # team_feedback_submit → existing feedback pipeline
  teamSkills.ts       # team_skills_list / team_skill_use (shared + licensed pools)
api/services/sharedMemory.ts  # team-scoped wrapper over memoryManager/stateSummarizer
src/pages/TeamConnect.tsx     # invite acceptance + per-app connect guide for teammates
db/migrations/00Z_teamsync.sql # team_seats (teamId, seats, stripeSubItem), memory_locks (optimistic concurrency)
```

### Key design decisions

- **Tokens are team-aware:** the MCP JWT carries `userId`; team context is resolved per-call from `teamMembers` (no token reissue on team changes — resilience rule: memberships change often, tokens shouldn't).
- **Shared memory concurrency:** episodic memory is append-only (no conflicts); project state file gets optimistic locking (`memory_locks`: version + last-writer) — worst case a teammate re-reads and retries; never lost writes.
- **Cross-app handoff** reuses what exists: `swarmRuns.executionState.pendingApproval` + `notifications` + `approveStep`. New piece: `assigneeUserId` on the pending approval, and `team_runs_list` surfaces "waiting for you" items at the top — Bob opens Kimi, sees Alice's run waiting for his approval, approves, worker resumes. This is the magic demo.
- **Seat billing:** Stripe subscription item with quantity = seats; member add/remove → quantity update with proration. `vouchers` table reused for team trials (already supports tier + duration + max uses).
- **Feedback from any app:** `team_feedback_submit` writes into your existing `feedback` table with MCP context (host app, tool, run) → existing triage → issues → fix verification loop. Zero new backend logic beyond the tool.

### Acceptance gate
Two teammates on **different desktop apps** share one project: Alice starts a run in Claude → Bob approves step 3 in Kimi → both see the same audit chain and shared memory; remove a seat → Stripe prorates → MCP access revoked within one token TTL.

---

## PHASE 3 — Enterprise (Month 5+)

| Capability | Implementation |
|---|---|
| SSO (SAML/OIDC) | `api/services/sso.ts` + `sso_connections` table; login page branches by email domain |
| On-prem relay | Ship `docker-compose.relay.yml`: outbound-only connector that registers with cloud — solves ChatGPT's remote-only constraint for data-residency customers |
| Compliance exports | Extend `export` router: full audit-ledger export (runs, tokens, approvals) as signed JSON/CSV, admin-downloadable |
| SLA + scale | Read replica for MySQL (drizzle read/write split), CDN in front of public pages, per-customer rate-limit tiers |

---

## DB Migration Summary

| Migration | Tables |
|---|---|
| `00X_foundation` | `subscriptions`, `entitlements`, `usage_counters`, `idempotency_keys` |
| `00Y_mcp` | `oauth_clients`, `oauth_refresh_tokens`, `mcp_audit_log` |
| `00Z_teamsync` | `team_seats`, `memory_locks`, `approval_assignments` |
| Phase 3 | `sso_connections`, `relay_registrations` |

All additive — no column drops, no data backfills that lock tables. MySQL 8 online DDL throughout.

---

## Dependency & Install List (new, total)

```
@modelcontextprotocol/sdk   # MCP server + transports
bullmq ioredis              # queue + pub/sub (F0)
stripe                      # billing (F0)
@sentry/node                # observability (F0)
```
That's the entire new dependency surface for all three products. No framework changes.

---

## Testing & Rollout

- **Per phase:** contract tests for every MCP tool (zod in/out), entitlement matrix tests (user × capability × source), i18n key-completeness CI check, hosts-matrix smoke checklist (Claude / ChatGPT / Qwen / Kimi) before flag rollout.
- **Rollout:** each phase ships behind its `featureFlags` key at 5% → 50% → 100%; `mcp_audit_log` + `usage_counters` are the live dashboards for the North Star (weekly cross-app pipeline runs).
- **Rollback:** flags off = new routes return 404/403, existing product untouched. No phase requires an irreversible migration.

---

## Build Order Summary

```
F0 Foundation (1 wk) ──► Phase 0 Companion MCP (5 wks) ──► Phase 1 Store (6 wks, wks 6–14)
                                          └────────────► Phase 2 TeamSync (6 wks, wks 10–18, overlaps)
                                                            └──────────► Phase 3 Enterprise (month 5+)
                                                                        └─► FINAL: Cleanup & Handover Sprint
```

---

## FINAL SPRINT — Cleanup & Handover (after Phase 3, before scale-up)

Goal: the repo reads as ONE coherent product — no dead code, no dual paths, any new engineer can navigate it.

1. **Entitlement migration sweep** — replace every remaining direct `tier ===` / legacy voucher check in pages and routers with `entitlements.can(...)`; delete the old code paths (grep-verified zero remaining).
2. **Feature-flag burial** — for every flag at 100% rollout (`companion_mcp`, `store_relaunch`, `teamsync`, …): delete the flag row, the off-branch, and any unreachable code it guarded.
3. **Dead-code elimination** — run `knip` (or `ts-prune`) for unused files/exports; verify each candidate against dynamic imports (workers, plugins) before deletion; `tsc` + test suite must stay green after every removal batch.
4. **Route & page audit** — confirm every route in `App.tsx` and every tRPC router has a live UI/consumer; reposition the old chat-first navigation to the Studio/Market/Teams structure; remove orphaned pages.
5. **Docs handover** — replace the Vite-template `README.md` with a real project README (what it is, how to run, deploy, env vars); write `ENGINEERING.md` (module map, request flows, how to add a language / an MCP tool / a billing plan / a provider); archive the strategy docs under `DeeWaanAI-Next/`.
6. **Final gate** — clean clone → `npm ci` → `npm run check` → `npm run i18n:check` → `npm test` → production build → boot smoke, all green; deploy from that verified state.
