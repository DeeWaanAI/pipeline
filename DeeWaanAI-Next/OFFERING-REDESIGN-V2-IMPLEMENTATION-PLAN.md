# DeeWaanAI Offering Redesign — Implementation Plan (app25_v2)

**Version:** 1.0
**Date:** 2026-09-19
**Governing specification:** `DeeWaanAI-Next/OFFERING-REDESIGN-TECH-SPECS.md` (v2.0) — it governs; this plan only sequences its execution.
**Workspace:** `/Users/youssefhariri/Documents/app25_v2` — full copy of the app taken 2026-09-19 from `app 25` @ commit `ee01f07`, excluding `research/`, `vibe_images/`, `learning-chinese/`, `.paper-research/`, `node_modules/`, `dist/`.
**Hard rule:** the original folder `app 25` is never modified. All v2 code changes happen here.

---

## 0. Scope and standing constraints

1. Spec §1.3 open policies P1–P7 remain open. Phases below are structured so that **private evaluation and durable design (unblocked work) proceed while paid/public features stay flag-disabled** — exactly as the spec requires.
2. Additive, reversible migrations only. No table/column drops. No cascade-delete of purchased/evidentiary data. No touching research archives, backups, or TeamSync data.
3. Feature flags gate every v2 entry point; rollback = disable flags + stop v2 workers, never schema removal.
4. Environment separation is absolute: the new Railway service gets its **own database and Redis**. It never shares the live production DB with the current `deewaanai.com` service (split-brain writes to `swarm_runs`/billing state would corrupt both).
5. Acceptance tests (spec §14, A01–A22) are the completion gate for each phase, not an afterthought.

---

## 1. Phase P0 — Workspace bring-up and baseline (local, ~first session)

**Goal:** app25_v2 builds, boots, and is baselined as a distinct deployment artifact.

