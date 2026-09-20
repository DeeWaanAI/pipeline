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

### P2b — Benchmark engine (spec §4.1–4.2, §7, §9) — **in progress 2026-09-20**
- [x] Engine (`api/services/benchmark/benchmarkService.ts`, split from the single proposed file): draft → freeze plan+hash → quote → atomic spend approval → fan-out reusing the `swarmService` execution loop against **immutable snapshots** (`executeSwarmRun({ snapshotVersionId })`; the mutable project steps are never read or written). Proven end-to-end on real MySQL by `api/services/benchmark/benchmarkService.integration.test.ts`: create→quote→approve→start leaves 3 pending children bound to the frozen version and **zero** `call_attempts` (nothing spent before execution). No `jobOutbox` here, unlike P2a: dispatch is post-commit plus reconciler re-dispatch of `queued` rows.
- [~] Modes: `grade_only` is the default ✅ and A01 now holds — a candidate can be an EXISTING owned output (`strategy: "imported_output"` + `imported_response_id`, migration 027), which contributes zero generation calls, zero repeats, is executed by copying and hashing the owner's text, records `importedProvenance.kind = owned_run`, and appears in the summary as `graded_existing_output__not_executed_by_this_plan` so P3 can never pass it off as execution evidence. Cross-tenant import is rejected. `compare_models` override proven at execution level ✅ (every model-backed step including an if-gate carries the override — asserted against the version the engine actually loaded); `compare_frontier_solo` builds the baseline version, frontier selection/limits still open. Mode↔candidate-shape contradictions are rejected by preflight before any write.
- [x] Rubric editor storage ✅ (presets + authoritative server-side weight normalization + `versionRef`; a preset load makes no paid call, LLM assist refuses), judges as explicit config ✅, pairwise blinded orientation ✅, §7.1 injection hardening ✅ — and now TESTED: forged UNTRUSTED markers in a candidate output cannot open a second region (delimiters stripped, payload retained as data), out-of-range/missing dimensions are `validation_failed` with no coerced score, unparseable output has no score at all. Deterministic validators: **explicitly disabled and disclosed**, not silently absent — the plan carries `validators: []`, the quote and the summary both state that no validation happened and why (spec §7.1 requires an isolated sandbox this deployment does not have); enabling one is a preflight error. That is A21's containment half; the sandbox half stays out of scope while no sandbox exists.
- [x] Cost preflight per §9: generation calls are now a **SUM over candidates** (`contracts/offeringV2.ts` wording) with a per-candidate breakdown in the quote for the P5 cost table; rubric C×M×R×J vs pairwise C×PR×P×J×O pinned by unit test (18 vs 9, A08) and reconciled against the ledger on a real run. Unknown-as-unknown pricing ✅, `callAttempts` append-only ledger ✅, and the plan/ledger UNIT DIFFERENCE is disclosed in the summary (`plannedCalls` vs `observedOperations` + a note) instead of being left for a reader to assume.
- [x] `api/routers/benchmark.ts`: `create/updateDraft/prepareRubric/prepareCases/quote/approveSpend/start/get/cancel/resume/list`. `v2Benchmarks` gates every entry point AND the worker + reconciler (a queued job stays queued while the flag is off, so flag-off is a real rollback).
- [x] Descriptive-only summaries (§7.2/A07): counts, spread, mean, **judge agreement** (panels graded by 2+ judges, mean absolute deviation, widest spread — labelled as observed dispersion, not reliability), failures, observed cost, validators status, provenance per candidate, explicit scope statement. Test asserts no CI/significance/"equivalent quality"/certified wording, and `grade_only` carries no ranking field at all (§4.1 step 7).
- [x] Durable-job behaviour tested at the private-journey level: §10.2 state rule FIXED (a failed child now yields `partial`, never `completed` — judging the survivors alone silently narrowed the evidence); expired-lease heal; cancellation stops dispatch without touching finished evidence; A06 resume needs a fresh approval, refuses when nothing is unfinished, re-runs ONLY the unfinished child, and appends rather than rewrites attempts. Concurrency fix: candidate versions materialize sequentially (parallel `MAX+1` allocation collided on the unique index; the retrying `createVersionRow` remains as the cross-process safety net).
- [x] MCP workbench parity (D9): `benchmark_*` tools registered behind `v2Benchmarks`, thin adapters over the same service (no bypass of authz/plan-hash/spend-approval), `deewaanai_help` "Evaluate" group gated by the same flags, and a registry↔help parity test so the guide cannot drift from what is registered.
- [x] Migrations 024 (summary), 025 (lease/cancel/source project), 026 (`benchmarks.pipeline_version_id` → NULL for drafts), 027 (`benchmark_candidates.imported_response_id` + appended `imported_output` enum value). All applied to the local dev schema; 026/027 re-applied or verified for FK/index integrity and restartability.
- [ ] Explicitly still open in P2b (not gate-blocking, must not be forgotten): `compare_frontier_solo` frontier-model selection/limits; reconciling the quote DTO with `contracts/offeringV2.ts` `CallPlanEstimateSchema` (per-line costs, assumptions, price-vector metadata, bounded-high totals) before any client renders it; the live queue-loss (Redis kill) and BYOK smoke drills, which land in P6 staging. Test inventory: 13 pure call-plan + 8 judge-containment + 7 DB golden-path + 6 DB execution + 6 MCP registry = 40 P2b tests; full suite 296 with the 4 pre-existing `providerThrottle` failures only.

