# V2 PROGRESS CHECKPOINT — autonomous continuation point

**Updated:** 2026-09-20 14:53 (+03:00)
**Purpose:** if the implementing session or laptop dies, ANY new session resumes from this file + the plan doc. Do not restart completed work.

## Read first (in order)
1. `DeeWaanAI-Next/OFFERING-REDESIGN-V2-IMPLEMENTATION-PLAN.md` — phases, gates, decisions D-a/b/c/e
2. `DeeWaanAI-Next/OFFERING-REDESIGN-TECH-SPECS.md` — governing spec (v2.0); §1.3 open policies P1–P7 are owner-gated
3. `DeeWaanAI-Next/G0-INVENTORY.md` — baseline facts
4. `git log --oneline -15` — source of truth for what is DONE (checkpoint text may lag by one commit)

## Status
| Phase | State |
|---|---|
| P0 baseline | ✅ done (tag `v2-baseline`, repo `github.com/youssef-hariri/deewaanai-v2`) |
| P1 additive foundations | ✅ done + pushed |
| P2a durable design jobs | ✅ done + pushed (commit `2e7be2d`) |
| P2b benchmark engine | ✅ done locally 2026-09-20 — A01/A02/A06/A07/A08 + A21 containment implemented and tested; real-broker queue drill deferred to P6 (same treatment as P2a) |
| P3 evidence + protected exec | ▶️ in progress — evidence manifests + publication states DONE and pushed (`01be427`); protected execution, `marketplace.publishVersion` boundary and model catalog remain |
| P5 interfaces | **Rescoped by owner decision D9 (2026-09-20)** — MCP-first workbench, no new authoring screens; remaining work = adapt the existing shop front + build the public evidence page. See plan §6. Revisit after real beta usage. |
| P6/W6 rehearsal + verification | local prep unblocked; Railway service creation + ANY domain/production action = OWNER GO ONLY |
| P4 commercial | BLOCKED by spec: owner must resolve policies P1–P7 (never invent defaults) |

## Hard rules (violating any = stop)
- Never modify `/Users/youssefhariri/Documents/app 25` (frozen prod copy). All work in `/Users/youssefhariri/Documents/app25_v2`.
- Never connect to production DB/Redis (`hopper/acela.proxy.rlwy.net`). Local stack only: `docker compose -f docker-compose.v2.yml` (`v2-mysql`:3307, `v2-redis`:6380). Integration tests use throwaway DBs and revoke ONLY their own grant. **Each integration test file needs its OWN database name** (`swarm_v2test` design-job, `swarm_v2test_bench`, `swarm_v2test_exec`, `swarm_v2test_evidence`) — vitest runs files in parallel, and two files sharing a schema will have one file's `afterAll` DROP pull the ground out from under the other (this produced 19 phantom failures once already).
- Never delete archives/backups/snapshots. Additive migrations only (next number: check `db/migrations/`, was 027).
- No pushes to the OLD repo, no Railway/DNS/domain mutations, no Stripe anything beyond test-mode config files.
- Before EVERY commit: security scan (staged file list, secret patterns in `git diff --cached`), then commit AND `git push origin main` immediately.
- After every phase: `npm run check` + `npm test` + `npm run build` + `npm run i18n:check`; baseline = 4 pre-existing `providerThrottle` failures ONLY. Note (verified 2026-09-20): `api/lib/rateLimiter.test.ts` is INDEPENDENTLY FLAKY (0–3 of its 13 tests fail run-to-run even when run alone; the file is untouched by v2 work), so a 5th limiter failure in a full-suite run is not a regression — re-run that file by itself to confirm before investigating.
- Zod v4 gotcha: `z.undefined()` needs `.optional()` (see contracts/offeringV2.ts). tRPC reserved key: no procedure named `apply` (use `applyCandidate`). MySQL FK identifiers ≤64 chars (use explicit `foreignKey({name})`).

## Environment bring-up after a boot (watchdog/session start)
```
cd "/Users/youssefhariri/Documents/app25_v2"
open -a Docker   # wait for daemon
docker compose -f docker-compose.v2.yml up -d   # v2-mysql/v2-redis
npm ci  # only if node_modules missing
npm test 2>&1 | grep -E "Test Files|Tests "     # confirm baseline before new work
```
Nohup caffeinate protects against sleep, not battery: if the laptop died, just power it on and open any Qoder session in this workspace — the cron watchdog "v2-phase-watchdog" resumes automatically.

## Update discipline
When finishing any increment: (1) commit+push, (2) tick the plan-doc checkboxes with evidence, (3) rewrite "current step" below, (4) when a phase completes set its row ✅ and the next ▶️. When ALL unblocked phases (P2b, P3, P5, P6-local) are done and verified, disable the cron task `v2-phase-watchdog` (qoder_cron remove/run list to find id) and write `V2-ALL-BLOCKED-PHASES-COMPLETE.md` with the acceptance-matrix summary.

## Current step
P3 — evidence publication, protected marketplace execution, model catalog (plan §4, spec §7.3, §8, §10.1, §12.1). P2b is closed locally and pushed; read plan §3 P2b for the evidence trail before assuming anything about it.

