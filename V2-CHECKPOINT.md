# V2 PROGRESS CHECKPOINT — autonomous continuation point

**Updated:** 2026-09-20 14:53 (+03:00)
**Purpose:** if the implementing session or laptop dies, ANY new session resumes from this file + the plan doc. Do not restart completed work.

## Read first (in order)
1. `DeeWaanAI-Next/OFFERING-REDESIGN-V2-IMPLEMENTATION-PLAN.md` — phases, gates, decisions D-a/b/c/e
2. `DeeWaanAI-Next/OFFERING-REDESIGN-TECH-SPECS.md` — governing spec (v2.0); §1.3 open policies P1–P8 are owner-gated
3. `DeeWaanAI-Next/G0-INVENTORY.md` — baseline facts
4. `git log --oneline -15` — source of truth for what is DONE (checkpoint text may lag by one commit)

## Status
| Phase | State |
|---|---|
| P0 baseline | ✅ done (tag `v2-baseline`, repo `github.com/youssef-hariri/deewaanai-v2`) |
| P1 additive foundations | ✅ done + pushed |
| P2a durable design jobs | ✅ done + pushed (commit `2e7be2d`) |
| P2b benchmark engine | ✅ done locally 2026-09-20 — A01/A02/A06/A07/A08 + A21 containment implemented and tested; real-broker queue drill deferred to P6 (same treatment as P2a) |
| P3 evidence + protected exec | ▶️ in progress — evidence manifests (`01be427`), `publishVersion` + legacy isolation (`7fd1a5e`), protected execution + trusted egress (`199860d`), model catalog + release suggestions (`eab9389`) all DONE and pushed. Remaining: `communityEvidence.reportExternal` (task #20) and the A09–A14+A19 acceptance battery incl. the A12 leakage sweep (task #18) |
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

**`npm run dev` serves `/mcp` — one command is the whole stack (fixed 2026-09-21, item 12).** It used to be impossible: the streamable HTTP transport needs the raw node request/response and `@hono/vite-dev-server` discards the argument `@hono/node-server` passes them in, so `initialize` died on an undefined `outgoing`. `vite.config.ts` now mounts the bindings back for `/mcp`, so local MCP work needs no build and no second process:

```
docker compose -f docker-compose.v2.yml up -d    # mysql 3307, redis 6380
npm run dev                                      # http://localhost:3000/mcp
```

The separate node server is still the way to exercise the **production boot path** — `V2_NODE_SERVE=true node dist/boot.js` serves `dist/public` and listens without production behavior, and `NODE_ENV=production` must never be used against this `.env` because it activates the live payment/email credentials in it. If a long-running instance is needed anyway, `screen` (not `nohup`) is required — a nohup'd child dies with the Qoder session, and a restart mid-OAuth looks exactly like a broken server.

## Update discipline
When finishing any increment: (1) commit+push, (2) tick the plan-doc checkboxes with evidence, (3) rewrite "current step" below, (4) when a phase completes set its row ✅ and the next ▶️. When ALL unblocked phases (P2b, P3, P5, P6-local) are done and verified, disable the cron task `v2-phase-watchdog` (qoder_cron remove/run list to find id) and write `V2-ALL-BLOCKED-PHASES-COMPLETE.md` with the acceptance-matrix summary.

## Current step
P3 is functionally closed (items 1–6 ✅, item 7's A12 battery ✅ pushed as `4919f36`); what is left of P3 is item 7's two follow-on tests and item 8 (`communityEvidence.reportExternal`). The next move is a **live-behind-flags session**, not more mocked code — see "First real-key session" below. P2b is closed locally and pushed; read plan §3 P2b for the evidence trail before assuming anything about it.

**Owner input taken 2026-09-20 (later in the A12 session):** D10 admin panel and D11 consented pipeline attachments are now IN SCOPE and written into spec §1.1 + plan §6, and the data-residency question is recorded as open policy **P8** (spec §1.3) — do NOT design storage around it until the owner decides. Both D10 and D11 are "adapt what already ships": `src/pages/AdminPanel.tsx` (7 tabs over 13 of `routers/admin.ts`'s 16 procedures) and `routers/feedback.ts` + the floating screenshot button already exist, so the work is the v2 half of each, not a new product.

**First real-key session (owner asked when live LLM keys become necessary — answer: now, for the four things below; everything else stays mocked):**
1. `trusted_provider_endpoints` rows must be REAL base URLs before protected execution can run at all — the table is empty by policy, so a buyer run is unreachable today (P6 needs the owner's list of approved destinations).
2. Judge quality and cost vectors: rubric grading, judge agreement and the per-candidate Σ arithmetic have only been proven structurally. Pricing (P4) cannot be proposed from mocked token counts.
3. The §12.1 fan-out test against a real published manifest needs a real model id in the catalog.
4. **D9 validation from a user's seat:** register an MCP client against the local server, connect DeeWaanAI MCP to the desktop app, and run one full journey — design job → benchmark → publish evidence → buy → protected run — reading only what a chat client renders. This is the only test that can catch DTOs that are technically correct and unusable in a conversation.
Cheapest useful tranche: one provider key + one cheap model, 1 design job, a 5-case benchmark, 1 protected run. The c=100 pilot is a later, budgeted step, not this one.

**LIVE SESSION RUN 2026-09-21 (first real keys — Together; user `p3-tester` id 354; drove the whole thing over the MCP transport itself: create_benchmark → quote → approve_spend → start → worker → judges → summary). Server must be `V2_NODE_SERVE=true START_WORKER=true PORT=3100 node dist/boot.js` from the user's own Terminal (`nohup`); `npm run dev` cannot serve `/mcp` at all (vite's dev adapter gives no raw node req/res), and anything I start dies with my session. **(That workaround is obsolete — item 12 made `npm run dev` serve `/mcp`; the sentence above is kept because it is what the run actually did.)** Real findings, none reproducible from mocks:**
1. **Ledger cost is `NULL` / `cost_completeness=partial` even when the quote knew prices.** Live pricing (added today) reached `buildQuote`, NOT `benchmarkLedger`'s `estimateCostUsd` (still env-vector-only). So actuals show unknown where the quote showed $ — the exact gap flagged when adding pricing, now proven. Fix = carry the resolved rate (+ basis + asOf) onto `call_attempts` via an additive migration (next number 028); tokens are already stored, so nothing historical is lost meanwhile. **→ FIXED the same day, item 10 below. The two live benchmarks (ids 1–2) keep their unpriced rows: they were written before 028, and no back-fill was attempted — their tokens are stored, so re-pricing stays possible if the owner ever wants it.**
2. **Per-call cost assumptions are wrong both ways** (one 4-case sample, gpt-oss + 2 judges): actual generation 1,584 in / 2,234 out vs assumed 2,000/1,200 (reasoning + 3 long steps); actual judging 524 in / 738 out vs assumed 3,000/300. Actual total $0.0157 vs quote $0.031 — the quote OVER-shot ~2× (safe direction, never under). Recalibrate the 2,000/1,200 and 3,000/300 constants and the judging-input assumption especially before P4. **Deliberately NOT done in item 10: that is one 4-case sample from one reasoning model with a 3-step workflow, and replacing two constants with numbers fitted to n=1 would make the quote look measured when it is still a guess. The fix belongs in P4 with a sample wide enough to fit, and it is a QUOTE-accuracy change, not a ledger change.**
3. **One judge `parse_failed` (Llama-70B likely not emitting the rubric JSON shape)** → benchmark correctly landed `partial`, and honestly counted the failure instead of fabricating a score. First agreement numbers with the 2 valid judges: mean abs deviation 0.084, widest panel 0.41, mean normalized 0.759. A weaker judge silently dropping ratings is a real panel risk.
4. **GLM-5.2 returns EMPTY text unless `chat_template_kwargs:{enable_thinking:false}` is sent (reasoning_effort:none does NOT work)** — reproduced on the live API, exactly the D12 per-judge-options need. The judge call (`judgeService.ts:168`) passes no extraBody, so a GLM judge scores nothing today. Task #24.
5. **`Qwen/Qwen3.7-Plus` is gated behind the org's third-party-data-sharing toggle; Kimi/MiniMax/gemma/Mistral-small need a paid dedicated endpoint.** Working serverless generator used instead: **`openai/gpt-oss-120b`** (disjoint from DeepSeek/Meta judges). Do NOT flip the owner's privacy toggle to make a test pass.
Total spend across the session ≈ **$0.016** (first attempt 403'd at $0), ceiling $2, well under the $20 cap. Benchmarks 1 (failed, 3-judge/Qwen) and 2 (partial, 2-judge/gpt-oss) exist in the local `swarm` DB as real artifacts.


**D9 interfaces (spec §1.1, plan §6):** the workbench is MCP-first, so every v2 capability must be reachable and readable through MCP with complete, labeled, markdown-renderable DTOs — no data that exists only in a web screen. **The procedure for testing that from a real chat client is `DeeWaanAI-Next/D9-DESKTOP-PASS.md`** — run it from a fresh session, because the callable tool surface is fixed at session start. **DONE 2026-09-20:** the 10 `benchmark_*` MCP tools are registered behind `v2Benchmarks` (create/prepare_rubric/prepare_cases/quote/approve_spend/start/status/list/cancel/resume), each a thin adapter over `api/services/benchmark` so a desktop client cannot bypass authorization, plan hashing or spend approval; `deewaanai_help` gained an "Evaluate" group fed by the same flags, and `api/mcp/tools/registry.test.ts` now pins registry↔help parity so the guide can neither advertise an unregistered tool nor hide a live one.

Start with: spec §7.3 (full disclosure manifest list), §8.1–8.2 (restricted snapshot execution + trusted-egress policy), §10.1 (`evidence.preview`, `marketplace.publishVersion`, community publish/report/withdraw, public DTO-only endpoints), §12.1 (model catalog + release events + deduped notices). Then:
1. ✅ **DONE 2026-09-20 (`01be427`)** `api/services/evidenceService.ts`: manifest builder from a COMPLETED benchmark + its frozen plan; preview hash; consent gate; `draft_preview → published → withdrawn`; replacement creates a new publication row (never rewrites `testedAt`).
   Evidence: `buildEvidencePreview` validates against the frozen `PublicEvidenceManifestSchema` and returns a `previewHash` = sha256 over `stableStringify(manifest)` (so hash is reproducible — `pricingAsOf` is anchored to the run's `finishedAt`, NOT wall clock); `publishEvidence` refuses without the exact `approvedPreviewHash` + consent version, is idempotent on the same (benchmark, hash, kind), runs transactionally and bumps `evidenceSummaryRevision` when attaching to a listing; `withdrawPublication` unpublishes the listing only when that publication was its current evidence; `supersedePublication` writes a NEW immutable row with `supersedesPublicationId` and copies `testedAt` verbatim. §4.3 is enforced by refusing to certify an imported-only benchmark as seller evidence with a policy message (publish as community instead); §7.3 refuses a limited-disclosure report as seller evidence up front rather than letting the schema reject it; §7.1 disabled validators and per-candidate provenance are carried into every manifest; `scanForSecrets` blocks credential-bearing manifests and the test plants a fake `sk-…` key to prove the redaction survives end to end. 7/7 in `evidenceService.integration.test.ts` (throwaway DB `swarm_v2test_evidence`).
   **Superseded by item 3:** the seller half of this paragraph moved to `publishVersion`/`publishCommunityEvidence` (`7fd1a5e`) — `publishEvidence` no longer exists, and both tRPC and MCP reach the service.
2. ✅ **DONE 2026-09-20 (`199860d`)** `swarmService` refactor: an authorized snapshot loader is the only way a protected version executes for a buyer (§8.1).
   `api/services/marketplaceExecutionService.ts` + `api/services/protectedEgress.ts` + the v2 branch of `executeSwarmRun` (swarmService.ts:1352). The interpreter is reused, not reimplemented. `run_params.snapshotVersionId` alone no longer grants anything: if the version's `ownerId !== callerId`, the branch requires `run_params.protectedRun` AND calls `loadAuthorizedSnapshotSteps`, which RE-RESOLVES the right from current rows (purchase/grant still active, listing still sells that version, provider still the caller's, endpoint still approved) before returning steps — a revocation after queuing stops the run. Steps come back with `providerId` pinned to the BUYER's approved provider and `agentId: null`, so a seller provider is never the billable route and no seller custom-agent record is reachable (A14). The buyer's container project holds no steps/template/agent rows — the test asserts zero copies exist. Gitee, GitHub, local-folder, attachments and prior-run context stay off (synthetic project + `stateless: true`). `getProtectedRunView` selects step metadata only; the `systemPrompt`/`userPrompt`/`contextInput` columns are not in the query at all. Admission follows §8.3's order so refusals cost no provider call, and `v2Commercial` staying OFF means `purpose: "trial"` is refused with `trial_policy_unresolved` rather than quietly enabled. Redirects: `ChatOptions.noRedirect` → `redirect: "error"` in both adapters, applied only to protected runs. 8 DB-backed cases (`swarm_v2test_execprot`) + 6 pure egress cases.
   Still open here: §8.3's atomic TRIAL reservation (needs P4) and rate/concurrency limits beyond the existing provider throttle. (The A12 battery this line deferred landed in item 7.)
3. ✅ **DONE 2026-09-20 (`7fd1a5e`)** `marketplace.publishVersion` as the sole seller boundary, flag `v2Publication`.
   `evidenceService.publishVersion` names the sold version and refuses unless the evidence tested exactly that version (A11), requires both listing and version to be the caller's (same message for missing and foreign — no existence leak), refuses a project-lineage contradiction, and enforces `expectedListingRevision` BEFORE the idempotent-reuse short-circuit so a stale token is a refusal, not a silent no-op. Publication + sidecar (`publicationMode=v2`, `currentWorkflowVersionId`, `currentEvidencePublicationId`, `evidenceSummaryRevision+1`) + the listing's `published` status happen in ONE transaction, and §10.2's "no new `certifying` transition for v2" holds (the listing goes draft→published or stays published). `publishCommunityEvidence` is a separate entry point that can reference a listing but never becomes its required evidence. Reads: `getPublicEvidenceForListing`, `listPublicEvidenceForListing` (summaries derived FROM the stored manifest so they cannot disagree with it), `getPublishedManifestByHash` (withdrawn manifests stop resolving; the row survives). tRPC: `marketplace.publishVersion/publicationState/getPublicEvidence/listCommunityEvidence/getEvidenceByHash`, `evidence.preview`, `communityEvidence.publish/withdraw/supersede/policy`. MCP (D9): 7 `*_evidence*` tools behind `v2Publication` + a "Publish" help group, and `registry.test.ts`/`helpContent.test.ts` pin that the gated half hides when the flag is off while `get_public_evidence` stays readable. Gate lives in the SERVICE (`assertPublicationEnabled`), so no surface can bypass it; flag-off is a real rollback (`publication_disabled`).
4. ✅ **DONE 2026-09-20 (`7fd1a5e`)** legacy certification paths cannot publish or re-grade a v2 listing.
   `api/services/marketplacePublication.ts` holds the single guarded writer `setLegacyListingStatus(listingId, patch, {ownerId?})`; all 17 legacy status writes in `routers/marketplace.ts` (blind certification ×2, security scan, generating, 4× draft revert, triage, certifying, publish, unpublish, reviewing, auto-grade, auto-publish, calculateGrade) and `routers/admin.ts` (2× requeue) now go through it instead of touching the table — the guard is structural, not a per-call-site reminder. It locks the LISTING row first (same order as the v2 boundary, so no deadlock) and reads `publicationMode` under that lock. Asymmetric on purpose: `unpublished` is allowed for a v2 listing (a seller delisting themselves), every other status throws `v2_publication_locked`. `submitForReview` refuses BEFORE spending on test-data generation; the fire-and-forget background block swallows a lock refusal instead of producing an unhandled rejection. `delete` refuses with the same message (its evidence FK is RESTRICT). Test: `the legacy certification pipeline cannot touch a v2 listing's standing`.
   STILL OPEN: run the OLD tRPC flows end-to-end against a v2 fixture (tracked in item 6/#18), and `communityEvidence.reportExternal` (task #20).
5. Expose evidence preview/publish/withdraw/supersede + the public evidence read through tRPC AND MCP tools behind `v2Publication` — ✅ done with item 3.
6. ✅ **DONE 2026-09-20 (`eab9389`)** §12.1 model catalog, replay-safe release events, deduped in-app suggestions (see the plan-doc line for the full evidence trail; 7 tests in `modelCatalog.integration.test.ts`, throwaway `swarm_v2test_catalog`). Admin-only writes are enforced in the SERVICE (`assertAdmin`), not only in `adminQuery`. No MCP tool records a model or fans out notices — §12.1 forbids a public caller triggering mass notifications.
7. ▶️ **A12 HALF DONE 2026-09-20 (this increment)** — the leakage battery is green across every audited surface; the end-to-end legacy-flow refusal and the real-manifest suggestion fan-out are still open in this item.
   `api/services/a12Leakage.integration.test.ts` (throwaway DB `swarm_v2test_leak`, 10 cases) runs the REAL interpreter end to end — only the provider adapter and the slot allocator are mocked — and the fake adapter deliberately echoes the seller's step-1 system prompt into that step's OUTPUT, so the stored intermediate genuinely contains the secret and every projection has to drop it. What it forced into the code:
   - **Write-side redaction** (swarmService.ts:269 `stepPromptAuditFields`, used by the `agentRuns` insert): a protected run stores `[protected: N chars, not stored]` instead of the 200-char prompt summary, so EVERY read path — including ones added later — inherits the protection. `agent_runs.user_prompt` is NOT NULL, hence the non-nullable `userPrompt` in its return type.
   - **Read-side final-output-only projections**, because redaction covers prompts and not outputs: `export.exportRun` and `export.exportProjectBackup` now drop the prompt columns (`runAccess.PROMPT_BEARING_RUN_COLUMNS`) and filter `agentResponses` to `finalResponseId`, with a `protection` note explaining the gap; `response.getById` returns null for a protected run's intermediate even when the caller owns the run (project visibility ≠ step visibility); `response.getChain`/`listByType` already filtered.
   - **SSE was the last unauthenticated route**: `/api/stream/:runId` streamed any run's events to anyone who could guess an id. It now requires `?userId&exp&sig` from `api/lib/streamToken.ts` (HMAC over the (run, user, exp) triple keyed by APP_SECRET, 1-hour TTL, timing-safe — the same shape as `screenshotUrls.ts`, because EventSource cannot send headers and a session JWT must never sit in a URL where nginx logs and Referer would keep it) and re-checks `canAccessRun` at connect time so a revoked share stops streaming. New minting endpoint `swarm.streamUrl` applies the same visibility rule; `ProjectWorkspace.setupSSE` fetches the signed path first (needs `trpcClient`, now exported from `src/providers/trpc.tsx`).
   - **Provider error text is withheld on protected runs** (`step_error`/`pipeline_error` emit a fixed notice; the category still reaches the buyer through `classifyProtectedError`), because a provider message can quote the request, and the request IS the seller's workflow. `swarm.execute({runId})` now refuses a marketplace run alongside `resumePipeline`/`approveStep` (it used to overwrite `run_params`).
   - Positive controls keep it honest: the seller's own run still stores the prompt summary and streams it, the buyer's answer and 2-step progress still arrive, `assertRunControlAllowed` did not rewrite run_params, and cross-tenant reads/writes (`response.*`, `debug.*`, `agent.list`, `export.*`, MCP `run_status`, team sharing) refuse by id. `debugLogs` turns out to have NO writer in this codebase, so the debug router's guards are the whole story there.
   Gates for this increment: check ✅ build ✅ i18n ✅, 338 tests / 334 passing with the 4 `providerThrottle` baseline failures only.
   Still open in item 7: run the OLD tRPC certification flows end-to-end against a v2 fixture, and the §12.1 suggestion fan-out from a real stored manifest.
8. `communityEvidence.reportExternal` (task #20) — `external_evidence_reports` has no writer yet; needed for A09's user-reported half.
9. ✅ **DONE 2026-09-21 — quotes now price from the provider, not a hand-kept table.** Owner's instruction: models and providers change prices and run promotions, so don't maintain a vector — retrieve. `LLMProviderAdapter.listPricing?()` (implemented on the OpenAI-compatible adapter, which covers Together) reads the host's own `/models` `pricing.input`/`pricing.output` in USD per 1M tokens and converts to the per-1K unit the ledger uses; `api/services/benchmark/modelPricing.ts` merges live-over-vector per model with a 10-minute per-provider cache, an 8s de-race, and exact-then-case-insensitive matching only (a fuzzy match would silently bill a sibling model's rate). `QuoteResult` gained `pricingBasis` / `pricingAsOf` / `rates[]` / `estimatedTotalCostUsd`, and the quote now discloses three things it previously hid: which source produced each number, that LIST prices cannot see promotional/committed-use/cached-input discounts, and that the estimate rests on per-call token ASSUMPTIONS (2,000/1,200 generation, 3,000/300 judging). Unretrievable stays UNKNOWN, never zero (spec §9). 4 tests in `modelPricing.test.ts`; gates green (338 passing, 4 `providerThrottle` baseline). **Known gap deliberately not patched here:** the ledger's post-hoc `estimateCostUsd` still reads only the env vector, so actuals can read `unknown` where the quote read a number — carrying the resolved rate onto `call_attempts` needs an additive migration plus a `cost_basis`/`cost_pricing_as_of` pair, and the paper's own convention (store tokens, re-price later) means nothing is lost in the meantime.

10. ✅ **DONE 2026-09-21 — the ledger prices ACTUALS from the same rates the quote used (live-session finding 1, task #25).** Additive migration `028_call_attempts_cost_basis.sql` gives `call_attempts` a `cost_basis` varchar(16) and a `cost_pricing_as_of` timestamp, both nullable and both purely additive (applied to the local `swarm` DB; next number is 029). `modelPricing.rateForAttempt(providerRefId, model)` is the ledger's door into the SAME resolver `buildQuote` uses — provider list first, env vector second, exact-then-case-insensitive only, null when nothing is known — so "$ quoted" and "$ spent" can no longer be built from different worlds. `benchmarkLedger.priceAttempt` prices on `returnedModel` then `requestedModel` (the quote was built from the requested id, so a host that renames the model on return still yields a comparable pair), records which source produced the figure, and wraps the whole lookup in a catch: **a pricing failure must never lose the ledger row it is annotating.** `estimateCostUsd` is gone; `cost_completeness` is now `complete` iff a rate resolved, `unknown` otherwise, and `uncertain` outcomes stay `unknown` regardless because an unknown-billed call is not a priced one.
   The aggregate-generation question needed its own rule: a generation child is ONE row carrying the SUMMED usage of every step, so `singleRouteOfSnapshot(definition)` returns a (provider, model) pair only when every call-performing step (`stepsToLlmCallCount`'s set — everything but `approval`) shares one provider and one model, and refuses if any step falls back to an unnamed project default. Mixed pipelines therefore price as UNKNOWN instead of being averaged across models that match no invoice. That route is passed as `pricingRoute`, a PRICING-ONLY input: `provider_ref_id` keeps meaning "whose credential this ran against", so `testedModels[].provider` in a published manifest is untouched (filling it would have silently rewritten public evidence bytes, which is not what this fix is for). `benchmarkLedgerTotals` now returns `pricingBases`, and `evidenceService` derives `costs.pricingSource` from the rows instead of asserting "platform price vector" over figures that may have come from a provider list — the sentence was a lie the moment live pricing landed.
   Evidence: 8 tests in `modelPricing.test.ts` (rate resolution + the four route-refusal cases, pure) and a 7th case in `benchmarkExecution.integration.test.ts` that runs the real freeze→quote→approve→execute path with a vector in env and asserts the generation row is priced to 10 dp off 120/30 tokens with `provider_ref_id` still NULL, the judgment row off 400/60, `knownCostUsd` = the sum, and — with an unlisted step model — `estimatedCostUsd` NULL, `cost_completeness` `unknown` on that row and `partial` for the benchmark, never 0. Gates: check ✅ build ✅ i18n ✅ lint clean on every touched file ✅, 348 tests / 344 passing with the same 4 `providerThrottle` baseline failures only.

11. ✅ **DONE 2026-09-21 — D9 reference page for the MCP surface: `DeeWaanAI-Next/MCP-TOOLS-WIKI.md`.** All **69 registered tools** documented by group (Discover 5, Run 3, Research 5, Author 7, Evaluate 10, Marketplace 11, Publish 10, Account 6, Your data 3, Team 8, Diagnostics 1), each with its real description, its scopes, its feature flag, its tier capability, the read-only annotation, the argument table generated from its own zod schema (nested `cases[]`/`judges[]`/`candidates[]` flattened, constraints rendered), and a phrasing example where the help catalog has one. Plus the parts a chat client cannot infer from `tools/list`: the OAuth 2.1 endpoint map and why PKCE-S256-only public clients are the right shape here, **the four gates between a token and a result** (bearer → per-customer rate limit → per-session feature flag, fail-closed → scope), the local bring-up recipe, 401-with-challenge as the healthy probe, `200`+HTML meaning the SPA fallback ate the route, the two production-pointing scripts never to run locally, and the cross-cutting honesty rules (UNKNOWN≠0, plan-hash-bound approval, completed≠verdict, completion≠publication, protected runs withhold prompts, retries append).
   Building it surfaced two things, both fixed rather than noted:
   - `get_next_review_task` and `submit_review_task` were registered but absent from `HELP_CATALOG`, so a reviewer could not discover the two tools that perform the human half of certification — `enroll_reviewer` only says they will be "auto-assigned". Both entries added to the Marketplace group.
   - `api/mcp/tools/registry.test.ts` pinned only "help must not advertise an unregistered tool"; the checkpoint's claim that the guide can also not *hide* a live one was not actually enforced, which is how the pair above stayed invisible. The test is now bidirectional, so the next undocumented tool fails the suite instead of failing silently.
   **New open risk found while writing it (task #26, recorded not patched):** the 8 `team_*` tools demand `team:read`/`team:write`, but `MCP_SCOPES` in `api/mcp/auth.ts` caps every OAuth-issued token at the three `mcp:*` scopes and that OAuth path is the only minter of a token `/mcp` accepts — so gate 4 can never pass for them and they are dead surface independent of the `teamsync` flag. Both candidate fixes (widen consentable scopes, or retire the tools until team sync really ships behind MCP) move an authorization boundary, so they need the owner's call.

12. ✅ **DONE 2026-09-21 — `npm run dev` serves `/mcp`, so no one has to open a terminal to develop against the workbench (owner: "not practical for real world users, we need to fix this").** The root cause was narrower than "vite can't do it": `@hono/node-server`'s `getRequestListener` calls its fetch callback as `fetchCallback(req, { incoming, outgoing })`, but `@hono/vite-dev-server` declares `async (request) => …`, **drops the second argument**, and calls `app.fetch(request, env)` with its own empty env — so the bindings were present one layer up and thrown away at the seam. Fix is a 20-line vite plugin (`mcpNodeBindings` in `vite.config.ts`) that intercepts `/mcp` before the dev adapter and re-attaches them, loading the SAME `api/boot.ts` specifier so vite's SSR graph returns the one already-loaded app — a second copy would have started a second in-process worker (verified: three worker-start lines, not six). `V2_NODE_SERVE` stays as the production-boot-path check, and `api/boot.ts`'s comment no longer claims dev is impossible.
   Proven, not assumed: against plain `npm run dev` on :3000 — unauthenticated `GET /mcp` → **401 with a `WWW-Authenticate` challenge carrying the right origin**, discovery doc returns JSON, the SPA still serves at 200, and a scripted handshake with a real HS256 token got `initialize 200` + a `mcp-session-id` header (only settable with the raw response) → `tools/list` **60 tools for `p3-tester`** → `tools/call list_benchmarks` returned the two live benchmarks from the `swarm` DB. **Production users were never affected** — the hosted app runs `node dist/boot.js` and `env.isProduction` listens; the terminal dance was a developer-only artifact, and it is now gone.
   The wiki stopped being a hand-copied document at the same time: `scripts/mcp-tools-wiki.mjs` renders it from a metadata dump, and `api/mcp/tools/wikiDump.test.ts` produces that dump under `MCP_TOOLS_WIKI=1 npx vitest run api/mcp/tools/wikiDump.test.ts` (skipped in a normal run so the suite never writes files). `tsx` cannot load the registry — it hangs on boot's side effects — which is why the dumper is a vitest file.

Carried-over open risks to handle deliberately, not silently:
- `team_*` MCP tools are unreachable by any token the server can actually issue — see item 11 and task #26. Until that is decided, the D9 claim "every v2 capability is reachable through MCP" is true for the v2 groups and false for Team.
- `contracts/offeringV2.ts` `CallPlanEstimateSchema` is richer than the benchmark service's `QuoteResult` (per-line costs, assumptions, price-vector metadata, bounded-high totals). Reconcile before P5 builds the cost-approval dialog on it. The internal `RubricSpec` also diverges from `RubricSchema` (`anchor` vs `anchors`, numeric vs decimal-string weights).
- A benchmark whose candidate is an imported output is user-reported provenance and CANNOT satisfy §4.3's "platform-recorded execution" requirement for publication — enforce that in `evidenceService`, and note `benchmarkCandidates.imported_response_id` is `ON DELETE SET NULL` by design (the graded text is copied onto the run row).
- Deterministic validators stay disabled while no isolated sandbox exists (§7.1). Publishing a manifest must disclose that, never omit it.

## P2b landing record (2026-09-20)
`ae13ff0` (golden path + fixes) plus this increment: A01 imported-output grading, per-candidate Σ generation arithmetic, explicit disabled-validator disclosure, judge-agreement in the summary, §10.2 partial-state fix, sequential version materialization, migration 027, and 21 new tests (34 benchmark tests total). Gates: check ✅ build ✅ i18n ✅, 289 tests with the 4 `providerThrottle` baseline failures only.


## DESKTOP PASS 2026-09-22 (D9 — `DeeWaanAI-Next/D9-DESKTOP-PASS.md`, run as written, nothing fixed)

**Seat:** fresh session, plain `npm run dev` on :3000. Unauthenticated `GET /mcp` → **401 + `WWW-Authenticate`** (healthy), `tools/list` → **60 tools** for `p3-tester` (id 354, tier `standard`, one provider: id 2 `together-live`). Flags as the protocol states. Judge/generator models as the protocol states (GLM-5.2 left out per task #24).

**Sequence run:** `deewaanai_help` · `get_settings` · `list_pipelines` · `get_pipeline(196)` · `start_design_job` · `design_pipeline` · `create_benchmark`(3: grade_only, 5 real contract clauses, 2 judges, bespoke 5-dimension rubric) · `prepare_benchmark_rubric` ×2 · `quote_benchmark` · `approve_benchmark_spend` ×3 · `start_benchmark` ×2 · `benchmark_status` · `list_benchmarks` · `cancel_benchmark` ×3 · `create_benchmark`(4,5,6,7) · `resume_benchmark` ×3 · `create_pipeline`(223) · `publish_to_marketplace` ×2 · `preview_evidence` ×3 · `publish_community_evidence` ×2 · `publish_evidence_version` · `get_public_evidence` · `listing_publication_state` · `get_listing_status` · `marketplace_execution_right` · `my_marketplace_listings` · `my_purchases` · `start_protected_run` · `model_retest_suggestions` · `batch_status` (probe only). **Blocked before reaching the product:** `upgrade_tier` — my own client's safety classifier refused it as a payment flow, so the upgrade-CTA leg of step 3 was never observed. **Not exercised:** the reviewer pair, `run_pipeline`/`run_status`/`approve_step`, `export_*`, `add_provider`/`set_default_model`/`memory_*`/`project_context`, `search_marketplace`, `supersede_evidence`/`withdraw_evidence`, `respond_retest_suggestion`, `protected_run_status`, `run_batch`/`resume_batch`/`export_batch_results` (not started — see finding 7).

**Spend, quoted versus observed (the migration-028 comparison the protocol asked for):**

| benchmark | quote forecast | ledger actual | ratio |
|---|---|---|---|
| 3 grade_only, 5 cases, 2 judges | $0.03876 (gen $0.0153 / judge $0.02346) | **$0.02535202, `cost_completeness=complete`** | actual = 65% of quote; gen came in at 77%, judging at 58% |
| 5 compare_models, 5 cases, 2 candidates, 1 judge | $0.07782 (gen $0.06522 / judge $0.0126) | **$0.00000000, `cost_completeness=partial`** — every one of its 19 ledger rows unpriced | not computable; reconstructed from stored tokens = $0.02916 (37% of quote) |

Session total ≈ **$0.055** against the $20 cap; no single benchmark over $0.08 against its $2 ceiling. `quote_benchmark` was called before every `approve_benchmark_spend` and never forecast more than expected. Artifacts left in the local `swarm` DB on purpose: benchmarks 3 (completed) / 5 (**still `queued`** — see finding 24) / 4, 6, 7 (cancelled probes), project 223, listing 1 (draft), community publication 1, spend approvals 3–5. Benchmark 5 therefore never reached a terminal state, so its own evidence was not previewed or published — the publication leg ran on benchmark 3 only.

**Findings — one line each, in the order a user meets them.**

1. **`benchmark_status` prints an unknown cost as `$0.00000000`.** Benchmark 5: `knownUsd:"0.00000000"`, `totalCalls:19`, `uncertainCalls:0`, `costCompleteness:"partial"`. A user reads "19 calls, nothing owed". D9's own rule is "unknown cost is not zero" — and the same field renders as `null`+`unknown` while running, so the two encodings of "not known" both appear and only the second one is safe.
2. **`benchmark_status` is the only route to progress and cost, and it drags the entire frozen plan with it** — all 5 full clause texts (~4k chars) on every poll. `list_benchmarks` is compact but has no progress, no cost and no scores, so "how is it going / what has it cost" has no cheap answer.
3. **compare_models actuals never price at all** (finding 1's cause, and it is not fully explained): all 10 generation rows and all 9 judgment rows have `estimated_cost_usd` NULL and `cost_basis` NULL despite stored `requested_model` and non-zero tokens, while benchmark 3's 15 rows all priced. The generation aggregates carry `provider_ref_id` NULL, and `rateForAttempt` only consults the provider's live list when it has a numeric provider id (`api/services/benchmark/modelPricing.ts:102`), so it falls back to the env vector, which has none of these models — but the *judgment* rows had `provider_ref_id=2` and still came out NULL, which I could not account for from the code. Whoever fixes this needs to explain both halves.
4. **`preview_evidence` `withholdInputs:true` does not withhold what the rationales repeat.** With inputs withheld, the manifest still publishes every judge rationale verbatim, and they recite the withheld clause: case-2's rationale spells out the credit formula and the 20% cap. A seller protecting a client's contract still discloses its substance, and the payload barely shrinks (the rationales and the judge prompt stay). The same call is also the consent screen — ~14k chars for a full manifest, with `previewHash` and the `next` instruction at the very end, past everything the user must read.
5. **A model can grade itself with no warning.** Benchmark 7: `grade_only` on project 196 (every step `openai/gpt-oss-120b`) with `openai/gpt-oss-120b` as the sole judge → `blockingErrors:[]`, i.e. approvable, runnable, and publishable as evidence. Nothing anywhere asks whether the judging developer is disjoint from the candidate's; the panel-disjointness rule lives only in this protocol document, so a real user's benchmark can be self-graded and self-certified.
6. **4 live tools are invisible in the guide.** `run_batch` / `batch_status` / `resume_batch` / `export_batch_results` are in `tools/list` for this account, and `deewaanai_help` shows only `export_run` under Research, because `helpContent.ts:127-141` marks them `flag:"batch_mode"` while their `McpTool` definitions carry no `featureFlag` at all. `registry.test.ts:60-69` compares *names* against the raw `HELP_CATALOG`, not the rendered guide against the rendered surface, so the bidirectional parity pin cannot see this class of skew — which is the same bug the reviewer-tool pair exposed and the fix did not cover.
7. **…and those tools ignore the flag that hides them.** `batch_status` answers "Batch not found" and `run_batch`'s handler calls `createBatch` with no flag check, while `api/routers/swarm.ts` gates all six web batch entry points on `isFeatureEnabled("batch_mode")` (default OFF, `featureFlags.ts:108`). A rollout-restricted capability that can run 100 paid pipeline runs is fully live from chat. Read-only probes only — I did not start a batch.
8. **`planHash` is held by the user across three calls, and only one of them echoes it.** The quote returns the 64-hex; `approve_benchmark_spend` replies `{"spendApprovalId":3,"next":"start_benchmark with the same planHash…"}` — it names the hash it authorised without showing it, so a mismatch is discovered only by a refusal.
9. **A replayed `start_benchmark` reports success.** Second call, same consumed approval, returned `{"state":"running"}` with no hint that it was a no-op. No double spend (verified: `benchmarkService.ts:589` returns before the approval is read and `runs.total` stayed 5), but the description promises approvals are "consumed exactly once", and the reply for a replay is identical in shape to the reply for a start.
10. **The quote's own warning contradicts its number.** "a wide rubric costs more than this quote" — going from 4 to 5 dimensions changed nothing: still $0.03876, still 10 judging calls, because judging is modelled at a fixed 3,000/300 tokens per call. Measured from this pass's ledger: judges emit 128–1,311 completion tokens per call (DeepSeek ~1,100, Llama ~150), so the 300 assumption is off by ~3.5× for one of the two judges while the total still over-forecast. Calibration belongs to P4, not this pass; the *inconsistency between sentence and figure* belongs here.
11. **Rate display is truncated below usefulness.** `rates[]` carries `usdPer1KInput:0.00015` and the warnings line renders "0.0001 in" (33% low); Llama's 0.00104 renders "0.0010". Per-1K sub-cent rates need per-1M presentation — the unit Together itself publishes in.
12. **`publish_to_marketplace` dead-ends into a web screen: "Save it as a template in Project Settings first."** Project 196 (built last session) has no template; project 223, created with `steps` inside the `create_pipeline` call, published immediately as listing 1. So a template is a side effect of one argument shape, there is no MCP tool that creates one, and the seller half of the D9 journey silently requires the UI that D9 removed from the plan.
13. **`publish_community_evidence` returns `{publicationId:1, evidenceSummaryRevision:null, previousListingStatus:null, manifestHash, reused:false}`** — no sentence confirming anything is now public, and the two `null`s are indistinguishable from "zero". The published report is then **unreadable from MCP**: `get_public_evidence` requires a `listingId` and this publication has none, and there is no list-my-publications. Writes are addressable by id (`withdraw_evidence` takes `publicationId`); reads are not.
14. **§7.3's limited-disclosure refusal is the model for error text** — "publish it as community evidence, or re-run with non-sensitive inputs" — which makes finding 12's "save it as a template in Project Settings" and finding 20's bare tier refusal look like outliers, not a house style.
15. **`get_listing_status` lies about state.** Listing 1, never submitted, `status:"draft"`, `aiReview:null`, `canPublish:false` → message "Review in progress: 0% complete (0/15 reviews)." A fallthrough at `api/mcp/tools/marketplaceTools.ts:253-262` asserts a pipeline stage that has not begun. Next turn the user enrolls reviewers for a listing nobody has looked at.
16. **`listing_publication_state` reports `publicationMode:"legacy"` for a listing created minutes ago through v2 MCP.** Correct by design (the sidecar flips at seller publication), but nothing distinguishes "not published yet" from "stuck in the old system", and `evidenceSummaryRevision` is `0` here versus `null` in the publish reply.
17. **The same stored object arrives in two shapes.** `prepare_benchmark_rubric` returns `weight:0.3` and `range:"0-10"` as numbers; the manifest returns `weight:"0.3"`, `lowerBound:"0"` as strings, and duplicates each anchor as both `definition` and `anchors[0]`. Mixed encodings of "not known" too: the string `"unknown"` for `designCostUsd`/`providerInvoicedAmount` beside a JSON `null` for `platformLicenseCharge`, in one object.
18. **`attempts.attempts[]` mixes two naming conventions in one list:** generation refs read `case-1/pipeline-as-configured/r1`, judgment refs read `judgment#9…#18` — internal row numbers that cannot be traced back to the case they graded, in the payload whose stated job is full disclosure.
19. **`resume_benchmark`'s two refusals both mislead.** With a consumed approval: "resume needs a fresh active spend approval" (correct). After approving freshly, on a benchmark whose own status line says `failed:1`: `nothing_left_to_do` — it does not mention `retryFailed`, the argument that exists precisely for that child. And `quote_benchmark` on a *partial* benchmark re-forecasts the whole original plan (30 calls, $0.07782), so the approval signed for a 1-child resume is bound to a number ~25× the work about to be spent.
20. **Auto-design is unreachable for the account this protocol names, and the two entry points refuse differently.** `start_design_job` → "Auto-design requires the auto-design tier." `design_pipeline` → the same sentence *plus* "Create the pipeline manually with create_pipeline, or upgrade the plan." The tool the journey lists first is the one that leaves the user stranded; `p3-tester` is `standard`, so step 3 cannot be completed as written from any MCP surface.
21. **`benchmark_status` contradicted itself once:** top-level `runs.failed:0` beside `perCandidate[0].runs.failed:1` in the same response, while the resumed child was requeued. Worth re-checking whether the per-candidate rollup is stale by design.
22. **`aggregateAvailability` is an unguessable enum described as something else.** Values `none`/`incomplete`/`complete`; `list_benchmarks`' description calls the column "evidence availability", and it is about whether descriptive aggregates could be computed. A user with `incomplete` next to `partial` cannot tell an unfinished run from an un-aggregable one.
23. **`model_retest_suggestions` returns a bare `[]`** — no distinction between "your evidence is current", "no release events recorded yet", and "nothing you published is addressable".
24. **A resume's success reply is not evidence that anything will run.** `resume_benchmark` answered `{"ok":true,"state":"queued","requeued":1}` at ~11:21; 17 minutes later the benchmark is still `queued` and its requeued child (`benchmark_runs.id=14`) is still `pending` with `started_at` NULL, while all nine siblings that ran on the first `start_benchmark` completed in 20–50 seconds each. So `state:"queued"` means "accepted", not "will execute", and nothing in the payload distinguishes a resume that stalled from one that is merely next in line. It will end at `deadlineMs` (1,800,000 = 30 min) unless the worker picks it up. I did not chase the cause — that is a fix-session task — but the pass cannot call step 8's resume leg green: the resume *gate* behaved (fresh approval demanded, `retryFailed` honoured, no approval consumed by `nothing_left_to_do`), the resume *execution* did not.

**What read well enough to keep** (so a fix pass does not "improve" it): `plan_changed` fired on the edited plan and again on the consumed approval path, with the A06 tag and the next action; publishing with a wrong `previewHash` was refused; `lineage_mismatch` named the actual contradiction; `blockingErrors` appears both as a field and as a `PLAN BLOCKED:` prefix inside `warnings`; the quote says UNKNOWN never zero and means it; `unitNote` explains planned calls versus observed operations (15 planned / 5 observed for one benchmark, which otherwise reads as a third of the work missing); `scopeStatement`, the `judgeAgreement.note` disclaimer and `highestObservedScope` all decline to over-claim; `start_protected_run` and `marketplace_execution_right` refuse with the same plain `listing_not_published`.

**Finding 25, found while checking the tier question afterwards (so it is recorded, not patched):** **capability gates are per-tool by remembering, not structural.** `publish_to_marketplace` is declared `capability: "marketplace:publish"` in `helpContent.ts:223`, so the guide tells a `standard` user it is locked and to upgrade — and `api/mcp/tools/marketplaceTools.ts` contains **no capability check at all**, which is why `p3-tester` (capabilities `["llm:1","pipeline:fixed"]`) created listing 1 from chat this session. The design pair refuses correctly (`Auto-design requires the auto-design tier`), so the two halves of the same tier story behave opposite ways: a paid-plan boundary that the MCP surface simply does not enforce, plus a guide that advertises a lock that is not there. `can()` and `TIER_CAPABILITIES` already exist in `api/services/entitlements.ts:39` — the gate is available and unused.

**Result of step 7, recorded not faked:** `trusted_provider_endpoints` still has **0 rows** (confirmed read-only against the local DB), and the leg stops earlier than that anyway — listing 1 cannot leave `draft` because its seller evidence must be measured on its own workflow version, and benchmark 3 measured a different project (finding 12). `start_protected_run` therefore refuses `listing_not_published` before the egress gate is ever reached.

**Substantive results for the owner (not interface defects):** pipeline 196 scored **0.322/1.0** mean normalized under the bespoke rubric with both judges scoring `fidelity_no_invention` 0–7 and repeatedly calling out *invented terms* in the redline step — the pipeline rewrites clauses rather than redlining them, which every judge rationale noticed. Under the generic preset the same pipeline+model scored 0.621 versus 0.346 for the Llama candidate, so a **2× swing on identical artefacts comes from the rubric and panel, not the model** — evidence for keeping scores rubric-bound in the manifest. Inter-judge MAD 0.21 with widest panel 0.65 on 5/5 two-judge panels. Last session's Llama `parse_failed` did **not** recur: 0 parse failures across 15 judgments.

## FIX INCREMENT 2026-09-22 (desktop findings F3/F4 + #31 buyer retention + #20 community reports)

**What landed, per finding:**

- **F4 → `api/mcp/renderResult.ts`** (new): `server.ts` now wraps every tool result through `renderToolResult(name, result)`, so a chat client gets a Markdown `content[]` preview *and* the byte-exact `structuredContent` it had before. Previews are bounded (5 items / 12 fields / depth 4 / 100 nodes / 240 chars of text), HTML and markdown are escaped, and `export_*` plus consent previews keep a lossless JSON fence. 33 tests, including an SDK round-trip through `InMemoryTransport`. Fixes findings 1, 4's consent-screen wall, 13, 17, 22's "unreadable payload" half.
- **F3 → `api/mcp/tools/settings.ts`**: `set_default_model` resolves the model *inside a transaction against the caller's own enabled providers*, sets `setProviderDefault`, and answers with `resolvedDefault {model, providerId, source}` plus `modelAccessVerified:false` and `nextSteps` — the refusal no longer ends at "upgrade the plan" (finding 20) and the user can see which provider their default now routes to. 24 tests.
- **#31 → `resolveProtectedExecutionRight`** (`api/services/marketplaceExecutionService.ts`) allows `published` **and** `unpublished` listings — never `trial` — so everything already bought keeps running when a seller delists (owner decision 2026-09-22), and pins the version actually sold: explicit arg → purchase receipt → grant → legacy current, reported as `versionBinding`. `marketplace_purchases` gained `workflow_version_id` / `evidence_publication_id` (**migration 029**, additive, FKs `fk_purchase_workflow_version` / `fk_purchase_evidence_publication`); fulfillment writes both for v2 listings and refuses when version and evidence disagree.
- **Withdrawn evidence is now readable by the people who relied on it**: `getEvidenceForViewer` (drafts never; `withdrawn` only to the author or an entitled buyer of *that* version, with a notice that says withdrawal is not a quality verdict) and `getPurchasedEvidenceForListing`, exposed as authed tRPC `evidence.getPurchasedEvidence` / `marketplace.getPurchasedEvidence` and through `get_public_evidence`, which now takes exactly one of `listingId` / `publicationId` / `manifestHash` and returns `purchasedEvidence` (finding 13's "writes addressable, reads not").
- **#20 → `externalEvidenceService` + `EXTERNAL_EVIDENCE_TOOLS`**: 5 tools (`preview_`/`report_`/`get_`/`list_`/`withdraw_external_evidence`) for user-declared community evidence on a published listing. Consent is durable before the write — `preview` returns a `previewHash` + `consentVersion`, `report` refuses without the pair (**migration 030**, additive: `publication_state` / `consent_version` / `preview_hash` / `published_at` / `withdrawn_at`). `withdraw` is author-only, idempotent, deliberately **not** flag-gated so it stays available after publication is disabled, and removes from public reads without deleting content or proof. Registered tools: **74** (`MCP-TOOLS-WIKI.md` regenerated); help/registry parity tests updated both directions.

**Gates:** `npm run check` ✅ · `npm run build` ✅ · `node scripts/check-i18n.cjs` ✅ · touched-file eslint clean (one pre-existing unused-disable warning in legacy `marketplace.ts:1232`, untouched) · `npm test` → 449 passed / 4 failed / 1 skipped, the 4 being the documented `providerThrottle` baseline. Migrations 029+030 applied to the local `swarm` DB only.

**Still open after this increment:** F3/F4 are code- and test-complete but **not yet re-observed from a live desktop seat** — `mcp_call get_settings` in *this* session returns `MCP error -32603: MCP tool invocation did not complete` while `curl` to `/mcp` answers 401 as expected, and the session's tool surface is stale (pre-edit descriptions), so the block is the client binding here, not the server. Findings 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 14–19, 21–25 remain unfixed, as do #18, #21, #22, #24, #26, #28, #30, #32. Payment work (#29) is deferred by the owner pending a gateway decision.

## FIX INCREMENT 2 (same day) — desktop findings 6 and 7: the guide's locks are now real

**Finding 7 (paid capability live while its flag is off):** `run_batch`, `batch_status`, `resume_batch`,
`export_batch_results` now declare `featureFlag: "batch_mode"`, so `api/mcp/server.ts:151` hides them
from `tools/list` **and** refuses `tools/call` as an unknown tool while the flag is off — the same
enforcement `api/routers/swarm.ts` already applied to all six web entry points. `batch_mode` defaults
OFF (`api/plugins/featureFlags.ts:108`), so 1–100 paid pipeline runs are no longer reachable from chat
by a rollout-restricted account.

**Finding 6 (four live tools invisible in the guide) and its root cause:** the guide filtered these
four out on `flag: "batch_mode"` while the tool objects carried no flag, and `registry.test.ts` could
not see it because it only pinned *names* both ways, never the flag. The pin is now symmetric: "a flag
the guide shows as locked is a flag the server actually enforces" fails for any help entry whose
`flag` is not the registered tool's `featureFlag`. **It caught a second instance on its first run**,
in code written minutes earlier: `preview_external_evidence` was advertised as gated while
`report_external_evidence` was the only half that actually was — fixed by gating the preview on
`v2Publication` too, since a consent preview for a forbidden publication is a dead end. Reads
(`get_`/`list_external_evidence`) and `withdraw_external_evidence` stay deliberately ungated: content
already public must remain readable and retractable after a rollback.

Gates: 102 MCP tests pass (7 files), `npm run check` ✅, wiki regenerated (74 tools, 83174 bytes).

## FIX INCREMENT 3 (same day) — desktop findings 1 and 2: cost that cannot be misread, and a poll that fits on a screen

**Finding 1 (`$0.00000000` for "unknown"):** the ledger now counts
`pricedOperations`, and every dollar figure a user sees goes through
`costDisclosure()` in `api/services/benchmark/benchmarkLedger.ts`. `knownUsd` is
non-null **only** when every recorded operation is priced; otherwise it is
`null`, the partial sum appears as `pricedSoFarUsd`, and `display` says
"at least $X of N recorded operations is priced… this is a FLOOR and not the
total owed". One encoding of "not known" instead of two, and the source of the
price (`provider_list` / `price_vector`) is named in the sentence. The same
disclosure replaced the raw fields in the benchmark summary's `costObserved`
block, so a published manifest inherits it. 5 new pure tests, including
benchmark 5's exact 19-operations/0-priced shape.

**Finding 2 (no cheap way to ask "how is it going / what has it cost"):**
`benchmark_status` no longer returns the frozen plan's texts — it returns
`planRef` (counts, judges, rubric, planned calls, `planHash`) and the full plan
only when the caller passes `includePlan: true`, which is what
`preview_evidence` already prints verbatim. `list_benchmarks` gained what it
lacked: per-benchmark child progress (`completed/failed/pending/running`), the
best descriptive score under its own rubric, and the cost disclosure — three
grouped queries regardless of page size, in `listBenchmarkSummaries()`.
`benchmark_status` also stopped trusting `benchmarks.total_observed_cost`,
which is only written at finalisation: it reads the live ledger, so a running
benchmark now reports what it has already spent instead of `null`/stale zero.

Gates: `npm run check` ✅ · 455 tests pass, 4 failures = the documented
`providerThrottle` baseline only · wiki regenerated (74 tools).

## D9 FINDINGS LEDGER as of 2026-09-22 20:30 (what a re-test should and should not re-check)

| # | Finding | State |
|---|---|---|
| 1 | unknown cost prints `$0.00000000` | **FIXED** — `costDisclosure()`, 5 unit tests |
| 2 | no cheap progress+cost poll; status drags the whole plan | **FIXED** — `planRef` + `includePlan`, list carries progress/cost/score |
| 3 | `compare_models` actuals never price (19/19 NULL, judge rows too) | **OPEN** — cause still unexplained for the judgment rows; see the pass notes. Blocks trusting any compare_models cost |
| 4 | `withholdInputs` does not withhold what rationales recite; consent screen buries the hash | **PARTLY** — consent preview now renders losslessly first; the rationale-leakage half is OPEN and needs a redaction rule |
| 5 | a model can grade itself, approvable and publishable, no warning | **IN FLIGHT** — task #24 (D12 vendor-disjoint panel) is the structural fix |
| 6 | 4 live tools invisible in the guide | **FIXED** — flag parity pinned in both directions |
| 7 | those tools ignore the flag that hides them | **FIXED** — `batch_mode` now enforced by `server.ts` |
| 8 | `planHash` echoed by only one of three calls | OPEN |
| 9 | a replayed `start_benchmark` replies exactly like a real start | OPEN |
| 10 | quote warning contradicts its fixed 300-token judging assumption | OPEN (calibration belongs to P4; the sentence/figure mismatch does not) |
| 11 | sub-cent per-1K rates render as `0.0001` | OPEN |
| 12 | publish dead-ends into "save a template in Project Settings"; no MCP tool makes a template | OPEN |
| 13 | community publication reply confirms nothing and is unaddressable | **FIXED** — reply names the id to read back and to withdraw; reads by `publicationId`/`manifestHash` landed with #20 |
| 14 | §7.3 refusal is the house style; two replies are outliers | addressed with 13/15/16; the tier refusal outlier is being removed by #28 |
| 15 | `get_listing_status` invents a review stage | **FIXED** — says "not yet in review" + a `next` line |
| 16 | `listing_publication_state` cannot tell "not yet" from "legacy" | **FIXED** — `stage`, and `null` ≠ revision 0 |
| 17 | same stored object in two shapes (numbers vs strings, duplicate anchors) | OPEN |
| 18 | `attempts[]` mixes `case-1/...` refs with untraceable `judgment#9` | OPEN |
| 19 | `resume_benchmark` refusals mislead; a resume quote re-forecasts the whole plan | OPEN |
| 20 | auto-design unreachable for the named test account; two entry points refuse differently | **SUPERSEDED by #28** — the ladder is going away, so the gate itself is being deleted |
| 21 | `benchmark_status` `runs.failed:0` beside `perCandidate[0].runs.failed:1` | OPEN |
| 22 | `aggregateAvailability` described as "evidence availability" | OPEN (renderer now labels it; wording in the list tool improved with #2) |
| 23 | `model_retest_suggestions` returns a bare `[]` with no reason | OPEN |
| 24 | a resume's `state:"queued"` proved nothing about execution (child never ran) | **OPEN and unrepaired** — the worker half was never diagnosed. Any benchmark 5-style `queued` row is still sitting in the local DB |
| 25 | capability gates are per-tool memory, not structure; the publish gate advertised is not enforced | **IN FLIGHT** — #28 deletes the ladder; #32 owns the real publish gate (original-creator lineage) |

Plus the two pass-blocking usability items from the fix list: **F3 fixed** (provider-verified
default), **F4 fixed** (readable results). Neither has been re-observed from a real chat seat —
see FIX INCREMENT 1's note on this session's `-32603` MCP binding.

## D14 groundwork (#30) — measured, not assumed (2026-09-22, read-only local DB)

The delivery bundle is small enough to be ONE response, so `deliver_work_data` does not need
pagination or a streaming job. Sizeable private content in the local `swarm` DB today:
`agent_responses.content` 57 rows / **116 KB** (the bulk of it), `swarm_runs.run_params`
24 / 14 KB, `swarm_runs.user_prompt` 24 / 12 KB, `benchmark_judgments` rationales 28 / 13 KB,
`benchmark_cases.input_text` 18 / 9 KB, `pipeline_versions.definition` 6 / 7 KB, against
3 projects and 1 evidence publication. So the device-primary list in D14 is ~180 KB per
account and the never-swept list (versions, manifests, purchases, ledger, consent) is the
small remainder — which is the argument for keeping the verifiable records server-side and
making only the bulk content sweepable. Two design consequences: a sweep must key off
`agent_responses` + the two `swarm_runs` columns + the case/judgment text, and MUST NOT
touch `pipeline_versions`, `evidence_publications`, `marketplace_purchases`,
`execution_grants`, `call_attempts`, `spend_approvals`, or consent/withdrawal columns;
and because a protected buyer run stores its input in `swarm_runs.user_prompt`, sweeping a
buyer's copy cannot be offered while that run's evidence still matters to the seller.

## LOCAL DB STATE before the D13 removals (2026-09-22, read-only `information_schema` + counts)

Migrations 028/029/030 are confirmed applied in the local `swarm` DB by column and
constraint, not by memory: `call_attempts.cost_basis`/`cost_pricing_as_of`;
`marketplace_purchases.workflow_version_id`/`evidence_publication_id` with
`fk_purchase_workflow_version` + `fk_purchase_evidence_publication`;
`external_evidence_reports.publication_state` (`enum('draft','published','withdrawn')`
NOT NULL) + `consent_version`/`preview_hash`/`published_at`/`withdrawn_at` +
`fk_external_reports_workflow_version`.
Row counts: 7 benchmarks, 23 runs, 28 judgments, 52 ledger attempts, 1 evidence
publication, **0 purchases, 0 external reports, 0 teams, 0 team_seats, 0
subscriptions, 0 entitlements**. So #26/#28 cannot destroy any local
team/subscription row — there are none — and because the rule is "stop reading the
columns, never drop them", the same change is non-destructive against a production
database that may hold rows this session is not allowed to inspect.

## D12 + D13 backend increment (2026-09-22/23)

Two workstreams landed together because they share files (`benchmarkTools.ts`,
`helpContent.ts`, `settings.ts`, the generated wiki). Both are the owner's
decisions of 2026-09-22: **D12** the vendor-disjoint evidence panel, **D13**
one flat subscription — no team features, no tier ladder.

**D12 — a self-graded benchmark can no longer be published as evidence (closes finding 5).**
`api/services/benchmark/judgePanel.ts` is the single source of the rule and its
refusal text: exactly 3 judges from 3 different model **developers**, each on a
different prompt variant (9 ratings per output), and no judge sharing a
developer with any model that generated anything in the plan. Vendor comes from
the admin-reviewed catalog's new `vendor` column (**migration 031**, one nullable
`ADD COLUMN`, applied to the local `swarm` DB), never from `llm_providers` — one
Together key serves many developers. Unknown vendor is disjoint from *nothing*:
it can fill no slot and raises no collision. The gate is **wired structurally**
at draft creation (`benchmarkService.ts:208`), at quote/approve/start as a
`blockingError` (`:533`), and again at publication (`evidenceService.ts:186`) —
not remembered per tool, which was finding 25's failure mode. A private
evaluation may still run any panel; it simply cannot become evidence, and the
reply says so. Variants are hash-committed (`planHash`) and version-stamped
(`judge-v1:<variant>`), while a plan with no declared variants reproduces the
**pre-D12 prompt byte-for-byte** under `judge-v1`, so existing judgments stay
comparable — pinned literally in `judgeService.test.ts`.
`ICC(3,1)/ICC(3,k)` (two-way mixed, absolute agreement) report nulls naming the
degenerate condition. **The delegate's ICC(3,1) denominator was wrong**
(`k·MSres` where the variance-components algebra gives `(k−1)·MSres`),
understating reliability (0.894199 vs 0.922631 on the pinned 5×3 matrix); caught
by re-deriving it from `sa/(sa+sb+se)`, fixed, and
`judgePanelIcc.test.ts` now pins the statistic against its own definition rather
than a sentence-count proxy.

**D13 — the ladder and the team arm are gone from the code; the data is not touched.**
`TIER_CAPABILITIES`/`PLAN_CAPABILITIES` deleted; `can()` and
`resolveCapabilities()` now read **explicit grant rows only**, which is what
purchases and reviewer grants are made of, so no bought right changed hands.
The four real gates (IF/WHILE steps ×2, `design_pipeline`, `start_design_job`)
are removed — removing a paid gate makes accounts more able, never less.
`upgrade_tier` and the 8 `team_*` tools, the `team` router, `sharedMemory`, the
team fixtures and the TeamSync smoke script are deleted; the checkout surface is
`solo`-only. **Nothing was dropped from the database**: `teams`, `team_members`,
`team_projects`, `team_seats`, the nullable `teamId` columns and the
`users.tier`/`vouchers.tier` enums all remain, unread. `a12Leakage` gained the
proof that matters: with the old membership rows still present, a former
teammate is now told the run is **not visible to this account** — the removal
fails closed rather than leaking through a stale join.
`entitlements.test.ts` no longer pins matrices that don't exist; it pins the
`pipeline:run:<listingId>` string format instead, because that string is written
into rows that already exist. `voucher` redemption still writes a legacy tier
value nothing reads — **open owner question**: what a purchased voucher buys
under one flat subscription. Registered MCP tools: 74 → **65** (−8 team, −1
upgrade), wiki regenerated from the live registry.

Gates: `npm test` 474 pass / 4 fail = the documented `providerThrottle` baseline
only; `npx tsc -b` clean outside `src/` (the frontend half of D13 lands
separately); `node --check` on the wiki generator.

## D13 CLOSED (2026-09-22, `c6fe3c6`) — the screen half, and what a browser caught that grep did not

Frontend: `TeamDashboard`/`TeamConnect`, both routes, the nav section and the `teamsync`
namespace deleted from **both** locales; `useCapabilities` deleted rather than hollowed
out (every consumer used it only for `pipeline:custom`/`pipeline:autodesign`); tier
columns, per-tier stats, `setUserTier`, the dev tier-cycling mutations and every upgrade
CTA gone; `Pricing.tsx` rewritten to the truth (flat per-account subscription, 7-day
trial from signup, BYOK, no per-run fees) with the checkout control **disabled and
labelled** and a line saying the gateway is not connected. `npx tsc -b` 0 errors,
`npm run build` green, `node scripts/check-i18n.cjs` green, and `/pricing` was loaded in
the browser (no console errors, no Team entry in the nav).

Two things only the browser and a second read found, both now fixed:
1. **Live code still named a dead plan.** The ≤3-providers-per-pipeline limit — enforced
   for *every* account at `api/routers/pipeline.ts:147` and `api/routers/project.ts:322`,
   so a platform limit and never a paid gate — threw `"Pro Designer allows up to 3
   different LLMs per pipeline"`, and two comments promised tier-gated upgrades. The
   refusal now states the limit and the remedy; `grep` confirms no stale plan string is
   left in a live path, and no test had pinned the old wording.
2. **The pricing page advertises the 7-day trial and no code implements it.**
   `trialing` still comes only from Stripe, so this is deferred task #29, not a bug to
   patch quietly — recorded because the copy is currently a promise the code cannot keep.

**Still open after #26/#28 close:** the voucher generator needs an API change to stop
naming tiers (`api/routers/voucher.ts` still requires a `tier` value and
`voucher_redemptions` holds the history), so it stays as-is with a visible legacy notice;
and **what a purchased voucher grants under one flat subscription remains an owner
decision.**

## Watchdog status
The cron task `v2-phase-watchdog` is DISABLED (failure circuit, 3× `session-failed`) and its
executionScope cwd was `app 25` — the frozen prod folder — while its instructions target this
folder. That scope mismatch is the likely crash cause (the sandbox confines a session to its own
workspace). Do not re-enable it until its scope points at `/Users/youssefhariri/Documents/app25_v2`;
run phases interactively here meanwhile. Also note the inherited `" 2"` clutter copied in with the
baseline (`db/schema 2.ts`, `api/services/autoDesignService 2.ts`, `.git/refs/heads/main 2`, some
`dist/public/assets/* 2.js`): unreferenced junk that predates P0, but do not delete without an owner
decision — move aside instead.


---

## 2026-09-23 — #32 and #21 landed, and the suite's real baseline

**Committed (4, none pushed).**
- `1a5b979` findings 8/9/19 — `approve_benchmark_spend` echoes the planHash it
  bound, a `start_benchmark` replay now says `alreadyStarted/nothingNewStarted`
  instead of mimicking a real start, and `nothing_left_to_do` names the failed
  children and `retryFailed`.
- `d76e6b5` #32 — `pipeline_shares` (per-object grant between two accounts,
  `run_only`/`full`, `canModify`, revoke-by-state) + publish lineage enforced at
  all three boundaries (`publish_to_marketplace`, `marketplace.create`,
  `publishVersion`). No team/group construct, no plan or tier gate.
- `5780174` #21 — ten read-mostly `adminQuery` procedures and four AdminPanel
  tabs (endpoints, catalog+vendor, evidence, spend).
- `e0b6221` `fileParallelism: false`, with the reason.

**Three defects found in the #32 increment while gating it, all fixed there.**
1. **Migration 032 could never apply.** `pipeline_shares` had `AUTO_INCREMENT`
   with no key, so MySQL 8 refused it with error 1075 — the migration had
   silently never reached the local `swarm` database. The integration suite did
   not catch it because it builds its schema from `db/schema.ts` via
   `drizzle-kit push`, not from the SQL file. **Any future hand-written migration
   must be applied somewhere before it is called done.**
2. `pipelineShare.lineage` resolved any project/version id for any caller: an
   existence probe plus an owner disclosure, contradicting the header of the file
   it lives in. Now gated on the same access as the neighbouring `access`.
3. A `run_only` recipient could read which model each of the grantor's steps pins
   (`debug.getRunStats`, and the export projection kept every non-prompt column).
   `runAccess.withholdsModel` is now the single decision; `full` shares and
   marketplace buyer runs are deliberately unchanged.

**LOCAL DB STATE.** Migration 032 applied to local `swarm` (`pipeline_shares`
with PRIMARY KEY + 3 indexes; `projects.origin_creator_id`,
`pipeline_versions.origin_creator_id/origin_version_id`). Existing data
unchanged and verified after applying: 3 projects / 6 versions / 1 listing /
7 benchmarks / 2 users / 0 shares. `trusted_provider_endpoints` is still 0 rows,
so the desktop journey still stops at the egress gate until a human approves a
real destination. Next migration number: **033**.

**THE SUITE BASELINE IS NOT CLEAN, and it is not this branch's doing.** Full
serial `npm test`: 50 files, 490 passed, 1 skipped, **4 failed — all in
`api/lib/providerThrottle.test.ts`** (`currentRpm` 2000 where 120/60 expected).
Confirmed pre-existing by stashing the whole working tree and re-running at
`HEAD`: identical 4 failures. Tracked as a defect to fix on its own, not to be
worked around. `npm test` piping through `tail` hides the exit code — read the
summary, not the shell status.

**Second pre-existing hazard, found by the admin build and still OPEN.**
drizzle emits an *unqualified* column name when a `Column` is interpolated into
raw `sql`, so `(SELECT COUNT(*) … WHERE <inner>.fk = ${t.id})` binds `id` to the
INNER table and the subquery stops correlating: the count comes back as a
constant. The admin agent hit it, worked around it with grouped reads, and named
the same bug left in three older procedures — `listUsers.projectCount/runCount`,
`certificationQueue.poolTotal/poolCompleted`, `listWaitlist.position/
referralCount`. Those numbers are silently wrong today.

**Still open.** #22 (consented feedback attachments) and #30 (deliver-then-sweep)
both need migration 033 and are unblocked now that `db/schema.ts` is free. #21's
screens are not browser-verified: reaching them needs admin credentials and the
credential file is off-limits, so nothing was guessed. #23/#33/#34 need a live
retest from the owner's chat seat. #29 stays deferred with the payment gateway.

## Correction to the 2026-09-22 line "Still open after this increment"

That line (item `Still open after this increment:` above) listed findings 2–25 and
tasks #18, #21, #22, #24, #26, #28, #30, #32 as unfixed. It is stale as of
2026-09-23 and is kept only as a dated record. Current state, each verified in
this tree rather than recalled:

- Fixed and committed: **#18, #20, #24, #26, #28, #31** (earlier this cycle),
  **#32** `d76e6b5`, **#21** `5780174` (code, procedures and tests; the screens
  are still not browser-verified — no admin credentials, the credential file is
  off-limits), findings **8, 9, 19** `1a5b979`, **1, 2, 6, 7, 13, 15, 16** and
  the root cause of **24** (earlier commits).
- **F3 (#33) and F4 (#34)** are code- and test-complete (`settings.ts` 24 tests,
  `renderResult.ts` 33 tests, both green). What was never possible from inside
  this session is re-observing them from a live desktop seat, because in-session
  `mcp_call` returns `-32603` while the server itself answers. That block belongs
  to **#23**, and #23 is what remains open — not the fixes.
- Fixed on 2026-09-23 as their own increment: **#35** the four
  `providerThrottle` failures (`31c21b9`, tests were stale against a deliberate
  config change; two of them had been passing for the wrong reason), and **#36**
  the correlated-count pinhole in five admin fields (`99ffa9b`, `projectCount`
  came back `0` for a user with three projects before the fix, and the new
  fixture proves it fails against the old code).
- **In progress now, by two agents with disjoint file ownership:** #22
  consented feedback attachments (owns `db/schema.ts`, `feedback.ts`, `admin.ts`,
  `api/mcp/tools/*`, locales, migration 033) and #30's server half
  (owns `api/services/dataDelivery.ts`, `api/routers/dataDelivery.ts`, the
  `api/router.ts` mount line, and its own test — no schema change, no MCP tool
  in that increment). Neither is trusted until re-gated and committed here.
- Next free migration number is **034**.

## 2026-09-23 (later) — D14's server half, and the real cause inside finding 3

**Committed.** `4213cd7` is the server half of #30: `api/services/dataDelivery.ts`
+ `api/routers/dataDelivery.ts` (deliver / preview / sweep) + 6 DB-backed cases.
`b7022b1` fixes the explained half of desktop finding 3.

**Deliver-then-sweep, as built.** One bundle with a sha256 (stable across
unchanged data, so a client can tell it re-wrote the same bytes) and a signed
receipt; the sweep refuses without that receipt *and* the confirmation phrase,
then **re-derives** the bundle and compares hashes, so it cannot delete what the
user does not hold. Content is nulled, structure never: no `DELETE` anywhere, ids,
timestamps, token counts, cost rows, `model_used`/`provider_used` and every hash
survive, and the six D14-named server-authoritative tables are censused before
and after and reported in the receipt. `swarm_runs.run_params` is rewritten key by
key so the share/protection context `runAccess` enforces from is not lost. Buyer
runs and shared-in runs are refused outright rather than redacted-and-swept.

Two judgement calls the implementer surfaced, both accepted here as the right way
round but worth a human's eye:
- it clears `swarm_runs.execution_state` and `run_params.prompt`, which is what
  makes "swept" true, and the cost is that a swept run can no longer be resumed;
- it deliberately does **not** clear `run_params.attachments` (inlined file
  bytes) or a stored provider token, because the bundle carries no attachment
  bytes and rule 1 forbids sweeping what was not delivered. So attachment blobs
  survive a sweep — a gap in the promise, not an oversight.

**Finding 3, half 2 explained with data, not theory.** The same `(provider,
model)` pair is `provider_list` on six `call_attempts` rows and `NULL` on
thirteen. Only one mechanism produces that: `fetchProviderRates` cached the empty
result of an 8-second timeout or a thrown fetch under the same ten-minute TTL as
a good answer, so one slow host blinded every later quote and ledger row, and
`recordCallAttempt`'s `.catch()` hid it. A remembered miss now expires in 15s.
Half 1 (multi-model pipeline aggregates have no per-step breakdown to price
from) is untouched and tracked as **#37**.

**Suite state.** With #35 fixed, the whole serial tree is green for the first
time this cycle: 52 files, 511 passed, 1 skipped, 0 failed. Migration 033
(consented feedback attachments) applied to local `swarm`; data unchanged.

## 2026-09-23 (end of session) — what actually shipped, and what is still not true

Committed, in order, this goal: `d76e6b5` #32 sharing+lineage (with three defects
found while gating it: a migration that could never apply, an ungated lineage
read, and a `run_only` model leak) · `5780174` #21 admin operations ·
`e0b6221` serial suites · `b65db29`/`17ebe1a`/`f312a3c` docs · `1a5b979`
findings 8/9/19 · `31c21b9` #35 · `99ffa9b` #36 (five admin counts were
correlating against the wrong table — proven with `toSQL()`, and the new fixture
fails against the pre-fix code) · `b7022b1` + `8f4f856` both halves of finding 3 ·
`4213cd7` + `8b6ea1f` D14 server half and D11, with the D14 workbench tools ·
`c507943` two defects D11's own tests found in D11 (a `Date` collapsing to `{}`
inside every snapshot, and receipts written outside a transaction) · `6aa1e3e`
the attachment cap's two conflicting messages.

**Tree state: 54 files, 539 tests, 1 skipped, 0 failed.** Nothing pushed —
that still needs your written consent.

**What is NOT true yet, stated plainly.**
- #21's four admin tabs and D11's web opt-in control have never been seen in a
  browser. The UI files are written, they build, and their i18n pairs check out,
  but they are **deliberately uncommitted** because signing in needs your say-so.
- D14 has never run against a real folder from a real chat client (#23). The
  receipt/confirmation/hash-compare machinery is tested; "the user's device now
  holds it" is not.
- Two sweep decisions are yours to confirm: clearing `execution_state` and
  `run_params.prompt` costs resume-ability for a swept run, and inlined
  attachment bytes plus a stored provider token in `run_params` are NOT swept,
  because the bundle never carried them.
- A revoked `run_only`/`full` grantee can still attach the (redacted) view of a
  run they already have, because that read goes through `run_params` rather than
  re-reading the grant row. Entitlement is not widened, but "revocation is
  immediate" is a stronger promise than the code currently keeps.
- Open as tasks: #38 done, #39 (the MCP wiki still describes a retired
  tier-capability gate), #29 deferred with the payment gateway.
