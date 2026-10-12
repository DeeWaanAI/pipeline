# Audit fix progress

Updated: 2026-09-24 (browser pass over #21/#22 done; items 52/53 fixed in `3b4f55a`; item 54 opened). Work in small verified increments; do not mark the overall goal complete.

## Rules
- Local v2 only. No production, provider-sharing changes, or payment work.
- Tests use their own throwaway databases on localhost:3307; never sweep real user data.
- Preserve financial/history records and snapshots; additive migrations only.
- Push freely: the owner's standing instruction (2026-09-24) is to push each verified increment without waiting. Keep the staged-secret scan before every commit and a fast-forward check before pushing (`behind=0`, intended remote). Force-push, remote branch deletion and deploys still need an explicit ask.
- The working tree is clean. The two inherited ` 2.ts` files were moved aside on 2026-10-12 by owner
  decision (never deleted) to `~/Documents/app25_v2-inherited/`, same names, byte-identical to the
  blobs in `2e7be2d` / `3042b16`. Nothing imported them. Full entry in V2-CHECKPOINT.md §Watchdog status.
- Preserve inherited UI edits.
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
deliver-to-folder or publish journeys), and **#42** (verified at the time: the `team:sync` writer was
still in `api/services/billingService.ts` — `TEAM_SYNC_CAPABILITY` at line 238, granted at ~375;
closed 2026-10-11, see the section above). Rule for the
next agent: a suite passing is not proof a user-facing journey ran. Re-check the claim against the
live code and data before marking anything closed.
Also cosmetic and not fixable without a force-push: commit `e301bad` carries a copied subject line
("package run artifacts…") while its body correctly describes the declared-pricing work.

## #42 CLOSED — team removal finished (2026-10-11)
Evidence, not notes: `api/services/billingService.ts` no longer contains `TEAM_SYNC_CAPABILITY`,
`upsertTeamSeats` or `syncTeamSyncEntitlement`. All three `team_seats` webhook branches now call
`ignoreTeamSeatEvent` — the event is claimed in `idempotency_keys` and dropped, so a LIVE legacy
subscription cannot throw (Stripe retry storm) and cannot fall through to the generic branch and be
recorded as an individual plan. `teamSeats`/`teams` are gone from the file's imports; the TABLES are
untouched (additive-migrations-only, history preserved). `TOKEN_SCOPES` lost `team:read`/`team:write`
(the OAuth layer already refused them via `MCP_SCOPES` in `api/mcp/auth.ts`, so no token minted after
2026-09 could hold them and old ones still verify — nothing requires those scopes). Unused
`STRIPE_PRICE_TEAM_SEAT` removed from `api/lib/env.ts`, README, DEPLOY.md and the flag seed SQL;
ENGINEERING.md §3 now describes the one arm `can()` actually has.

