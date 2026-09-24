# Audit fix progress

Updated: 2026-09-23. Work in small verified increments; do not mark the overall goal complete.

## Rules
- Local v2 only. No production, provider-sharing changes, or payment work.
- Tests use their own throwaway databases on localhost:3307; never sweep real user data.
- Preserve financial/history records and snapshots; additive migrations only.
- No push without fresh authorization. `origin/main` is at 45f5546; fixes 1-5 are committed LOCALLY as `05c7a69`, `7d63e26`, `d016da3`, `245f798` (+ this doc).
- Preserve inherited UI edits and untracked `api/services/autoDesignService 2.ts` / `db/schema 2.ts`.
- `npm run check` passes. The full suite is 55 files; `api/services/designJobService.integration.test.ts` can fail the parallel run with `spawnSync npx ETIMEDOUT` inside its `pushSchema()` helper (a 150s drizzle-kit timeout under contention, worst right after a container restart). It passes 8/8 alone — rerun it in isolation before treating it as a real failure.

## Fix queue
| # | Status | Fix / acceptance |
|---|---|---|
| 1 | COMMITTED `05c7a69` | Feedback isolation: caller-scoped list/stats; admin-only status/issue conversion; two-account negative tests and admin positive tests. |
| 2 | COMMITTED `7d63e26` | Sweep race: serializable verification/clearing, per-account sweep lock, active-work refusals; concurrency/rollback tests pass. |
| 3 | COMMITTED `7d63e26` | Bundle v2 delivers/hashes full executionState and runParamsPrompt; changed content and old signed receipts refused; unrelated parameters preserved. |
| 4 | COMMITTED `7d63e26` | Preview/delivery/sweep and MCP guide disclose retained private plans and approval snapshots; not complete erasure; records remain unchanged. |
| 5 | DONE (5a `d016da3`, 5b `245f798`) | Adapters report whether usage was measured; unproven counts reach the ledger as ABSENT and price as UNKNOWN. Legacy rows without the flag are unknown, not zero. |
| 6 | TODO | Sweep response: remove other accounts' whole-table counts; test empty-account caller. |
| 7 | TODO | Feedback UI: submission/consent race, five-attachment limit, query errors; browser-test before completion. |
| 8 | TODO | Remove active billed-team MCP rate-limit branch without changing payment integration; preserve existing records. |
| 9 | TODO | Follow-up target authorization: feedback reactToMessage and submit accept project/message identifiers; verify ownership/read access before inserting. |

## Usage provenance (item 5, commits `d016da3` + `245f798`)
- `api/lib/providers/base.ts` `normalizeTokenUsage(prompt, completion, total?)` sets
  `usage.complete` only when BOTH counts are safe non-negative integers. Absent / null /
  string / negative / fractional => `complete: false` with numeric zeros, so no arithmetic
  breaks and nothing pretends to be measured. `openai.ts` and `anthropic.ts` (the only two
  real adapters; everything else is OpenAI-compatible) route through it.
- `swarmService` stores `tokensUsed.complete` in the response metadata; `runTokenUsage`
  returns `complete` and demands it of EVERY contributing response plus one response per
  completed step; `runModelSegments` bails to no-segments on any unreported count. Both
  judge `recordCallAttempt` sites and `generateJudgeCall` carry `usageComplete`.
- An unproven total is written to the ledger as ABSENT counts, which `d016da3` already
  refuses to price; `usageSummary` keeps the partial sum next to the flag saying it is
  unproven. JSON typings (`db/schema.ts`, `contracts/offeringV2.ts`) gained the optional
  flag — no migration, both columns are JSON.
- Tests: 18 adapter provenance cases (both providers, mocked fetch, failed before the
  wiring), plus an executed-run case proving a host with no usage yields null counts,
  null cost and `unknown` on both generation and judgment rows while the work itself
  still completes. `api/services/benchmark/` = 115/115 across 10 files; `npm run check` clean.
- Deliberately NOT changed: `benchmarkLedgerTotals.costCompleteness` still answers
  `partial` when rows exist but none are priced, because the D9 finding-1 test pins that
  wording and `costDisclosure` (knownUsd null, FLOOR sentence) is the layer that stops the
  misreading. Do not "fix" the label without re-reading that pin.
- Still open boundaries, NOT covered: hidden retries inside `callWithRetry`
  (`swarmService.ts:510-517`) lose earlier attempts' usage entirely, and
  `evidenceService.ts:354-374` zero-defaults and sums partial token costs for published
  evidence. Both need their own increment.

## Evidence per committed increment
- `05c7a69` (fix 1): 3 new cross-account/admin regressions failed before the change, then 12/12 in `api/routers/feedbackAttachments.integration.test.ts`. Admin-wide review stays on `admin.listAllFeedback`.
- `7d63e26` (fixes 2-4): 10 concurrency/active-work regressions and 5 coverage regressions and 1 retention regression failed before their fixes. A real second MySQL connection cannot update a run/response/case row or insert a case while the sweep verifies, and can after commit; weakening the isolation to READ COMMITTED fails that test. Same-receipt replay: one succeeds, one gets `bundle_changed`; an injected mid-transaction failure rolls every clearing write back. Retained `benchmarks.plan` / `spend_approvals.plan_snapshot` rows are proven whole-row identical after a sweep.
- `d016da3` (fix 5a): a missing token count produced a `complete` $0.00000000 attempt before the guard; now unpriced across success/failed/uncertain, partially missing counts and segment fallback, while measured 0/0 stays a real zero.
- Full-suite state at each step: 31 delivery + 12 feedback + 19 help + 19 benchmark tests passed serially; `npm run check` and `git diff --check` clean.
- Reproduce: `MYSQL_ROOT_URL=<root URL of the local v2 stack> npx vitest run <files> --no-file-parallelism --silent`. Each integration file falls back to the docker-compose `localhost:3307` root URL, whose credential is already in those committed fixtures.

## Next agent
1. `git status`/`git diff` first: only the four inherited `src/` UI files are uncommitted (plus the two duplicate ` 2.ts` files, which stay untracked). Do not redo fixes 1-5.
2. Fix 6 next: `takeCensus` counts WHOLE tables with no tenant filter and `sweepDeliveredData` returns those totals, so any signed-in account can read other tenants' purchase/run/consent counts. Make the preserved-record proof per-account or drop the numbers, and pin it with an empty-account caller.
3. Then fix 7 (feedback UI: submission/consent race, the 5-attachment limit, query errors shown as empty) and its authenticated browser pass; fix 8 (billed-team MCP rate branch still grants 240 vs 60 req/min at `api/mcp/register.ts:48` + `api/lib/rateLimiter.ts:120`); fix 9 (feedback submit/react target authorization).
4. Keep this file current after each verified increment. Scan staged secrets before every commit; a push needs fresh written authorization.

## Still-open original acceptance (not achievable from this seat)
- #21/#22: authenticated browser verification outstanding; the four inherited UI files are still uncommitted.
- #23/#30: a real client deliver -> selected-folder write -> sweep has never run. Do not run one until 5b and fix 6 land.
- #40 is an owner decision; #29 and #42 belong to the deferred payment work.
- #41 is complete (`45f5546`): two-model aggregate pricing proven through execution; no production fallthrough defect existed.