- [ ] `npm ci` in `app25_v2` (lockfile is the copy's own).
- [ ] `npm run check` and `npm test` — confirm the copy inherits a green baseline (fix nothing that isn't broken first; record pre-existing failures instead).
- [ ] Local dev stack: point `.env` at a **fresh local MySQL schema + Redis** (docker-compose files already exist). Never aim dev migrations at the prod DB.
- [ ] Git: `git init` a **fresh history** in app25_v2 (or repoint remote to a new `deewaanai-v2` repo — decision needed, see §6 D-a). Tag `v2-baseline` at the imported commit so every later diff is measurable against `ee01f07`.
- [ ] Record G0 inventory (spec §13): current schema/migration list (`db/migrations` stops at 021; top-level `migrations/` holds legacy SQL — reconcile which runner owns what before allocating 022), feature flags in `api/plugins/featureFlags.ts`, listing statuses, plans in `api/config/plans.ts`, entitlement strings, pending Stripe events.

**Gate:** `npm run build` passes; baseline tag exists; G0 inventory doc written to `DeeWaanAI-Next/G0-INVENTORY.md`.

---

## 2. Phase P1 — Additive foundations (spec W1 + G1) — **implemented 2026-09-19**

**Goal:** all new tables, contracts, and flags — zero behavior change to existing flows.

Files: `db/schema.ts`, `db/migrations/022_offering_redesign_v2_tables.sql`, `contracts/offeringV2.ts`, `api/plugins/featureFlags.ts`.

Implemented as one migration (25 new tables); the spec's 022…02N split was judged unnecessary — restartability was instead proven by double-apply + byte-parity vs `db:push`. Legacy tables untouched: listing v2 pointers and checkout quotes live in 1:1 attachment tables (`marketplace_listing_v2`, `marketplace_checkout_quotes`) rather than ALTER on old rows.

- [x] **Versioning core:** `pipelineVersions` (immutable snapshot + hash + designer metadata + parent lineage; `restrict` deletes so evidentiary versions survive source deletion).
- [x] **Design jobs:** `designJobs` (lease token, apply-state, actor-scoped idempotency) + `jobOutbox` + `projectRevisions` (optimistic apply without touching `projects`).
- [x] **Evaluation core:** `benchmarks`/`benchmarkCases`/`benchmarkCandidates`/`benchmarkRuns`/`benchmarkJudgments`/`callAttempts`/`spendApprovals` — §6.3 decimals (`DECIMAL(7,6)` normalized, `DECIMAL(8,4)` raw so 10.00 fits, `DECIMAL(18,8)` cost); `aggregateAvailability` prevents silent reweighting; `uncertain` outcomes preserved.
- [x] **Publication/community:** `evidencePublications` (`testedAt` ≠ `publishedAt`, supersede chain), `externalEvidenceReports` (declared-only), `evidenceReports` (no auto-penalty), `marketplace_listing_v2` (`publicationMode legacy|v2`).
- [x] **Access/financial (schema now, use later):** `executionGrants`, `trialGrants`+`trialReservations` (unique operation key), `settlementEntries` (per-sale commission basis/rate snapshot), `payoutAttempts` (stable key, provider-confirmed only), `marketplace_checkout_quotes`.
- [x] **Model freshness:** `modelCatalog`, `modelReleaseEvents`, `retestSuggestions` (dedupe per seller/version/event/channel).
- [x] **Trusted egress:** `trustedProviderEndpoints` (logging disclosure + protection class; seeded empty until P6).
- [x] Keys/indexes per §6.5; over-64-char generated FK names replaced with explicit short builders (MySQL ER_TOO_LONG_IDENT).
- [x] **Contracts:** `contracts/offeringV2.ts` — private vs public DTOs (DB rows never public), execution purposes, decimal-string score/money schemas, call-plan arithmetic, structured error catalog.
- [x] **Flags:** five v2 flags added to `seedDefaultFlags()`; executed against local DB → all present and `false`.
- [x] Migration rehearsal (local): 022 applied twice → restartable ✅; resulting schema diffed against `db:push` output → **identical** ✅. Restored-production-copy rehearsal happens with the staging DB in P6.

**Gate: PASSED** — `npm run check` ✅; tests unchanged (232/236, same 4 pre-existing throttle failures as baseline); 58→83 tables additive.

---

## 3. Phase P2 — Durable design + private evaluation (spec W2 + G2) — **the unblocked core**

**Goal:** Auto-design as durable jobs; Test journey (grade-only + optional comparisons) end-to-end, private, flag-gated. No marketplace, no payments.

### P2a — Auto-design refactor (spec §5.1–5.2) — **implemented 2026-09-19**
- [x] Split into three modules, one designer implementation: `designJobMeta.ts` (v1 prompt verbatim + types + pure parse), `designGenerationService.ts` (the only provider call, `uncertain` attempt outcomes), `designJobService.ts` (validate + revision-safe apply + lifecycle). `autoDesignService.ts` is now the legacy sync wrapper over the same helpers.
- [x] `designJobService` + `api/routers/designJobs.ts` (`start/get/cancel/applyCandidate` — `apply` is a reserved tRPC key) registered in `api/router.ts`; queue via `api/infra/queue.ts` (`design-jobs`), job+outbox in ONE transaction, ER_DUP_ENTRY race → existing job returned; DB lease/generation token; 60s reconciler + boot heal in `boot.ts`/`workerEntry.ts`.
- [x] MCP: added `start_design_job` (durable, owned-provider only — sampling never enqueued), `design_job_status`, `cancel_design_job` — all `featureFlag: "v2DesignJobs"` (server hides when off); help + helpContent updated. Legacy `design_pipeline` UNCHANGED (sampling stays sync/non-durable until applied through v2).
- [x] Compatibility: `swarm.autoDesign` return shape unchanged; graph validation now also guards the legacy write path (invalid design never deletes existing steps — behavior improvement, flag-free).
- [x] Migration 023 (additive design_jobs columns) + schema.ts mirror; local stack isolated (`docker-compose.v2.yml`, ports 3307/6380).
- [x] Tests: 12 unit (A03 validation incl. dangling routes, self-loops, oversized, approval-steps-kept) + 8 DB-backed integration (A03 retain-on-conflict, A04 idempotency + shared-authz provider ownership, A05 lease/crash-heal/cancel-race). Full suite 252/256 = baseline + 20 new.
- [ ] Deferred to P2b by design: `callAttempts` ledger for design calls (job carries `provider_call_attempts` JSON bridge), spend-approval binding (flag + owned provider enforce the interim).

**Gate: PASSED locally.** Live end-to-end with a real BYOK key + queue drill (Redis kill) belongs to the P6 staging rehearsal.

### P2b — Benchmark engine (spec §4.1–4.2, §7, §9)
- [ ] `api/services/benchmarkService.ts`: draft → freeze plan+hash → quote → atomic spend approval → fan-out via coordinator reusing `swarmService` execution loop against **immutable snapshots** (never rewrite mutable user projects per candidate).
- [ ] Modes: `grade_only` (default, A01), `compare_models` (whole-workflow override, A02), `compare_frontier_solo`.
- [ ] Rubric editor storage + judges as explicit config; pairwise blinded orientation; injection hardening per §7.1; deterministic validators only where sandbox exists, else disabled.
- [ ] Cost preflight per §9 arithmetic (C×M×R×J etc.), unknown-as-unknown pricing, `callAttempts` append-only ledger.
- [ ] `api/routers/benchmark.ts`: `create/updateDraft/prepareRubric/prepareCases/quote/start/get/cancel/resume`.
- [ ] Descriptive-only summaries (§7.2): counts, spread, agreement, failures, observed cost. No CIs, no "equivalent quality" badges (A07).
- [ ] Tests: A01, A02, A06 (plan change invalidates approval; resume preserves attempts), A08 (18 vs 9 judgment arithmetic), A21.

**Gate:** an internal user can auto-design and grade a private pipeline output with durable jobs, full cost ledger, cancel/resume; queue-fault drills pass (A01–A08 at the private-journey level).

---

## 4. Phase P3 — Evidence, publication, protected execution (spec W3 + G3)

**Goal:** the transparency marketplace mechanics — still flag-gated, live public launch waits on P7 policy approval.

- [ ] `api/services/evidenceService.ts`: manifest builder (§7.3 full disclosure list), preview hash, consent gate, `published → withdrawn` states, replacement-publication lineage.
- [ ] `marketplace.publishVersion` as sole seller boundary (§10.1); community publish/report/withdraw; public endpoints return manifest DTOs only (§6.2).
- [ ] `api/services/marketplaceExecutionService.ts`: buyer run loads seller's immutable version in restricted context (§8.1) — refactor `swarmService` to accept authorized snapshot loader; no copies into buyer-owned steps/templates.
- [ ] Trusted-endpoint policy (§8.2): approved-provider allowlist resolved server-side; private-network/redirect/custom-buyer-endpoint rejection for protected assets; document provider logging exposure per allowed class.
- [ ] Admission order + atomic trial reservation skeleton (§8.3) — reservation logic lands here but `v2Commercial` stays off.
- [ ] Model catalog + release-event suggestions (§12.1): versioned catalog table, admin-reviewed events, deduped notices; **no auto paid retest**, no email until a delivery integration is confirmed.
- [ ] Legacy certification paths blocked from publishing v2 listings (run old flows against v2 fixtures).
- [ ] Tests: A09–A14, A19 — esp. the leakage battery (A12: template apply/duplicate, MCP reads, SSE, export, signed URLs, error strings, logs).

**Gate:** seller can publish a complete-evidence listing and a buyer can run it server-side with zero prompt leakage across audited surfaces, in staging with synthetic data.

---

## 5. Phase P4 — Commercial cutover (spec W4 + G4) — **policy-blocked by design**

Cannot start until owner resolves: P1 (payer matrix), P2 (license model), P3 (payout provider, holds, refunds, taxes), P4 (trial policy), P5 (limits/grace/legacy tiers), P6 (approved endpoints + release source), P7 (public-data consent/moderation policy).

Once resolved:
- [ ] `solo` plan → USD 9.99 monthly: Stripe price object, `PLAN_CAPABILITIES` + tier-grant mapping reviewed as one permission service across HTTP/MCP/workers (§11.1, A16). Existing subscribers untouched until an approved migration policy.
- [ ] Purchases: immutable quote rows; reuse `fulfillMarketplacePurchase`/`PLATFORM_FEE_RATE=0.30` path — no second ledger; webhook idempotency hardened (§11.2, A17).
- [ ] `settlementService` + payout lifecycle (§11.3): claim allocation → provider transfer with stable key → **only provider-confirmed success marks paid**; `unknown` reconciliation path (A18). Payout provider (Stripe Connect or other) verified in sandbox + limited live check first.
- [ ] Trials enabled per approved P4 policy; holds per P3.
- [ ] Paid-but-unfulfillable reconciliation path tested before any live sale (spec §11.2).

**Gate:** full acceptance matrix A15–A18 in sandbox + approved live checks.

---

## 6. Phase P5 — Frontend (spec W5) — parallel from P1 contracts onward

- [ ] Benchmark workspace page (new, routed in `src/App.tsx`): grade-only default, existing-output grading, optional comparisons, rubric/case editors, judge picker, cost-approval dialog with call-plan table, progress/cancel/resume.
- [ ] `PipelineEditor.tsx` / `PipelineConfigurator.tsx`: surface plain solo + solo-plus-refine templates; advanced graph stays; no forced refine (A22).
- [ ] `MyPipelines.tsx`: Evaluate action + auto-design job status/apply.
- [ ] `MarketplaceBrowse.tsx` / `MarketplaceDetail.tsx`: evidence/model/date summary, full manifest, community filter, report/reply flow; no "human certified" wording for v2.
- [ ] `CreatorDashboard.tsx`: versions, publication consent preview, suggested retests, earnings labeled held/eligible/paid.
- [ ] i18n for all new strings (en/ar/zh per existing pattern); `npm run i18n:check` green; backend authorization enforced even where UI hides controls.

---

## 7. Phase P6 — New Railway service (staging now, domain later)

**Topology (no shared state with current prod):**

```
current prod (untouched):  deewaanai.com → Railway web+worker → MySQL-prod + Redis-prod
v2 staging:                app25-v2 + worker → Railway preview domain → MySQL-v2 (restore of latest S3 prod snapshot) + Redis-v2
future cutover:            deewaanai.com → v2 service (only after P6 verification + written go decision)
```

- [ ] New Railway project `deewaanai-v2`: web service (from the v2 repo/Docker image), worker service (`START_WORKER=true`, `node dist/workerEntry.js` per existing pattern), MySQL instance, Redis instance — all fresh, none shared with prod.
- [ ] Env: copy non-secret var names from prod `.env.example`/DEPLOY.md checklist (APP_SECRET, AI_SWARM_MASTER_KEY, MARKETPLACE_MASTER_KEY, new DATABASE_URL, REDIS_URL…); **fresh secrets** for DB/crypto; **no live Stripe keys** — test-mode only until P4; feature flags per phase (`v2Commercial=false`).
- [ ] Restore the latest daily S3 prod backup into MySQL-v2 (proves migrations against real-shape data; gives testable users/pipelines). Scrub or restrict personal data; disable live billing/email/scheduled spend on staging.
- [ ] Run all v2 migrations on restored DB; boot web+worker; health check.
- [ ] CI: separate GitHub Actions deploy workflow (auto-deploy on push to v2 branch/main of v2 repo).
- [ ] Smoke: full private-evaluation journey + durable design-job journey on staging with synthetic BYOK keys.
- [ ] Domain cutover runbook drafted (DNS swap, freeze-window plan, rollback = repoint DNS back) — **executed only on explicit owner authorization**, per the archive/deletion-safety standing rules.

---

## 8. Delegation and parallelization (per spec §15)

| Wave | Packages | Owner boundary |
|---|---|---|
| Now | P0, then P1 (W1) | One integration owner exclusively holds `db/schema.ts`, `contracts/`, `api/router.ts`, flags |
| After P1 | P2a ∥ P2b ∥ P5 | P2a owns `autoDesignService`+designJobs+MCP tools; P2b owns `benchmarkService`+router; P5 owns `src/**` against frozen contracts + labeled fixtures |
| After P2 | P3 ∥ P5 continued | P3 owns evidence/marketplace-execution services + catalog |
| After policy resolution | P4 | Single owner; billing files off-limits to others |
| End | P6 verification + W6 | Cross-path authz drills, fault/load tests, acceptance matrix |

Never two agents in: designer prompt, billing semantics, evidence model, protected-execution policy.

---

## 9. Immediate next actions (awaiting go)

1. `npm ci` + `npm run check` + `npm test` in app25_v2 → record baseline. *(D-b: OK to run now?)*
2. Decide git model for app25_v2: fresh repo vs branch of existing. *(D-a)*
3. Confirm staging DB strategy: restore latest prod snapshot into isolated MySQL-v2. *(D-c)*
4. Then P1 migration work begins (022+).

Open owner decisions collected in one place: **D-a** git model, **D-b** start executing P0, **D-c** staging DB seeding, **D-d** v2 repo/hosting for Railway (same GitHub account, new repo?), plus spec's P1–P7 policy register which only gates Phase P4/P6-cutover.