**Gate:** an internal user can auto-design and grade a private pipeline output with durable jobs, full cost ledger, cancel/resume; queue-fault drills pass (A01–A08 at the private-journey level). **Substantially met locally as of 2026-09-20** — A01, A02, A06 (invalidation + resume), A07, A08 and A21's containment/disclosure half are implemented and tested; the real-broker queue drill is deferred to P6 staging exactly as P2a's was.

---

## 4. Phase P3 — Evidence, publication, protected execution (spec W3 + G3)

**Goal:** the transparency marketplace mechanics — still flag-gated, live public launch waits on P7 policy approval.

- [x] `api/services/evidenceService.ts` (commit `01be427`, 2026-09-20): manifest builder against the FROZEN `PublicEvidenceManifestSchema` (§7.3 full disclosure list: tested version identity, case count with input-disclosure mode, judge panel + agreement, per-dimension scores with declared bounds and weights, aggregation rule stated verbatim, cost, provenance per candidate, **validators disclosed as disabled** per §7.1). Preview hash = sha256 over `stableStringify(manifest)` — reproducible because `pricingAsOf` is anchored to the run's `finishedAt`, not wall clock (an early version used `new Date()` and made every preview unverifiable). Consent gate: publish refuses unless the caller supplies the exact `approvedPreviewHash` + a consent version, so consent is bound to CONTENT, not to a checkbox about the future. `draft_preview → published → withdrawn`; `supersedePublication` writes a NEW immutable row with `supersedesPublicationId` and copies `testedAt` verbatim (re-publication can never re-date evidence); `withdrawPublication` unpublishes the attached listing only when that publication was its current evidence. Policy refusals are messages, not crashes: §4.3 (imported-only output is user-reported, cannot certify a seller listing → publish as community), §7.3 (a limited-disclosure report cannot satisfy the seller gate). `scanForSecrets` blocks credential-bearing manifests. Idempotent on (benchmark, hash, kind) and bumps `evidenceSummaryRevision` on attach. Tests: 7/7 `api/services/evidenceService.integration.test.ts` (throwaway `swarm_v2test_evidence`). Surfaces and the seller boundary arrived in the next line.
- [x] `marketplace.publishVersion` as sole seller boundary (§10.1) — commit `7fd1a5e`. It takes the listing, the EXACT workflow version being sold, the benchmark, the preview hash, the consent version and an optional `expectedListingRevision`; it refuses (a) unless the evidence tested precisely that version — A11's "a new revision cannot inherit old scores" is enforced at the boundary, not left to the UI, (b) when the listing or version is not the caller's (one message for missing and foreign, so no existence leak), (c) on a project-lineage CONTRADICTION between the listing's template and the tested version, (d) on a stale revision token, checked before the idempotent-reuse short-circuit so it can never degrade into a silent no-op. Publication + `marketplace_listing_v2` pointers + the listing's `published` status land in ONE transaction; §10.2's "v2 has no `certifying` transition" holds. Community publication is a separate entry point (`publishCommunityEvidence`) that can reference a listing but never becomes its required evidence, so A09's two kinds cannot be conflated. Public endpoints return manifest DTOs only (§6.2): `getPublicEvidenceForListing`, `listPublicEvidenceForListing` (summaries derived from the STORED manifest so a summary can never disagree with the document it indexes), `getPublishedManifestByHash` (a withdrawn manifest stops resolving by hash; the row survives). `v2Publication` is enforced in the SERVICE, so every surface inherits it and flag-off is a real rollback. Surfaces: tRPC `marketplace.*` + `evidence.preview` + `communityEvidence.*`, and 7 MCP tools behind the same flag with help-catalog parity tests (D9). **Still open on this line:** `communityEvidence.reportExternal` (the `external_evidence_reports` table exists with no writer — user-declared evidence cannot be recorded yet).
- [x] `api/services/marketplaceExecutionService.ts`: buyer run loads the seller's immutable version in a restricted context (§8.1) — commit `199860d`. The existing interpreter is reused (no second runner). `swarmService`'s snapshot branch now splits three ways: owner running their own version (unchanged), buyer with a `protectedRun` context → `loadAuthorizedSnapshotSteps`, and everything else → the same "Workflow version not found" message used for a missing version, so the API never confirms another tenant's workflow exists. The authorized loader RE-RESOLVES the right at dispatch (active purchase/grant, listing still sells that version, caller-owned enabled provider, endpoint still approved) instead of trusting `run_params`, so a revocation between queuing and executing stops the run; it returns steps with `providerId` pinned to the buyer's provider and `agentId: null` (A14: no seller credential, no seller agent record), and the buyer's container project is created with zero steps/templates/agents — asserted, not assumed. Gitee/GitHub/local-folder/attachments/prior-run context stay off. The buyer view (`getProtectedRunView`) selects step METADATA only; the prompt-bearing columns are not in the query. Admission order is §8.3's, so every refusal happens before a run row exists. `purpose: "trial"` is refused while `v2Commercial` is off — P4 is unresolved and an execution refactor must not enable it.
- [x] Trusted-endpoint policy (§8.2) — commit `199860d`, `api/services/protectedEgress.ts`. https-only; no userinfo credentials; no query/fragment (a query is how an approved proxy gets told to fetch somewhere else); loopback/RFC1918/link-local-metadata/CGNAT/IPv6-ULA hostnames refused including the numeric forms a string prefix check misses; exact allowlist row match on provider + NORMALIZED baseUrl + resolved adapter kind (an approval for `anthropic` cannot authorize an openai-compatible route); provider must belong to the payer and be enabled. `trusted_provider_endpoints` ships EMPTY, so protected execution is unreachable until an admin approves each destination with its `loggingDisclosure` + `protectionClass` — the disclosure and the `standard`/`reduced` class are returned to the caller on every run. §8.2's "do not claim an allowlist guarantees secrecy" is honored literally: `PROTECTED_EGRESS_RESIDUAL_RISKS` names provider logging, prompt egress, DNS rebinding and output inference, and travels with the receipt. Redirects are refused (`redirect: "error"`) for protected calls rather than followed. Tests: 6 pure policy cases + 8 DB-backed execution cases.
- [ ] Admission order + atomic trial reservation skeleton (§8.3) — the ORDER is implemented and tested above; the trial RESERVATION still waits for policy P4 (`v2Commercial` off), and per-tenant concurrency/rate limits beyond the existing provider throttle are not yet defined by any approved policy.
- [ ] Model catalog + release-event suggestions (§12.1): versioned catalog table, admin-reviewed events, deduped notices; **no auto paid retest**, no email until a delivery integration is confirmed.
- [x] Legacy certification paths blocked from publishing v2 listings — commit `7fd1a5e`. The guard is structural rather than a per-call-site check: `api/services/marketplacePublication.ts` exports `setLegacyListingStatus(listingId, patch, {ownerId?})`, and ALL 17 legacy status writes (`routers/marketplace.ts`: blind certification ×2, security-scan reject, generating, 4× draft revert, triage reject, certifying, publish, unpublish, reviewing, auto-grade, auto-publish, calculateGrade; `routers/admin.ts`: 2× requeue) now go through it instead of touching `marketplaceListings` directly. It locks the listing row FIRST — the same order `publishVersion` uses — then reads `publication_mode` under that lock, so a background review that started before a seller moved to v2 cannot overwrite the v2 decision (or deadlock). Asymmetric by design: a seller may still `unpublish` their own v2 listing (delisting is safe), every other status throws `v2_publication_locked`. `submitForReview` refuses before spending on test-data generation; the fire-and-forget block converts a lock refusal into a log instead of an unhandled rejection; `delete` refuses because the evidence FK is RESTRICT. Proven at guard level by the integration test "the legacy certification pipeline cannot touch a v2 listing's standing"; running the OLD tRPC procedures end-to-end against a v2 fixture is tracked in the A09–A14 task below.
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