New pin: `api/services/billingService.test.ts` (4 tests). Negative control was run — neutering the
`customer.subscription.deleted` intercept turned exactly that case red with "expected … to not contain
insert into subscriptions", so the passing runs are not a deaf harness. `npm run check` clean; 43 tests
green across billing/token/entitlement/MCP-scope suites. NOT verified: no real Stripe test event was
delivered to a running server (that needs live keys — #23/#29 still open).

## Beta signups cannot be lost by a rebuild (2026-10-11)
Asked: "make sure when people register for the beta testing, we do not loose their info in case
we update the app." Finding: rows go to MySQL `waitlist_entries` on the **MySQL service**, which a
site/app redeploy does not touch — so the update itself was never the risk. The risk was silent:
`site/src/config.ts` read `PUBLIC_WAITLIST_API_URL` **at build time**, and when it is absent the
landing page rendered a *disabled* form ("join via email"), so a rebuild that forgot the variable —
which is exactly what Site CI does, it builds with no such env — stops writing signup rows while
still looking like a working page. Proof: the local build with no variable produced a dist with
zero occurrences of `wl-form`.

Fix: the form always renders (missing variable → posts to `SITE.appDomain`), and a signup the
server refuses now reveals the typed address as a prefilled `mailto:` link (textContent only, never
innerHTML). Verified on the rendered surface, not the declarations: `smoke-waitlist-client.mjs`
executes the real built script against a mock of the Wave W contract — **32/32**, including five new
500-path mail-fallback checks; a negative control (no-op the reveal) turned exactly one check red;
`astro preview` + a real browser DOM confirmed the form, the hidden fallback and no TeamSync text.
That smoke is now a **Site CI step**, so this cannot regress on a site push. DEPLOY.md gained
"Beta signups: what survives a redeploy" (table must be migrated by hand — `016`/`017`; the S3
backup cron is the only copy outside Railway; admin → Waitlist is where to read them).

Still open and NOT doable from here: confirming the live site actually renders the form and that
`waitlist_entries` exists in the production DB — both need a production read, which is not
authorised. The two lines to check are in DEPLOY.md.

## #61 input surface + a security fix found on the way (2026-10-11)
- `0b74baa` — Settings → "Model prices you declare" (`src/pages/Settings.tsx`, en/zh bundles). Driven in a
  real browser as a signed-in throwaway local user against the local stack: negative rate refused with no
  row written; `0/0` stored and rendered as `0 / 0` (a real zero, which is the local-model case); saving the
  same (provider, model) again updated the row instead of stacking a second; delete returned the section to
  its empty state. `npm run check` + `i18n:check` green, 452 unit tests green. Test rows (user 469, provider
  3, declared prices) were deleted afterwards — local `swarm` is back to `users=2`.
- `7aa5b29` — found while reading that page's own network response: `localAuth.me` ran a bare `select()` and
  returned the whole `users` row, so every SPA load carried `passwordHash` to the browser. Now an explicit
  four-column list (`id, username, name, role` — the shape login/signup already returned; grep of `src` shows
  only name/role/id are read). `api/routers/localAuth.test.ts` pins the projection, and the fake driver
  applies the column list so a regression to bare `select()` cannot pass blind. Confirmed on the live local
  endpoint: response body contains no `passwordHash` and no `$2b$`.
- **#61 is NOT finished.** Still open: (1) declaring a price from chat — no MCP tool exists, so the chat-first
  journey cannot set a price without leaving the platform; (2) aggregate run-level ledger rows still cannot use
  a declaration because they record no `provider_ref_id` (only per-step rows do); (3) the `wikiDump`/MCP-tools
  wiki has not been regenerated for anything added this session.

## One flat $9.99 + admin promotions (2026-10-11, owner decision restated)
Owner: "one tier only at 9.99 USD — no more 3 tiers", plus "let the admin make promotions such as
7 days free for newcomers", plus "I'll add the Stripe keys to .env later".
- `cbf49e1` — the marketing site still sold Artist / Master / Sage with "Paid tier" badges and three
  FAQs that gated IF/WHILE, quality gates and the Auto-Designer behind tiers. Those features are open
  to every account in code, so the copy invented a paywall that does not exist (and claimed a 1-provider
  free tier when `api/routers/pipeline.ts:147` allows 3 for everyone). One plan card at $9.99 now; the
  app's /pricing reads the number from `PLANS.solo.priceUsd` (single source, `api/config/plans.ts`) and
  the comment there says the Stripe price object is what actually charges, so dashboard + constant move
  together. Browser-verified: /pricing renders "$9.99 / per account, per month", checkout still disabled.
- `d426cb9` + `7a59d01` — promotions. `promotions` + `promotion_redemptions` (additive migration **035**,
  applied by hand to local `swarm`, DESCRIBE-checked). A promotion grants N free days as a Stripe
  **trial** (`subscription_data.trial_period_days`) — it never changes the price, so there is no second
  price path. `vouchers` could not be reused: its NOT NULL `tier` enum only accepts the retired ladder
  values. Redemption rows COPY `days` (deactivating cannot rewrite a past grant) and the cap is a COUNT
  over those rows. Eligibility is a pure read-only function; the write happens on
  `checkout.session.completed`, so an abandoned checkout costs nobody a slot.
  Verified: 20 pure-rule tests + 10 integration tests on a throwaway schema, 5 billing tests on the
  checkout payload (trial present when a grant resolves, key ABSENT when it does not), and the admin
  screen driven in a browser through the real login form (create newcomer + capped code promo, bad code
  refused with the validation toast and no row, days=0 refused, switch-off flips status, all four actions
  in `admin_audit_log`). 480 unit tests + typecheck + i18n parity green. Test users/promotions deleted;
  the audit rows were deliberately LEFT, because removing an action from an audit log falsifies it.

### Needs the owner's decision (found this session, not changed)
1. `src/locales/*/pricing.json` states "7-day trial from signup" as a standing policy while the newcomer
   promotion is now admin-defined. Two sources for the same promise — pick one: keep the standing 7 days
   and use promotions for exceptions, or make the promotion the only trial and delete the copy.
2. The landing page still promises Pioneer "lifetime discounted creator commission" and "best terms", and
   `ReviewerPortal` advertises "5 reviews = 1 day" with **no code behind it anywhere**. Either build the
   reward or take the line down before promoting the site.
3. The price is display-only until Stripe is configured: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `STRIPE_PRICE_SOLO` (a `price_…` created for the flat monthly plan). No publishable key is needed —
   checkout is Stripe-hosted. Until then billing routes answer 503 and /pricing says so on the page.

## Trust model: published evidence, not human review (2026-10-11)
Owner: "there are no more human reviewers — the author generates a judging team for the pipeline and
conducts a test", + "once the seller publishes, the data INCLUDING the judge prompts must be publicly
inspectable". Spec support: D2, D9 ("the public evidence page for a listing", "evidence needs a
canonical public URL"), D12 (3 vendors x 3 framings, generator-disjoint), §7.3 (exact judging prompts
are a required manifest field).

