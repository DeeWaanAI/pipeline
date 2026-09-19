# Phase 2 — TeamSync: Coordination Spec (2026-07-13)

Goal (roadmap §PHASE 2): mixed-app teams share memory, runs, handoffs, feedback — nobody switches desktop apps.
Reference: `DeeWaanAI-Code-Update-Roadmap.md` Phase 2 + `DeeWaanAI-Next/PROGRESS.md`.

## Already done (do not redo)

- `db/migrations/012_teamsync.sql` — `team_seats`, `memory_locks`, `approval_assignments` (written)
- `db/schema.ts` — drizzle defs `teamSeats`, `memoryLocks`, `approvalAssignments` (lines ~1113+)
- `api/config/plans.ts` — `team_seat` plan exists (`env.stripePriceTeamSeat`)
- `api/services/tokenService.ts` — scopes `team:read` / `team:write` already issuable

## Stack / conventions (verified from code)

- Hono + tRPC + MySQL/drizzle + React 19 + i18next. No git repo — parallel workers edit DISJOINT file sets in the shared directory.
- MCP tool shape (`api/mcp/types.ts`): `{ name, description, inputSchema (zod), requiredScopes, annotations:{readOnlyHint, destructiveHint?}, handler(args, ctx) }`. `McpAuthContext = { userId, scopes:Set<string>, clientId, requestId, locale }`.
- Tool registry: `api/mcp/tools/index.ts` flat `TOOLS` array; server filters/authorizes per ctx.
- Access helper: `canAccessProject` / `requireProjectAccess` in `api/mcp/tools/_shared.ts` (owner OR team member via teamMembers⨯teamProjects). Use BEFORE returning data or mutating.
- Errors: throw plain `Error` with user-safe text; server localizes. Log with `logger` from `api/lib/logger` incl. `requestId`, `clientId`, `userId`.
- Memory storage: disk-backed `api/mcp/tools/_memoryStore.ts` (`loadEpisodes/saveEpisodes/loadState/saveState`); episodes via `memoryManager.createEpisode/rotateEpisodes`; state shape via `stateSummarizer`.
- Feature flags: `isFeatureEnabled(key, userId)` from `api/plugins/featureFlags.ts`. Phase 2 flag key: **`teamsync`**.
- Billing: `api/services/billingService.ts` (`getStripe()`, `isBillingConfigured()`, `createCheckoutSession`, `handleStripeEvent`); webhook route `api/billing-webhook-route.ts`; idempotent fulfillment pattern in `api/services/entitlementSync.ts`; clean 503/skip when unconfigured.
- Team router: `api/routers/team.ts` — hooks for seat sync: `create`, `joinByCode`, `removeMember`, `delete`. Roles: owner/admin/tester/viewer.
- Runs: `swarmRuns` table; `executionState.pendingApproval`; resume = `enqueueSwarmRun(runId, userId)` from `api/workers/swarmWorker.ts` (see `api/mcp/tools/approveStep.ts` + `api/routers/swarm.ts` resumePipeline).
- Notifications table exists (`api/routers/notification.ts`, schema `notifications`).
- Feedback table + insert pattern: `api/routers/feedback.ts`.
- i18n: one block per namespace in `src/i18n-languages.ts`; `npm run i18n:check` enforces en/zh key parity (server too).
- Gates: `npm run check` (tsc -b), `npm run i18n:check`, `npm run build` — all must stay green.

## Worker A — Team MCP tools + shared memory (backend)

Owns (write): `api/services/sharedMemory.ts` (new), `api/mcp/tools/team/*` (new: teamContext.ts, teamRuns.ts, teamHandoff.ts, teamFeedback.ts, teamSkills.ts), `api/mcp/tools/index.ts` (register), `api/mcp/types.ts` (additive only), `api/mcp/server.ts` (flag filtering), `api/mcp/tools/approveStep.ts` (assignment completion), `api/routers/swarm.ts` (approveStep mutation: assignment completion only).
Reads (do not edit): `api/routers/team.ts`, `api/routers/feedback.ts`, `api/routers/swarm.ts` (resumePipeline), `api/services/memoryManager.ts`, `api/services/stateSummarizer.ts`, `api/mcp/tools/_memoryStore.ts`, `db/schema.ts` (notifications, feedback, swarmRuns, approvalAssignments, memoryLocks, teamMembers, teamProjects).