## 6. Phase P5 — Interfaces (spec W5) — **rescoped by owner decision D9, 2026-09-20**

**D9:** the workbench is MCP-first — design, benchmark, grade, run and publish happen through MCP from the user's own LLM desktop app. The browser stays as the **shop front and the record**: marketplace browse/detail, the public evidence page, pricing/checkout, account credentials, spend, consent and withdrawal. No new authoring screens are built. Rationale and consequences live in spec §1.1 D9.

Dropped from the original P5 list (superseded, not deferred):
- ~~Benchmark workspace page (rubric/case editors, judge picker, cost-approval dialog, progress)~~ → the `benchmark.*` procedures + MCP tools ARE the interface; P2b already ships them.
- ~~`MyPipelines.tsx` Evaluate action + design-job status/apply screens~~ → MCP.
- ~~`PipelineEditor.tsx`/`PipelineConfigurator.tsx` template surfacing~~ → no new authoring UI.

Remaining P5 work (adaptation of what already ships — 23 pages exist today):
- [ ] `MarketplaceBrowse.tsx` / `MarketplaceDetail.tsx`: v2 evidence/model/date summary, link to the full public manifest, community filter, report/reply flow; no "human certified" wording (A22).
- [ ] **Public evidence page** — the canonical URL D9 depends on: renders a publication manifest by hash with `testedAt` distinct from `publishedAt`, withdrawn/superseded state visible, public DTOs only (§6.2).
- [ ] `CreatorDashboard.tsx`: versions, publication consent preview, suggested retests; earnings columns stay hidden until P4 policy resolves.
- [ ] Account surface check: BYOK credential entry, spend view, consent revocation, data deletion reachable without an MCP client.
- [ ] MCP responses as a first-class interface: every tool returns a complete, labeled, markdown-renderable DTO (no data reachable only in the web UI), and hidden-when-disabled flag behavior verified.
- [ ] i18n for all new strings (en/ar/zh); `npm run i18n:check` green; backend authorization enforced independent of what any UI hides.
- [ ] Revisit this whole phase against real beta user behavior before investing further — that was the agreement behind D9.

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
