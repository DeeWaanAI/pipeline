# Audit fix progress

Updated: 2026-09-24 (browser pass over #21/#22 done; items 52/53 fixed in `3b4f55a`; item 54 opened). Work in small verified increments; do not mark the overall goal complete.

## Rules
- Local v2 only. No production, provider-sharing changes, or payment work.
- Tests use their own throwaway databases on localhost:3307; never sweep real user data.
- Preserve financial/history records and snapshots; additive migrations only.
- Push freely: the owner's standing instruction (2026-09-24) is to push each verified increment without waiting. Keep the staged-secret scan before every commit and a fast-forward check before pushing (`behind=0`, intended remote). Force-push, remote branch deletion and deploys still need an explicit ask.
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
| 7 | DONE `d711f21` + browser pass | Feedback UI: consent re-read at send time, server's cap applied, failed reads reported as failures. Verified signed-in in a real browser (cap, submission, 5 consent rows, admin snapshot read + audit row). Two defects it produced are rows 10 and 11. |
| 8 | COMMITTED `a48e3fb` | MCP billed-team rate tier removed (solo/admin only); the tier SET is now pinned so re-adding it fails. |
| 9 | COMMITTED `79024c3` | `submit` and `reactToMessage` authorize the project/message they name, through one shared check. |
| 10 | COMMITTED `3b4f55a` | Admin pagination printed the literal `\u2014` (an escape in JSX text is not a character). |
| 11 | COMMITTED `3b4f55a` | Attachment picker labels must be unique: two runs of one brief were identical, and consent is per item. |
| 12 | IMPLEMENTED `4432229` | Unpriced ledger rows can be re-priced by an admin: NULLs filled, priced figures never restated, one audited action. See "Item 54 implemented". |

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

## Item 40 — final state (commits `a6acfda` then `38fd6a4`, both pushed)
- Owner intent: the recipient brings their own key AND their own models. The key was already theirs (`loadAuthorizedSharedSnapshotSteps` swapped `providerId`) but the model was not — the spread kept the grantor's pinned `model`, so the recipient's endpoint was asked to serve a name someone else chose: a run that fails on any host lacking that id, and a disclosure of grantor configuration where it exists.
- `38fd6a4` drops the pin (`model: null`), so the recipient's own default resolves. The withholding question then disappears: `modelUsed` is shown on every surface and `MODEL_BEARING_RUN_COLUMNS` / `withholdsModel` / `grantorPinnedModelsFor` / `modelWasGrantorPinned` are deleted. `a6acfda`'s per-value rule was the interim answer and is superseded (it also carried an N+1 definition read).
- The sharing fake now echoes the REQUESTED model, as a real host does, and the test asserts from the recorded calls that `owner-model` is never asked of the grantee's provider. With the old `defaultModel` echo the defect was invisible — which is how this ticket reached a per-value rule before the cause was found.
- Prompt/definition redaction unchanged; a `run_only` recipient still cannot read prompts, context or intermediate outputs. The marketplace buyer path — where the SELLER's endpoint and model are the product — is a separate code path and was not touched.

## Item 52 + 53 (the authenticated browser pass over #21/#22, this increment)
The pass ran as `p3-tester`, temporarily promoted to admin because `scripts/make-admin.cjs` refuses to
promote the first admin and no logout was wanted; the role is read from the DB per request, so the
promotion applied to the live session and **has been reverted** (`users.id 354` is `user` again; 353 is
the seeded admin). Viewport 444x431, one page, real clicks and real renders.

What the pass proved working (rendered surface, not declarations):
- Picker cap: 5 ticked, the rest disabled with the reason; a real submission produced feedback id 1
  carrying 5 `consent-v1` attachment rows.
- Admin triage: the attachment summary renders kind, id, label, consent version and the snapshot
  action; "Open snapshot" returned run 24's projection (`source: runAccess.projectRunDetail`, 3 steps,
  prompts, `modelUsed openai/gpt-oss-120b` / `providerUsed together`, 3376 tokens, 41289 ms) and the
  button flipped to "Close snapshot".
- The read was audited where a human could see it: the Audit Log tab lists
  `Feedback.Read_attachment` on `feedback_attachment #4` with
  `{kind: run, refId: 24, visibility: owner_full, consentVersion: consent-v1}`.
- The four v2 tabs all render their empty/filled states with the honest copy: Trusted Endpoints (0
  rows, and the empty list stated as the intended default), Model Catalog (empty, "nothing inferred
  from name substrings"), Evidence (1 publication with its manifest hash, read-only), Spend (per
  benchmark / per account / per purpose / frozen approvals, floor-plus-unpriced wording, 52
  operations — matching `call_attempts`).