- `23d2771` — **the disclosure already existed and nobody could see it.** `evidenceService` already
  writes `judging.judgePrompts` (full text per variant), every judgment, parse failures, validators,
  costs, and `getEvidenceByHash` is a `publicQuery`. No screen in `src/` called any of it, so
  `/marketplace/:id` showed only the legacy grade/kappa/reviewCount. Added `/evidence/<manifestHash>`
  (renders the whole record; a hash that resolves to nothing says "not published" rather than 404, so a
  withdrawal is legible), a `listListingEvidence` public read that does NOT hide withdrawals, and a
  "Published evidence" panel on the listing.
  Verified live: an unauthenticated fetch (no `x-local-auth-token` at all) returned the manifest; walking
  all 136 keys found no step prompt, no credential, no seller instruction — only
  `judgePrompts[].promptText`, with `includesPrivateDefinition=false` and
  `hiddenSellerInstructionsIncluded=false`; the page rendered 10 sections and the prompt opened to its
  full 1,570 chars. 480 unit tests, `npm run check`, `i18n:check` (en+zh) and the site build pass.
- `cc2b34e` — the site and the app's pricing page still SOLD blind human review as the gate ("Only
  human consensus makes a listing buyable", "every purchase is graded by at least 5 independent
  reviewers"). Rewritten to what the code enforces. The blog post is annotated as historical, not
  rewritten. `reviewing.md` stays and now opens by saying the path is retired for new listings.

### Two things this surfaced that are NOT fixed
1. **A v2 listing's private step prompts are never scanned.** `scanListingSecurity` (injection
   patterns, hidden Unicode, exfiltration, embedded secrets) is called only from the LEGACY submit path
   (`api/routers/marketplace.ts:1179`); `publishVersion` runs `scanForSecrets` over the DISCLOSED
   material only (`api/services/evidenceService.ts:491`). So nothing checks the definition a BUYER will
   execute before the listing is buyable. I wrote the scan into `selling.md`, caught it against the
   code, and corrected the doc rather than the product — deciding this is the owner's: calling the
   existing scanner inside the publication gate is small and fail-closed, but it can newly REFUSE work
   that is listed today.
2. **The reviewer surfaces are still live** (`/reviewer/portal`, `/reviewer/review/:listingId`, the
   admin Certification tab, `certification.report`, the `certifying` status path, and
   `evidenceReports` — a table the schema defines and NO code reads or writes). Retiring them is a
   product decision with real blast radius (legacy listings' reports reference them), not a copy fix.

### Buyer opinions / questions under a purchased listing — my recommendation
`evidenceReports` is the closest existing shape (reporter, listing, reason, `sellerReply`, assessment
status) but it is specced as a CHALLENGE to evidence, and mixing "I disagree with this score" with
"does this handle Arabic diacritics?" loses both. Recommend a separate, smaller thing: one
`listing_notes` table (author, listing, kind question|opinion, body, `purchase_attested`, one-level
seller reply, `hidden` for moderation). Gate authorship on a real `marketplacePurchases` row and show
"verified purchaser" from THAT row rather than from anything the author types — the attestation is the
only reason the comment carries weight. Public read for everyone, no effect on price, eligibility or
evidence status (spec §6.2: a score difference is never an automatic penalty). The honest cost: it is a
public UGC surface, so it needs moderation, a hide action, and a privacy line before launch — say the
word and I will build it; I have not started.

## The measurement (#72 read-only half, `storageInventory.ts`)
First number, so the size argument is not a feeling. Account 354 on the LOCAL dev stack
(24 runs, 8 benchmarks, 1 published manifest, 52 ledger rows):

| group | bytes | what it is |
|---|---|---|
| live work | 292,926 | 27 KB of briefs + **146 KB of step intermediates** + 119 KB of answers |
| research | 66,467 | plans 31 KB, judgments 26 KB, cases 10 KB |
| hosted for others | 42,667 | the published manifest 41 KB + the cost ledger |

~79% of the bytes are the user's own weight, and the single biggest carrier is the **step
intermediates** — exactly what the owner said must survive for Human-in-the-Loop but not live
here. Per-run it is ~12 KB of live work (292,926 / 24), so a research program of 100,000 runs
is ~1.2 GB in the tables alone, before the daily mysqldump × 7-day retention multiplies it.
CAVEAT, state it when quoting these numbers: dev-stack prompts are small and few; the ratios are
the useful part, the absolute GB is production's to measure (`admin.storageHoldings({userId})`,
or the same SQL read-only).

