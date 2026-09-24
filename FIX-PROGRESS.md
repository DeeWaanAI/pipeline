# Audit fix progress

Updated: 2026-09-23. Work in small verified increments; do not mark the overall goal complete.

## Rules
- Local v2 only. No production, provider-sharing changes, or payment work.
- Tests use their own throwaway databases on localhost:3307; never sweep real user data.
- Preserve financial/history records and snapshots; additive migrations only.
- No push without fresh authorization. `origin/main` is at 45f5546; the fixes below are committed LOCALLY only (3 unpushed commits at the time of writing).
- Preserve inherited UI edits and untracked `api/services/autoDesignService 2.ts` / `db/schema 2.ts`.
- `npm run check` passes. `api/services/benchmark/modelPricing.test.ts` is deliberately RED right now (18 failing cases) — see "In flight".

## Fix queue
| # | Status | Fix / acceptance |
|---|---|---|
| 1 | COMMITTED `05c7a69` | Feedback isolation: caller-scoped list/stats; admin-only status/issue conversion; two-account negative tests and admin positive tests. |
| 2 | COMMITTED `7d63e26` | Sweep race: serializable verification/clearing, per-account sweep lock, active-work refusals; concurrency/rollback tests pass. |
| 3 | COMMITTED `7d63e26` | Bundle v2 delivers/hashes full executionState and runParamsPrompt; changed content and old signed receipts refused; unrelated parameters preserved. |
| 4 | COMMITTED `7d63e26` | Preview/delivery/sweep and MCP guide disclose retained private plans and approval snapshots; not complete erasure; records remain unchanged. |
| 5a | COMMITTED `d016da3` | Ledger guard: absent/null token counts cannot be priced; measured 0/0 still a real zero. |
| 5b | IN FLIGHT | Provider adapters -> stored metadata -> benchmark aggregation must carry a usage-completeness signal. See "In flight" below. |
| 6 | TODO | Sweep response: remove other accounts' whole-table counts; test empty-account caller. |
| 7 | TODO | Feedback UI: submission/consent race, five-attachment limit, query errors; browser-test before completion. |
| 8 | TODO | Remove active billed-team MCP rate-limit branch without changing payment integration; preserve existing records. |
| 9 | TODO | Follow-up target authorization: feedback reactToMessage and submit accept project/message identifiers; verify ownership/read access before inserting. |

## In flight (task #48, audit item 5b) — unfinished and red
- Done: `api/lib/providers/base.ts` gained `normalizeTokenUsage(prompt, completion, total?)`
  (sets `usage.complete` only when BOTH counts are safe non-negative integers; absent /
  null / string / negative / fractional => false, numbers still defaulted to 0 so no
  arithmetic breaks) and `ChatResponse.usage.complete?: boolean`.
- Done: 18 provenance cases added to `api/services/benchmark/modelPricing.test.ts`
  (openai + anthropic, mocked fetch). They FAIL because the adapters do not call the
  helper yet — that is the expected red, not a broken build.
- Remaining: `openai.ts:174` and `anthropic.ts:144` still `?? 0` the provider fields;
  switch both to `normalizeTokenUsage`. Then persist completeness in the
  `agentResponses.metadata` writer (`swarmService.ts:550-565`), require it in
  `runTokenUsage`/`runModelSegments` (`benchmarkService.ts:1009-1059`), propagate through
  `judgeService.ts:200-212` and both judge `recordCallAttempt` sites, and extend the JSON
  typings in `db/schema.ts:331-335` / `:1819` plus `contracts/offeringV2.ts:1445-1450`.
  No migration needed (JSON columns). Legacy rows with no flag must be treated as unknown.
- Not covered by 5a/5b and still to assess: hidden retries losing earlier-attempt usage
  (`swarmService.ts:510-517`) and `evidenceService.ts:354-374`, which zero-defaults and
  sums partial token costs for published evidence.

## Evidence per committed increment
- `05c7a69` (fix 1): 3 new cross-account/admin regressions failed before the change, then 12/12 in `api/routers/feedbackAttachments.integration.test.ts`. Admin-wide review stays on `admin.listAllFeedback`.
- `7d63e26` (fixes 2-4): 10 concurrency/active-work regressions and 5 coverage regressions and 1 retention regression failed before their fixes. A real second MySQL connection cannot update a run/response/case row or insert a case while the sweep verifies, and can after commit; weakening the isolation to READ COMMITTED fails that test. Same-receipt replay: one succeeds, one gets `bundle_changed`; an injected mid-transaction failure rolls every clearing write back. Retained `benchmarks.plan` / `spend_approvals.plan_snapshot` rows are proven whole-row identical after a sweep.
- `d016da3` (fix 5a): a missing token count produced a `complete` $0.00000000 attempt before the guard; now unpriced across success/failed/uncertain, partially missing counts and segment fallback, while measured 0/0 stays a real zero.
- Full-suite state at each step: 31 delivery + 12 feedback + 19 help + 19 benchmark tests passed serially; `npm run check` and `git diff --check` clean.
- Reproduce: `MYSQL_ROOT_URL=<root URL of the local v2 stack> npx vitest run <files> --no-file-parallelism --silent`. Each integration file falls back to the docker-compose `localhost:3307` root URL, whose credential is already in those committed fixtures.

## Next agent
1. `git status`/`git diff` first: the two files in "In flight" above and the four inherited `src/` UI files are uncommitted; the duplicate ` 2.ts` files stay untracked. Do not redo fixes 1-4 or 5a.
2. Finish 5b exactly as listed in "In flight", adapters first, so the red tests go green in one increment; then commit.
3. Then fix 6 (cross-tenant census counts in the sweep response), 7 (feedback UI), 8 (billed-team MCP rate branch), 9 (feedback submit/react target authorization).
4. Keep this file current after each verified increment. Scan staged secrets before every commit; a push needs fresh written authorization.

## Still-open original acceptance (not achievable from this seat)
- #21/#22: authenticated browser verification outstanding; the four inherited UI files are still uncommitted.
- #23/#30: a real client deliver -> selected-folder write -> sweep has never run. Do not run one until 5b and fix 6 land.
- #40 is an owner decision; #29 and #42 belong to the deferred payment work.
- #41 is complete (`45f5546`): two-model aggregate pricing proven through execution; no production fallthrough defect existed.