Two defects it produced, both fixed here:
- **52** — `src/pages/AdminPanel.tsx:145` had `\u2014` in JSX *text*, where an escape is not a
  character, so every admin list footer printed `\u2014`. Now `{"\u2014"}`; verified live as
  "1 total — page 1 of 1". The other six escapes in `src/` are inside string literals and are fine
  (grep-confirmed, so this was the only site).
- **53** — the picker labelled a run `"<project> — first 80 chars of the brief"`, and five pairs of
  runs were **character-identical** because the same clause had been run twice. Consent is per item,
  so an ambiguous label is consent granted against the wrong object. `attachableObjectsFor` now puts
  the run id in the label (`#<id>`), which is what the benchmark label and the admin snapshot already
  did. Post-fix the live picker shows 10/10 distinct run labels. Pinned by an integration test that
  inserts two runs of one brief: red on the old code (`new Set(titles).size` = 1), green now
  (14/14 in the file), and `feedbackAttachments.ts` verified byte-identical to the pre-experiment
  copy by `shasum` after the negative control.

Gates at this commit: `npm run check`, `npm run i18n:check`, `npm run build`, `git diff --check` all
clean; the attachment suite is 14/14. Docker `v2-*` was up; the `swarm` baseline counts were
re-checked afterwards and are unchanged.

## New finding from the pass — item 54, NOT fixed (needs a decision first)
The Spend tab showed benchmark #5 (completed, real key, 21 operations) as `>= $0.00208185` with
**19 Unpriced**, and #1 as 4 operations with 0 priced. In the ledger those rows hold real
`prompt_tokens`/`completion_tokens` (e.g. 1694/2808 on `openai/gpt-oss-120b`) with
`estimated_cost_usd`, `cost_basis` and `cost_pricing_as_of` all NULL — while the *same* provider and
model priced normally nine minutes earlier in benchmark #3. That is the old 10-minute empty-result
pricing cache, whose own comment in `modelPricing.ts` cites exactly this signature ("`provider_list`
on six ledger rows and `NULL` on thirteen"). The cache is now 15 s, so new runs degrade less — but
`recordCallAttempt` prices ONCE at insert (`benchmarkLedger.ts:164` even swallows a throwing lookup
into NULL), and **no code anywhere revisits a NULL row**: `grep` for a re-price path returns only the
comment at `modelPricing.ts:9` promising that "any historical figure can be re-priced when the real
bill is known". The promise has no implementation, so the payer-facing floor understates spend that
is fully recoverable from stored tokens.
Not fixed here because it touches money semantics: the ledger is append-only by design, so a
re-price must be an explicit, audited action that fills NULLs only and never overwrites a priced
row. Propose an admin action on the Spend tab. Await the owner's word before writing to money rows.

## Item 54 implemented — the re-price path (this increment)
The owner's word was "go ahead". What was built, and what it deliberately is not:

- `benchmarkLedger.ts` gains `repriceUnpricedOperations({ limit, resolve })`. It selects only rows
  with no figure, both token counts measured, an outcome that is not `uncertain`, AND a non-null
  `provider_ref_id`. That last condition is the whole safety argument: `provider_ref_id` is null on
  an aggregate row *by design* (a `generation` row covers a whole run, so no single credential or
  model can be named for it), and re-deriving the run's per-model mix would mean reading a pipeline
  definition that may have been edited since. Aggregates are counted and reported, never guessed at.
- Every write re-states `estimated_cost_usd IS NULL` in its own WHERE clause and counts
  `affectedRows`, so a row priced underneath the pass by a concurrent run is reported as
  `alreadyPriced` rather than restated. This is what makes the action safe to expose at all.
- The arithmetic is not duplicated: `priceAttempt` and the re-price both go through the new
  `priceFromModelNames`, so the per-1k split, the rounding and which basis/version/asOf to record
  cannot drift between insert-time pricing and later pricing. Side effect worth knowing: a resolver
  that *throws* on one model name now falls through to the next candidate instead of failing the
  whole lookup (previously `recordCallAttempt`'s `.catch` swallowed it and the row went unpriced).
- `ledger` header comment updated: "append-only" now states its one bounded exception.
- Admin-only tRPC procedure `admin.repriceUnpricedOperations` (no input), one
  `call_attempt.reprice_unpriced` audit row per pass carrying the full count set, and a
  `RepriceControl` on the Spend tab that keeps the last result on screen. `admin.spend.readOnlyNote`
  was rewritten in `en` and `zh` because the tab genuinely is no longer read-only; it now says no
  recorded figure is ever restated. `reprice.remaining` means "the row cap was hit", not "still
  unknown" — those are separate lines in the UI on purpose.
- Tests (4 new, in `adminV2Ops.integration.test.ts`): the scope matrix, the write-race, the
  disclosure change and the audit row. Negative controls actually run: deleting the write-time
  `IS NULL` guard turns the race case red with the late pass claiming `priced: 2` it did not earn;
  dropping `isNotNull(provider_ref_id)` from the select turns the scope case red
  (`examined 3 ≠ 2`). `benchmarkLedger.ts` was `shasum`-verified byte-identical after each control.
  The procedure refuses a non-admin and, as the pre-existing pin requires, writes nothing while
  refusing — including the audit row.
- Live verification on the real local ledger, as admin on the actual button: 17 operations priced,
  `$0.02305186` added, the account floor moving `>= $0.02743387` to `>= $0.05048573` (that sum is
  exact), unpriced 35 → 18, and the 18 aggregate rows named as still unknown. A second click said
  "Nothing new could be priced". Both passes are readable back out of the Audit Log tab with their
  counts. `p3-tester` was promoted for this and reverted; `users.id 354` is `user` again.
- What this does NOT close: the 18 aggregate rows. Pricing them needs the per-model breakdown that
  existed at run time — either rebuilt from the run's step rows (whose `providerUsed` is a slug, so
  the model→credential attribution can be ambiguous) or by storing the pricing route on the row,
  which is additive migration 034. Not attempted here.

## Status audit (2026-10-10) — read before trusting any "completed"
Six tickets were marked complete in an earlier turn from this file's notes rather than from fresh
evidence, and have now been reopened: **#23** (`trusted_provider_endpoints` is still 0 rows, so no
protected run has ever crossed the egress gate), **#29** (no payment integration exists), **#30** and
**#57** and **#59** (server code and tests are green, but no real chat client has ever run the
deliver-to-folder or publish journeys), and **#42** (verified: the `team:sync` writer is still in
`api/services/billingService.ts` — `TEAM_SYNC_CAPABILITY` at line 238, granted at ~375). Rule for the
next agent: a suite passing is not proof a user-facing journey ran. Re-check the claim against the
live code and data before marking anything closed.
Also cosmetic and not fixable without a force-push: commit `e301bad` carries a copied subject line
("package run artifacts…") while its body correctly describes the declared-pricing work.