Contract:
1. `McpTool` gains OPTIONAL `featureFlag?: string`. In `server.ts`, tools declaring a flag are hidden from tools/list and their calls rejected (clean localized error) unless `isFeatureEnabled(flag, ctx.userId)`. Additive — existing tools unaffected.
2. All team tools set `featureFlag: "teamsync"` and scopes `team:read` (readers) / `team:write` (writers).
3. `sharedMemory.ts` — team-scoped wrapper over `_memoryStore` + `memory_locks`:
   - `getSharedContext(userId, projectId)` → episodes (newest first, capped) + state + lock version; requires team access (project must be shared with a team the user belongs to — personal-only projects rejected).
   - `appendSharedEpisode(userId, projectId, note, origin)` → append-only episode (no lock needed).
   - State writes use optimistic locking: `UPDATE memory_locks SET version=version+1, last_writer_id=? WHERE project_id=? AND version=?`; affectedRows=0 → throw conflict error telling caller to re-read and retry. Insert lock row (version 1) on first use.
4. `team_context_get` (teamId, projectId) — membership check → shared context via sharedMemory. `team_memory_append` (teamId, projectId, note) — membership check → append episode attributed to `userId`/`clientId` (+ bump state recentActivity through the locked path).
5. `team_runs_list` (teamId, limit?) — membership check → `{ waitingForYou: [...], runs: [...] }`. waitingForYou = `approval_assignments` where assignee=ctx.userId AND status=pending (join swarm_runs + projects for title/status/current step). runs = recent swarmRuns on projects shared with the team, compact shape (id, projectId/name, status, pendingApproval?, updatedAt), capped (default 20).
6. `team_run_resume` (runId) — access check (owner or canAccessProject); if a pending assignment exists for this user+run it stays pending until approve_step; resume = mirror `resumePipeline` in swarm.ts → `enqueueSwarmRun`. Returns status.
7. `team_handoff` (runId, assigneeUserId, note?) — caller must have run access; assignee must share a team with the run's project (teamMembers⨯teamProjects). Insert `approval_assignments` (status pending, assignedBy=ctx.userId) + a `notifications` row for the assignee (mirror existing notification insert shape). One pending row per (run, assignee) — update note if one exists.
8. `team_feedback_submit` (category?, message, runId?) — insert into `feedback` mirroring `api/routers/feedback.ts` minimal insert, with MCP context (clientId as source/host, tool name, optional runId) in the fields the schema provides.
9. `team_skills_list` (teamId) — membership check → union of shared pipelines (mirror `getSharedPipelines`), shared agents (mirror `getSharedAgents`), and caller's marketplace-licensed pipelines (`getActiveEntitlements` from `api/services/entitlements.ts`, capability prefix `pipeline:run:`). Compact items: {kind, id, name, owner/project}.
10. `team_skill_use` (teamId, kind:"pipeline"|"agent", id, targetProjectId) — mirror `team.importPipeline` / `team.importAgent` (verify membership + target project ownership; inserted copy disabled by default).
11. Assignment completion: when `approve_step` (MCP tool) OR the `approveStep` mutation in `api/routers/swarm.ts` records a decision for a run with a pending `approval_assignments` row for the deciding user, mark it `completed` (completed_at=now). Also complete/cancel assignments when a run reaches a terminal state — best-effort inside the same approve paths; do NOT touch worker execution logic.

## Worker B — Seat billing with proration (backend)