Inventory groups by the REASON the bytes are here, and the per-row `note` says whether a sweep
may touch it — that is what makes it a decision tool instead of a `du`.

## Owner decision: the user's folder is the archive (2026-10-11, tasks #69–#72)
Purpose, in the owner's words: **own the data, and never lose it** — prompts, pipelines, results,
intermediates, human-in-the-loop state, and the judging prompts kept on the user's own machine — plus
**cost**: a research-scale seller generates GBs the platform must not pay to keep. NOT about hiding
data from LLM providers; my earlier framing there was wrong. Two carve-outs the owner stated: anything
another person depends on (a shared or published pipeline, and its evidence) lives on us because a
third party relies on it, and a run or edit is **uploaded to us on demand**.

The four steps, in order, with the reason for the order:
1. **#69 Prove the export with one real chat client.** `export_run` already hands the client every file
   (path, content, bytes, sha256) with write instructions; no live client has been shown to write and
   read them back. Until that passes, a deletion is not cleanup, it is loss. Also closes #30/#57/#59.
   Needs the owner's machine — it is the one step that cannot be done from here.
2. **#70 Hash + manifest on us, content with the user.** Bulk text is currently embedded in records that
   must survive: the sweep notice at `api/services/dataDelivery.ts:81` states that frozen plans and
   spend-approval snapshots retain case inputs, expected outputs and baseline prompts. Keep identity
   (hash, counts, provenance, cost) and deliver the body. Blocked by #69 on purpose.
3. **#71 Hydrate on demand.** Accept an upload only when its hash matches the quoted and approved plan;
   the server copy is a TTL cache, never the source.
4. **#72 A per-account "what is on us" view** — cache vs retained-because-relied-on, sizes, one sweep.
   Its read-only half is worth doing FIRST: nobody has measured where the GBs actually are, and that
   answer sizes step #70.

Consequences the owner should hear before we build, not after: a Human-in-the-Loop gate needs the
intermediates to outlive a pause, so either the buffer is held while the gate is open (what #71
proposes, with the folder always getting a copy) or pausing overnight across devices stops working; we
cannot restore what we chose not to store, so the ToS must say the platform does not archive private
work and the user's folder IS the backup; and cross-run search becomes a local-only feature.

Nothing here is built yet and **no deletion has been enabled**. Stripe (#29) stays last by the owner's
instruction.

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

## MCP authorize dead-end (2026-10-12)

The owner clicked Allow on the consent screen and nothing happened. Three independent reads agreed:

- `swarm.oauth_auth_codes` has no row newer than 2026-09-21 (max id 14), while Qoder's OAuth attempts
  ran 2026-10-12 10:34 and 10:39 and both stopped at `stage=browser_opened` (`expired`, then
  `cancelled`) — so the browser never produced a code.
- `/oauth/authorize` GET succeeded for the same request, and it validates client_id, the loopback
  redirect (port-insensitive since `8b7f0fd`) and PKCE. The only check the confirm POST adds beyond
  those is `resolveSessionUser`.
- The in-app browser's `localStorage.local_auth_token` decodes to `sub: 354` (p3-tester), issued
  501 hours earlier, `exp` long past, and `/api/trpc/localAuth.me` with that header answers
  `200 {"result":{"data":{"json":null}}}` — no session. The confirm POST therefore can only have been
  answered 401 "Authentication required" (not observed directly: `npm run dev` logs to the owner's
  terminal, and `/oauth/authorize/confirm`'s 401 path logs nothing).

The page branched on the token's **presence**, so a dead session still rendered Allow/Deny, and the
401 surfaced only as a toast the owner never saw: "nothing happens". `OAuthConsent.tsx` now branches
on `useAuth()` (the same `localAuth.me` lookup the rest of the app uses), shows a spinner while it is
in flight, offers the existing "Sign in to continue" CTA when there is no session, and calls
`refresh()` when a confirm comes back 401 so the buttons cannot outlive the session that justified
them. No new copy, so no i18n parity work.

Verified: `npm run check` and `eslint` on the file clean; the real page in the real stale-token state
(now that the token is genuinely stale in that browser profile) renders "Sign in to continue" with
only `Log in` / `Feedback` buttons — the pre-fix branch would have rendered Allow there.
NOT verified: a successful end-to-end authorize, which needs the owner to sign in again first; no
code row has been issued locally since 2026-09-21, and #69 still waits on that.

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