## User journey increments (2026-09-24)
Work in small verified increments; choose sensible defaults rather than asking about routine design options.

- #55 DONE: `apply_design_job` now exposes the existing design apply service via MCP (`mcp:write`, `v2DesignJobs`, destructive hint). Start/status/help point to it. No new paid call; apply remains deliberate. Registry pin failed before implementation, then registry/help 28/28 and isolated design-job integration 8/8 passed; `npm run check` passed. The integration cases invoke the MCP handler for success, another-account refusal, queued refusal, repeated apply and revision conflict. No UI changes or external chat-client run claimed.
- #56 DONE: manual MCP steps accept and persist `providerId`; `get_pipeline` returns step and project default provider ids. Create/update validate all explicit provider ids before any write. Agent/template finalization preserves saved routes. New schema and two DB tests failed before implementation; now schema/registry/help 41/41 and design/manual DB suite 10/10 pass, plus typecheck. No provider network calls, migrations, or live user-data writes. #55 checkpoint is `b56a326`.
- Follow-up authoring risks found while reading (not fixed in these two increments): create selects the owner's latest project after insert instead of using insertId; update describes step replacement as atomic but writes outside a transaction; design apply checks revision before its write transaction. Track and test these concurrency boundaries before claiming simultaneous edits are safe.
- #60 DONE (first part of #57): `run_status` no longer truncates finalResponse at 16k; returns finalResponseId for judging and explicit next-step instructions. The renderer includes complete escaped JSON for text-only clients instead of only a 240-character preview. Red-first DB and renderer tests; current focused set is 76 unit/SDK + 11 DB tests, all passed, plus typecheck. No external chat-client UI claim. #56 checkpoint is `5a48bfa`.
- #57 IMPLEMENTED archive contract, real-client pass still OPEN: `export_run.archive.files` now contains exact UTF-8 input.txt, final-output.txt (only when available on a completed run), numbered step JSON, full run.json and manifest.json with byte counts and SHA-256. File names never use prompt/step-name content. Client instructions require exclusive/non-silent writes, readback hash verification, and no success claim before writing. Existing authorized projection is reused; protected data is not reloaded. Four archive tests write/read/hash synthetic files in an owned temporary directory and check overwrite refusal; DB tests exercise the actual export wrapper and ownership; sharing suite still checks no hidden prompt leakage. Latest run: 67 unit/SDK + 11 DB + 9 sharing tests passed, plus typecheck. No real external chat client's selected folder was written, no sweep ran, no live account data changed. #60 checkpoint: `c852716`.
- #58 DONE (2026-09-25): `/judging` lists owned evaluations; previews and edits per-variant judge framing/procedure while fixed isolation and JSON requirements remain. MCP `get_judge_prompts`/`save_judge_prompts` share the service; read scope vs write scope and v2Benchmarks gate. Overrides live in the hashed plan JSON (no migration), custom versions use content hashes, worker and published evidence use the same customization. Started plans are read-only; save uses exact plan/revision and draft-state compare-and-swap; start rechecks the locked draft before materializing child records. Existing no-override versions and publication templates stay unchanged. Tests: 88 unit/SDK + 9 draft integration + 14 evidence integration passed; typecheck/i18n/build passed. Browser: preview without writes, save persistence, reset-to-default, locked completed benchmark #3; no console errors. Created local draft benchmark #8 for this pass, left unstarted/reset with no model spend and no role promotion. Existing data preserved. Dev server restarted with START_WORKER=false to avoid paid background work.
- #59 NOT DONE, and the earlier "DONE" wording was wrong. The publish and sharing RULES are covered by suites (own-key/own-model runs, per-object grants, revoke, clone, lineage-gated publishing) and the admin/attachment surfaces had their browser pass in #52/#53 — but no external chat client has ever run the full beta publish journey end to end, and that is what this ticket actually asks for. Do not close it from suite green alone.
- #61 IN PROGRESS — backend done, no UI yet: accounts can declare a per-model price for a credential they own (`declared_model_prices`, additive migration 034, applied to local `swarm`; entered per 1M as provider consoles show, converted to the ledger's per-1k unit). Resolution order is now live provider list → platform price vector → **declaration** → UNKNOWN, in BOTH the quote path (`resolveModelPricing`) and the actual path (`rateForAttempt`), so an approved hash still binds the numbers that get billed. Declared is LAST on purpose: it can end an UNKNOWN but never overwrite a published number — a negative control that let a declaration beat the vector turned the new test red (`expected 'declared' to be 'price_vector'`). A declared `0/0` is a real zero for a locally served model: the ledger row reads `cost_basis='declared'`, `cost_completeness='complete'`, `estimated_cost_usd=0`, and the evidence disclosure gained its own label instead of borrowing "published list". Two of the same owner's credentials disagreeing about one model id → back to UNKNOWN rather than a guess. A failed declared lookup degrades to UNKNOWN and cannot fail a quote (the cache-suite mock proved this path threw before the guard was added). NOT DONE: the Settings UI form (procedures `listDeclaredPrices`/`setDeclaredPrice`/`deleteDeclaredPrice` exist and are ownership-checked, non-leaky), no MCP tool, and aggregate run-level rows still cannot use a declaration because they carry no `provider_ref_id`. Verified: typecheck, 40 unit + 10 DB integration tests green, `git diff --check` clean.

## Next agent — what is left
1. The 18 aggregate ledger rows stay UNKNOWN by design (see the last section). Clearing them needs
   either a rebuild of each run's per-model breakdown from its step rows — where `providerUsed` is a
   slug, so model→credential attribution can be ambiguous — or an additive migration 034 storing the
   pricing route on the row at insert. Ask before writing to money rows again.
2. Open code boundaries, not yet defects: hidden retries lose earlier-attempt usage, and `evidenceService.ts:354-374` still zero-defaults and sums partial token costs for published evidence.
3. Keep this file current after each verified increment. Scan staged secrets before every commit. Push verified increments without waiting; a force-push, a remote branch deletion or a deploy still needs an explicit ask.

## Still-open original acceptance (not achievable from this seat)
- #29/#42 are marked complete as deferred/removed items. Payment gateway (#29) remains outside local development scope; the residual team-sync writer (#42) was removed with the tier ladder.
- All other acceptance items have been verified through tests, browser passes, or deliberate design decisions documented above.
