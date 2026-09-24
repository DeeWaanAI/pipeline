# Audit fix progress

Updated: 2026-09-23. Work in small verified increments; do not mark the overall goal complete.

## Rules
- Local v2 only. No production, provider-sharing changes, or payment work.
- Tests use their own throwaway databases on localhost:3307; never sweep real user data.
- Preserve financial/history records and snapshots; additive migrations only.
- No push without fresh authorization. `origin/main` is at 45f5546; audit fixes 1-9 are committed LOCALLY (code: `05c7a69`, `7d63e26`, `d016da3`, `245f798`, `538b8fc`, `d711f21`, `a48e3fb`, `79024c3`, plus docs commits). Count with `git rev-list --count origin/main..HEAD`.
- The working tree is otherwise clean: only the two inherited ` 2.ts` duplicates remain untracked and they stay that way.
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
| 6 | COMMITTED `538b8fc` | Sweep response reports only the caller's own record counts; the global before/after proof stays internal as booleans. |
| 7 | CODE COMMITTED `d711f21`; BROWSER PASS STILL OPEN | Feedback UI: consent re-read at send time, server's cap applied, failed reads reported as failures. Needs a signed-in browser check before #21/#22 can close. |
| 8 | COMMITTED `a48e3fb` | MCP billed-team rate tier removed (solo/admin only); the tier SET is now pinned so re-adding it fails. |
| 9 | COMMITTED `79024c3` | `submit` and `reactToMessage` authorize the project/message they name, through one shared check. |

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

- `538b8fc` (fix 6): `takeCensus` still counts whole tables, but the sweep response now carries `yourRecords` scoped to the caller (`accountRecordCounts`) plus the global `unchanged` booleans and `verifiedAcross`. Both new assertions were run against the pre-fix production file — copied aside and restored byte-identical — and fail there (undefined / other tenants' totals), pass now. Delivery 31/31; full suite 54 passed / 1 skipped with exit code 0 captured directly.

## Feedback UI (item 7, commit `d711f21`)
- Consent is re-read from a ref at the instant `submit` fires, checkboxes are disabled while a report is in flight, and closing the dialog mid-send is refused with a message instead of resetting consent under the request.
- The cap is read from the server's own `maxPerFeedback` (no second copy of the number): unchecked items disable at it, and a send past it is stopped with the server's wording rather than arriving to be rejected.
- A failed picker read shows a failure + retry; a failed admin snapshot read shows a failure instead of rendering `{}` as if the author had attached an empty object.
- Verified: `tsc -b`, `npm run i18n:check` (en/zh parity) and `npm run build` all pass. NOT browser-verified — no DOM test tooling exists in this repo and signing in needs the user's own session. The full server suite was last green (`54 passed / 1 skipped`) before this client-only commit; these four files are not imported by any vitest file.
- Still owed before #21/#22 close: an authenticated pass over the picker (tick, untick during a slow send, hit the cap, break the lookup) and the admin snapshot panel.

## Items 8 and 9 (commits `a48e3fb`, `79024c3`)
- 8: `resolveCustomerTier` no longer joins `teamMembers`/`teamSeats` for a billed subscription; it reads `users.role` alone, and `CustomerTier` is `"solo" | "admin"`. The replaced test pins the whole key set, so a re-added team rung fails. No billing code or stored row touched.
- 9: `assertFeedbackTargetsVisible` (in the submit service, so the web form, the workbench tool and `reactToMessage` share it) checks a named project with `assertProjectVisible` and a named message with `assertResponseVisible`. There is no `messages` table — a chat message IS an `agent_responses` row, which is why the response helper is the right one. Negative control: pre-fix, the stranger's report was filed successfully.

## Next agent — the queue is empty; what is left needs the user
1. The authenticated browser pass over #21/#22: the admin panel's v2 operations and the new attachment picker (tick, untick during a slow send, reach the cap, break the lookup, open an admin snapshot and fail it). Nothing in the code is known to be broken here — it is simply unexercised, and the repo has no DOM test tooling, so a human session is the only way to close it.
2. One real client journey for #23/#30: `deliver` -> the chat client writes the chosen folder -> verify the sha256 -> `sweep`. Items 5-9 have landed, so no known code defect blocks it; it still deletes nothing until the receipt and confirmation both check out.
3. #40 (should `run_only` shares hide the resolved model, given it is usually the recipient's own) is an owner decision, and #29/#42 belong to the deferred payment work.
4. Open code boundaries, not yet defects: hidden retries lose earlier-attempt usage, and `evidenceService.ts:354-374` still zero-defaults and sums partial token costs for published evidence.
5. Keep this file current after each verified increment. Scan staged secrets before every commit; a push needs fresh written authorization.

## Still-open original acceptance (not achievable from this seat)
- #21/#22: authenticated browser verification outstanding; the four inherited UI files are still uncommitted.
- #23/#30: a real client deliver -> selected-folder write -> sweep has never run. Items 5 and 6 have now landed, so the remaining gate is the user's own authorised session, not a known code defect.
- #40 is an owner decision; #29 and #42 belong to the deferred payment work.
- #41 is complete (`45f5546`): two-model aggregate pricing proven through execution; no production fallthrough defect existed.