**D9 interfaces (spec §1.1, plan §6):** the workbench is MCP-first, so every v2 capability must be reachable and readable through MCP with complete, labeled, markdown-renderable DTOs — no data that exists only in a web screen. **DONE 2026-09-20:** the 10 `benchmark_*` MCP tools are registered behind `v2Benchmarks` (create/prepare_rubric/prepare_cases/quote/approve_spend/start/status/list/cancel/resume), each a thin adapter over `api/services/benchmark` so a desktop client cannot bypass authorization, plan hashing or spend approval; `deewaanai_help` gained an "Evaluate" group fed by the same flags, and `api/mcp/tools/registry.test.ts` now pins registry↔help parity so the guide can neither advertise an unregistered tool nor hide a live one.

Start with: spec §7.3 (full disclosure manifest list), §8.1–8.2 (restricted snapshot execution + trusted-egress policy), §10.1 (`evidence.preview`, `marketplace.publishVersion`, community publish/report/withdraw, public DTO-only endpoints), §12.1 (model catalog + release events + deduped notices). Then:
1. ✅ **DONE 2026-09-20 (`01be427`)** `api/services/evidenceService.ts`: manifest builder from a COMPLETED benchmark + its frozen plan; preview hash; consent gate; `draft_preview → published → withdrawn`; replacement creates a new publication row (never rewrites `testedAt`).
   Evidence: `buildEvidencePreview` validates against the frozen `PublicEvidenceManifestSchema` and returns a `previewHash` = sha256 over `stableStringify(manifest)` (so hash is reproducible — `pricingAsOf` is anchored to the run's `finishedAt`, NOT wall clock); `publishEvidence` refuses without the exact `approvedPreviewHash` + consent version, is idempotent on the same (benchmark, hash, kind), runs transactionally and bumps `evidenceSummaryRevision` when attaching to a listing; `withdrawPublication` unpublishes the listing only when that publication was its current evidence; `supersedePublication` writes a NEW immutable row with `supersedesPublicationId` and copies `testedAt` verbatim. §4.3 is enforced by refusing to certify an imported-only benchmark as seller evidence with a policy message (publish as community instead); §7.3 refuses a limited-disclosure report as seller evidence up front rather than letting the schema reject it; §7.1 disabled validators and per-candidate provenance are carried into every manifest; `scanForSecrets` blocks credential-bearing manifests and the test plants a fake `sk-…` key to prove the redaction survives end to end. 7/7 in `evidenceService.integration.test.ts` (throwaway DB `swarm_v2test_evidence`).
   **Still open on this file:** it is a service only — no tRPC router and no MCP tool reaches it yet (grep for `evidenceService` finds just its test). Under D9 both surfaces are required.
2. Refactor `swarmService` so an authorized snapshot loader is the only way a protected version executes for a buyer (§8.1) — the P2b `snapshotVersionId` path is the seam; no copies of seller prompts into buyer-owned rows.
3. `marketplace.publishVersion` as the sole seller boundary, transactional + idempotent, flag `v2Publication` / `v2ProtectedExecution` (both default OFF).
4. Legacy certification paths must be unable to publish v2 listings (run the old flows against v2 fixtures).
5. Expose evidence preview/publish/withdraw/supersede + the public evidence read through tRPC AND MCP tools behind `v2Publication`, and wire the 10 `benchmark_*` help/registry parity test to cover them.
6. Tests A09–A14 + A19, with the A12 leakage battery across every audited surface (template apply/duplicate, MCP reads, SSE, export, signed URLs, error strings, logs).

Carried-over open risks to handle deliberately, not silently:
- `contracts/offeringV2.ts` `CallPlanEstimateSchema` is richer than the benchmark service's `QuoteResult` (per-line costs, assumptions, price-vector metadata, bounded-high totals). Reconcile before P5 builds the cost-approval dialog on it. The internal `RubricSpec` also diverges from `RubricSchema` (`anchor` vs `anchors`, numeric vs decimal-string weights).
- A benchmark whose candidate is an imported output is user-reported provenance and CANNOT satisfy §4.3's "platform-recorded execution" requirement for publication — enforce that in `evidenceService`, and note `benchmarkCandidates.imported_response_id` is `ON DELETE SET NULL` by design (the graded text is copied onto the run row).
- Deterministic validators stay disabled while no isolated sandbox exists (§7.1). Publishing a manifest must disclose that, never omit it.

## P2b landing record (2026-09-20)
`ae13ff0` (golden path + fixes) plus this increment: A01 imported-output grading, per-candidate Σ generation arithmetic, explicit disabled-validator disclosure, judge-agreement in the summary, §10.2 partial-state fix, sequential version materialization, migration 027, and 21 new tests (34 benchmark tests total). Gates: check ✅ build ✅ i18n ✅, 289 tests with the 4 `providerThrottle` baseline failures only.


## Watchdog status
The cron task `v2-phase-watchdog` is DISABLED (failure circuit, 3× `session-failed`) and its
executionScope cwd was `app 25` — the frozen prod folder — while its instructions target this
folder. That scope mismatch is the likely crash cause (the sandbox confines a session to its own
workspace). Do not re-enable it until its scope points at `/Users/youssefhariri/Documents/app25_v2`;
run phases interactively here meanwhile. Also note the inherited `" 2"` clutter copied in with the
baseline (`db/schema 2.ts`, `api/services/autoDesignService 2.ts`, `.git/refs/heads/main 2`, some
`dist/public/assets/* 2.js`): unreferenced junk that predates P0, but do not delete without an owner
decision — move aside instead.