Owns (write): `api/services/billingService.ts`, `api/routers/billing.ts`, `api/routers/team.ts` (seat-sync hooks only — do not change other logic), `api/billing-webhook-route.ts` (only if needed), `.env.example` (only if a new env var is needed).
Reads: `api/config/plans.ts`, `api/services/entitlementSync.ts`, `api/services/entitlements.ts`, `db/schema.ts` (teamSeats, subscriptions, entitlements).

Contract:
1. `billingService.createTeamSeatCheckoutSession({ teamId, userId, seatCount })` — Stripe Checkout `mode: "subscription"`, price = `PLANS.team_seat.priceId`, quantity = seatCount, metadata `{ type: "team_seats", teamId, userId }`. Clean error/503 when billing unconfigured or priceId empty.
2. Webhook (`handleStripeEvent`) — branch `checkout.session.completed` with metadata.type === "team_seats": retrieve subscription → upsert `team_seats` (teamId, seats=quantity, stripeSubscriptionId, stripeSubscriptionItemId), idempotent per session (pattern from entitlementSync). Handle `customer.subscription.deleted` for those subscription ids → remove/deactivate team_seats row. Grant team owner entitlement capability `team:sync` (source "subscription") while active — follow existing grant/revoke patterns.
3. `syncTeamSeatQuantity(teamId)` — count `team_members`; upsert seats column; if a stripeSubscriptionItemId exists and quantity changed → `stripe.subscriptionItems.update(item, { quantity, proration_behavior: "create_prorations" })`. Swallow Stripe errors with a logged warning (member changes must not fail because billing hiccuped).
4. Hooks in `api/routers/team.ts`: `create` → insert team_seats row (seats=1, no stripe refs); `joinByCode` → after insert, `syncTeamSeatQuantity(teamId)`; `removeMember` → after delete, sync; `delete` → if stripe sub exists, cancel it (best-effort) then delete team (team_seats cascades).
5. `api/routers/billing.ts` — add `createTeamCheckout(teamId)` (owner-only: verify `teams.ownerId === ctx.user.id`; seatCount = current member count) and `teamSeatStatus(teamId)` (member-visible: seats, hasActiveSubscription). Follow existing router conventions in that file.
6. Access revocation is inherent: MCP team tools resolve membership per call, so a removed member loses team access within one token TTL — do NOT build token revocation.

## Worker C — TeamConnect page (frontend)

Owns (write): `src/pages/TeamConnect.tsx` (new), `src/locales/en/teamsync.json` (new), `src/locales/zh/teamsync.json` (new), `src/App.tsx` (lazy import + `<Route path="/team/connect" .../>`), `src/i18n-languages.ts` (one import pair + one namespace key per language).
Reads: `src/pages/Connect.tsx` (per-app connect guide pattern to mirror), `src/pages/TeamDashboard.tsx` (trpc client usage + team endpoints), `src/locales/en/connect.json` (i18n shape).

Contract:
1. `/team/connect` page, namespace `teamsync`, all user-facing strings via `t()` — zero hard-coded English/Chinese.
2. Sections: (a) team picker/join — uses EXISTING endpoints only (`team.listMyTeams`, `team.joinByCode`, `team.getTeam`); (b) per-app connect guide for teammates (Claude Desktop / ChatGPT / Qwen Code / Kimi) mirroring Connect.tsx structure, with copy-paste config snippets pointing at `/mcp`; (c) "waiting for you" hint explaining cross-app handoff (static explanatory content — do NOT call not-yet-existing team MCP tools from the web UI).
3. Follow existing page conventions (shadcn/ui components, sonner toasts, lazy-loaded route).
4. Do not add npm dependencies.

## Merge & verification (main agent)

1. Review all worker diffs; resolve any scope violations.
2. `npm run check` → `npm run i18n:check` → `npm run build` — all green.
3. Boot smoke: server boots; `teamsync` flag off → team tools hidden/rejected; flag on → tools listed; team_seats flow billing-gated when unconfigured.
4. Update `DeeWaanAI-Next/PROGRESS.md` Phase 2 section.
