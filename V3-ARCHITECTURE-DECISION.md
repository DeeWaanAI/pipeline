# V3 Architecture Decision — the fork, costed

**Status: DECISION REQUIRED. No code changed to produce this.**
Written 2026-10-13 against `09a942f` in `~/Documents/app25_v3`. Every claim carries a `file:line` I opened
myself; items I could not verify are named in §8. Per owner instruction, `HANDOFF-V3.md` is left
byte-identical and its inaccuracies are recorded here (§2) rather than in the source document.

**Read §7 and sign it. Nothing else in this file needs your attention before that.**

---

## 1. Verified live state (measured today, not inherited)

**Stack bring-up.** `docker compose -f docker-compose.v2.yml up -d` from this folder **fails and creates a
trap**: `container_name: v2-mysql` / `v2-redis` are hard-coded (`docker-compose.v2.yml:8,26`) and already
owned by compose project `app25_v2`, so the recreate collides — and on the way there it created
`app25_v3_v2-mysql-data`, an **empty** volume. The real database lives in `app25_v2_v2-mysql-data`
(verified by inspecting container `e43284ec93a7`). Bring-up that preserves data is `docker start v2-mysql
v2-redis`. Those two empty volumes and the `app25_v3_default` network now exist and are unused; I left
them alone.

**Database `swarm` (port 3307), read-only queries.** 88 tables. `users=2`, `benchmarks=8`,
`marketplace_listings=1`, `projects=3`. `id 354 = p3-tester`, confirming the handoff's account note.
`trusted_provider_endpoints = 0 rows`. `settlement_entries`, `payout_attempts`, `execution_grants`,
`relay_registrations`, `relay_requests`, `evidence_publications`, `pipeline_versions` all exist. **There is
no migration-tracking table at all** — applied-by-hand is the actual state machine.

**Server.** `npm run dev` is `vite` alone, serving `:3000` (PID 55696). `POST /mcp` with no credentials →
`401 application/json`, which is the healthy answer.

**Test baseline.** With the stack up, `npx vitest run --exclude '**/*.integration.test.ts'` →
**43 files passed, 1 skipped (`wikiDump`), 495 tests passed, 0 failed** in 50s. `providerThrottle.test.ts`
specifically is 13/13.

The handoff's "baseline failures are 4 pre-existing `providerThrottle` ones" **does not reproduce across the
non-integration files.** That is the limit of what I can claim: the older project memory records those 4 as
the expected result of a normal full-suite run, and I deliberately did not bulk-run the integration suite —
each file builds its own throwaway database on `:3307` and the files are documented to run serially, so
batch-running them to settle a citation is how real rows get swept. **If the 4 failures exist, they live in an
integration file, and that stays unverified.**

---

## 2. Corrections to `HANDOFF-V3.md`

Two of these were mine to correct too — I said in conversation that the endpoint-approval path "already
exists and works." It exists; it cannot approve what Class B needs it to approve (C4).

| # | Handoff says | Actual | Why it matters |
|---|---|---|---|
| C1 | item 7: `purchaseLicenses` / watermark tables "exist unwired" | **Neither exists.** Zero matches repo-wide. What exists: `marketplace_purchases` (`db/schema.ts:782`), `execution_grants` (`:2042`), `trial_grants` (`:2064`) | Copy-protection is at zero, not scaffolded. Any plan built on "wire the existing tables" builds on nothing. |
| C2 | item 7: `export_pipeline` emits plain JSON "for the caller's own pipelines" | It emitted **raw database rows** — `db.select().from(pipelineSteps)` plus the full `customAgents` row per step, including `id`, `projectId`, `userId`, `providerId` (`api/routers/export.ts:50-67`). `version: 1` was a **format tag**, not a workflow version. And its output was never accepted by this app's own importer, which writes only `customAgents` and `pipelineTemplates` (`export.ts:276+`). **Correction to my own first read:** I called `providerId` a credential leak against the seller. It is not — the export is ownership-checked (`export.ts:45-47`) and execution always re-resolves the credential from whoever runs it (`swarmService.ts:479-480`) | So the defect was portability and honesty of the format, not confidentiality: row ids in a shared file invite an import that can never work. Both fixed in §9; the missing round-trip and the missing version binding are what actually cost Class A work, not Docker weight. |
| C3 | item 3: a local install needs "MySQL + Redis + the in-process worker — that weight … is the adoption barrier" | **Redis is optional** — `api/infra/queue.ts:56` returns `"memory"` when unset, and falls back on connection failure (`:71`). **The worker is flag-gated** (`START_WORKER`). The blocker is elsewhere: the executor is DB-bound — `swarmService.ts` loads steps from `pipeline_steps WHERE project_id = ?`. Nothing anywhere executes a `pipeline_versions.definition` as a standalone artifact | Self-hosting is lighter than believed. What's missing is a definition→runnable-pipeline materializer. That changes Class A's cost estimate. |
| C4 | item 4: protected execution is false "until an operator approves an endpoint" | Approval exists (`api/routers/admin.ts:743-814`) — and it calls the **same** `normalizeEndpointUrl` (`admin.ts:766`) that structurally refuses loopback and private ranges, throwing `endpoint_refused` (`:768`); adapter mismatch is refused too (`:758-763`). `trusted_provider_endpoints` (`db/schema.ts:2282`) has **no column for network scope or trust path** | A seller's own-network model endpoint is **unapprovable by design**, not unconfigured. Class B needs a schema change or a policy reversal — this is the single most expensive line in §4B. |
| C5 | item 1: "nobody can be paid" | True, and more final: nobody can **buy** either. Purchase requires `store_relaunch` (`api/routers/marketplace.ts:2136`), which is absent from `seedDefaultFlags` (`api/plugins/featureFlags.ts:100-118`), and a missing flag evaluates false (`api/plugins/featureFlags.ts:76`). `settlement_entries`/`payout_attempts` have zero writers | The commission model is currently realized in **zero reachable lines**. Relevant to §5's gateway question. |
| C6 | item 1: "the UI already advertises it (`src/pages/MarketplaceDetail.tsx`)" | The string is an i18n key — `pages:marketplace.detail.revenueSplit`, `src/locales/en/pages.json:606` **and** `src/locales/zh/pages.json:606`, rendered at `MarketplaceDetail.tsx:310` | The fix is two locale files, not one component. Easy to "fix" one and ship the other. |
| C7 | "the read-only trace is `~/Documents/app25_v2 copy`" | That path does not exist. The trace is `~/Documents/app25_v2` — its own `.git`, same remote, same HEAD `09a942f`, clean | Two identical trees, one named rule. Owner has confirmed `app25_v3` is the edit target. |
| C8 | "project memory … 10 notes, identical" | The two memory directories are byte-identical (verified by `diff`). It is **9 notes + `MEMORY.md`** | Trivial, but the handoff's own rule says re-derive counts. |

Confirmed as written, no correction: subscription grants nothing (`api/services/billingService.ts:203-204`);
a plan grants no capability (`api/config/plans.ts:10-12`); `PLATFORM_FEE_RATE = 0.30` private at
`api/services/entitlementSync.ts:21`, one call site (`:94`); "a recorded earning is NOT a bank payout"
(`db/schema.ts:2101`); no stdio transport; loopback-on-any-port (`api/mcp/redirectUri.ts:20,40`);
`protectedEgress.ts:64,116-117` blocks private ranges; archive residual #6 is real — `benchmark.json`
carries cached `costObserved` (`api/services/benchmark/benchmarkService.ts:1399`) while the corrected FLOOR
text is manifest-only (`api/services/benchmark/benchmarkLedger.ts:418`), and the only pointer between them
is prose in a client instruction string (`benchmarkExport.ts:202`).

---

## 3. What is already strong, and does not depend on the fork

This is the good news the handoff did not know it had.

1. **Version identity exists.** `pipeline_versions.definitionHash = sha256(stableJson(definition))` —
   canonical, key-sorted, reproducible (`api/services/benchmark/versionService.ts:151-152`), written only by
   `createVersionRow` (`:144-149`), `ON DELETE RESTRICT` so a purchased version outlives its source project,
   with lineage columns (`originCreatorId`, `originVersionId`). **"`the exact version shipped`" is already an
   addressable thing.** Hash-as-identity is already used for dedupe (`api/services/pipelineSharing.ts:509`).
2. **The evidence manifest already contains provenance *content*.**
   `versionIdentity: { listingId, workflowVersionId, workflowVersionNumber, definitionHash,
   includesPrivateDefinition: false }` is written at `api/services/evidenceService.ts:448-456`, and
   `evidence_publications.manifest_hash varchar(64) NOT NULL` exists (`db/schema.ts:1963`).
3. **Canonical-JSON signing primitives exist** — `canonicalJson` (`api/services/auditExport.ts:508`), a
   `keyId`-tagged key resolution (`:521-529`), HMAC + `timingSafeEqual` verify (`:560`).

**The gap is precise and small:** every signature in this repo is *symmetric* — HMAC (`auditExport.ts:14`) and
`jose` pinned to `HS256` (`api/services/tokenService.ts:46`). `jose`'s JWKS code (`api/services/sso.ts:74,97`)
verifies *other people's* IdP tokens, not ours. There is **no `createSign`/`createVerify`/Ed25519 anywhere**,
and **no verification path** for an archive (zero matches for any `verify*Manifest`/`verify*Archive`;
`verifyLedgerSignature` is called only from its own test). A hash proves the file wasn't edited. A signature
proves **DeeWaanAI issued it**. That is the one thing the trust model needs, and it is fork-independent.

---

## 4. The fork — all three options, left open

### 4A. Class A — sold as a copy

The buyer receives the graph and runs it with their own keys. Delivery is the product.

| Work | Kind | Size | Evidence |
|---|---|---|---|
| Version-bound export: emit `definition` + `definitionHash` + `workflowVersionId` + `listingId` instead of raw rows | changed | S–M | `export.ts:50-67` |
| Strip internal row ids from the export payload | **DONE** (see §9) | XS | reshaped in `api/routers/export.ts`, proven by a delivery-then-export test |
| `definition → projects + pipeline_steps` materializer, verifying `definitionHash` on write | **new** | M–L | ~~no such path exists~~ → **BUILT 2026-10-13**: `api/services/pipelineDelivery.ts`, shipped in `d34f680` |
| Asymmetric signature over the manifest hash, payload `{listingId, sellerId, workflowVersionId, definitionHash, manifestHash, issuedAt}` | **new** | M | reuse `canonicalJson`/`keyId`; `versionIdentity` already carries 4 of 6 fields |
| Key management: algorithm, platform-vs-per-seller keys, public-key distribution, rotation, revocation | **policy decision** | M | nothing exists to inherit |
| `verify_evidence` tool/route so a buyer can check without our server | **new** | S–M | zero verification code today |
| Migration 036: `signature`, `signing_key_id`, `signed_at` on `evidence_publications`; delivered-hash receipt on `marketplace_purchases` | new | S | next free number is 036 |
| Void-on-edit disclosure: buyer's live hash vs the receipt hash, surfaced as `evidence_voided` | policy + copy | S | clone lineage already models this as data (`pipelineSharing.ts:791-837`) |
| Say plainly: "you receive the graph; no secrecy is offered" | copy | XS | listing + artifact |

**Cost: 3 new components, 1 migration, ~2 changed files.** The expensive one is the materializer, because it
is the thing that makes a copy *runnable* — today an exported graph runs nowhere, not even back in this app.
**What you can claim honestly:** signed, re-verifiable evidence bound to a hash, that dies visibly on edit.
**What you can never claim:** secrecy.

### 4B. Class B — sold as access (seller-hosted runtime)

The graph never leaves. The handoff's hope is that the relay already carries this. **The direction fits; the
semantics don't.**

The seam is real and narrow — everything from `api/services/marketplaceExecutionService.ts:294-304` (where
`loadVersionDefinition` turns the seller's graph into in-memory `ResolvedStep[]`) through the provider call in
`api/services/swarmService.ts:1430-1438` would be replaced by a remote execute. That part is well-bounded.

The relay is not:

- A relay token is one **static, admin-minted, unlimited-scope bearer** (`api/relay-route.ts:181-204`), SHA-256
  stored, shown once; `relay_registrations` has **no expiry**; `kind` is a free-form string and
  `relay/connector.mjs:125` handles exactly one value, `http_proxy`, rejecting everything else.
- No per-request idempotency or nonce; `resultJson` is overwritten with no status guard
  (`relay-route.ts:277-286`); a claimed request has **no lease and no timeout column**, so it never returns to
  `pending`. Payloads and results are stored **plaintext**.
- **No cloud-side client exists** that enqueues a protected run and awaits a `requestId` — `relay_requests` is
  referenced only by `relay-route.ts` and `api/boot.ts:200`.
- `enterprise_relay` is not seeded, so every relay route is currently `404` (§2 C5's mechanism).

And the grant the handoff correctly identifies as missing is missing **on both sides of the ledger**:
`execution_grants` is a plain row whose only expiry check is a SQL clock comparison
(`marketplaceExecutionService.ts:93`), no signature, no nonce — and **no production code ever inserts one**;
the only writers are `marketplaceExecution.integration.test.ts:240,285` and
`dataDelivery.integration.test.ts:283`. So grant *issuance* is unbuilt, not just grant *verification*.

**The blocker behind the blocker is C4.** A seller running their own model on their own network cannot be an
approved endpoint, and the table cannot even *express* "trusted only when reached through this seller's edge."
Resolving that means either a network-scope/trust-path schema plus new policy semantics, or abandoning the
claim that the platform controls egress — and `protectedEgress.ts:27-32` currently discloses exactly that
claim's limits to every caller, so a reversal rewrites the product's honesty text, not just its config.

Then the trust boundary inverts: `classifyProtectedError`/`getProtectedRunView`
(`marketplaceExecutionService.ts:320,339`) sanitize output the platform generated. With a seller edge, output
is **seller-supplied and untrusted**, and cost attribution (`swarmService.ts:519-522`) would rest on numbers
the seller claims.

**Cost: ~11 components, 2 migrations, new crypto, a result-trust spec, and a dependency on software no one
has evidenced existing** — there is no seller-hosted runtime or connector build in this repo for a protected
listing. Multi-node adds `api/mcp/transport.ts:46` (`const sessions = new Map<...>()`, process-local; the
header comment at `:18-22` already says sticky routing is required) if scale ever matters.

### 4C. Declared split

`delivery_class` chosen at publish; A's materializer+signature **and** B's grant+edge both must hold;
copy differs per class. Cost is A + B, plus the subtle one: **certification must state which class it
certifies**, or a listing's evidence becomes ambiguous between "this hash scored this" and "this access
endpoint scored this." Highest total cost, most product flexibility, and the only option that lets a seller
choose per listing.

### 4D. Side by side

| | Class A | Class B | Split |
|---|---|---|---|
| New components | 3 | ~11 | 14 |
| Migrations | 036 | 036 + 037 | both |
| Cryptography | asymmetric signing + verifier | grant signing + verification + replay ledger | both |
| Depends on a seller building infra | no | **yes, and it doesn't exist here** | for B listings |
| Contradicts existing egress policy | no | **yes** (C4) | partially |
| Secrecy you can honestly sell | none | real, bounded by `:27-32` | per class |
| Distance to a sellable listing | shortest | longest | medium |

---

## 5. The three questions the handoff says to answer alongside it

**"Does 'the gateway is built LAST' still hold when commission is the only revenue?"** No, and the code says
so. `fulfillMarketplacePurchase` books `platformFee = amountPaid * 0.30` and a `creatorEarnings` figure into
`marketplace_purchases` (`api/services/entitlementSync.ts:94-104`) with **no payout path** — settlement and
payout tables have zero writers. Under a subscription model the gateway was an add-on to recurring revenue;
under commission it **is** the revenue, so P3 (payout provider, hold, dispute window, tax/fee allocation —
`DeeWaanAI-Next/OFFERING-REDESIGN-TECH-SPECS.md:53`, whose own text reads "new paid-sales cutover is blocked")
is launch-critical rather than last. Answer: gateway last was correct for a product that no longer exists.

**"Who pays for judging and certification until payouts exist?"** Today it's split four ways:
- security scan — deterministic, **$0**, and it runs before any LLM call (`scanListingSecurity`,
  `api/routers/marketplace.ts:1178-1180`).
- test-data generation and trial runs — **the seller's own provider** (`api/routers/marketplace.ts:1196`).
- AI triage — **the platform**, via `AI_TRIAGE_API_KEY`/slug/base-url/model (`api/lib/env.ts:79-82`), flag
  seeded **enabled** (`api/plugins/featureFlags.ts:106`, read at `api/routers/marketplace.ts:1360`).
- the v2 evidence panel — **the user's own BYOK keys**; `platformLicenseCharge: null`
  (`api/services/evidenceService.ts:383`).

So the platform absorbs triage cost with zero revenue (§4/C5), and the reviewer incentive is **already broken
by the same decision that killed the plan**: `src/locales/en/pages.json:727` promises "Complete quality
reviews to earn subscription days. 5 reviews = 1 day." There is no longer a subscription to earn days on.
That line, plus `:666` and `:726`, needs an answer — paid, reworded, or removed.

**"Commission: flat 30, per-seller, or lower at launch?"** A decision, not a discovery — nothing reads a rate
except the private `0.30`. Per-seller or launch-introductory rates mean: a rate column (listing or seller), a
read at `entitlementSync.ts:94`, an admin surface (**none exists today**), and the rate snapshotted onto the
sale row — `db/schema.ts:2101-2102` snapshots basis/rate per sale "so history is immutable", which constrains
retroactive edits, not new-sale rates. So it's S/M work, not a config flag. And the marketing claims that
presuppose a mechanism — "Pioneer creators lock in lifetime best commission rate"
(`site/src/content/ui/en.json:72`, also `:106,:143,:199`) — are backed by nothing: promotions today are
subscription free-days only, and the migration says so out loud ("**It does not discount anything**",
`db/migrations/035_promotions.sql:4-9`; `api/services/promotionService.ts:4-7`). Killing the subscription orphans
the entire promotion mechanism, since a grant attaches to a checkout that no longer exists.

---

## 6. Fork-independent work

Each is one small verified increment and none requires §7 answered.

1. **Sign the manifest, publish a verifier.** Provenance, not just integrity. Highest value per line in this
   document (§3), needed by A and B alike.
2. **Archive residual (handoff item 6).** Decide: drop cached `costObserved` from `benchmark.json`, or mark it
   stale in place with a pointer to `manifest.cost.display`. Testing means reading the emitted archive bytes,
   not the declarations.
3. ~~Strip internal identifiers from `export_pipeline` output~~ **DONE 2026-10-13** — and it was never the
   leak I called it (C2, §9).
4. **Correct claims the commercial decision already broke:** `revenueSplit` (2 locales), the reviewer
   "subscription days" promise, `$9.99` at `site/src/content/ui/en.json:91,104,195`, and the Pioneer commission
   lines. Removing the plan is copy-and-surface work — but the revoke arm at `billingService.ts:206-211` stays,
   it is the only cleanup for historical `source="subscription"` entitlement rows, and `…TECH-SPECS.md:382`
   forbids repricing existing subscribers without an approved migration policy.

---

## 7. Sign this

| Question | Your answer |
|---|---|
| Fork | **CLASS A — sold as a copy. Chosen by the owner on 2026-10-13.** Class B and the declared split are off the table for now, so `delivery_class` is not built: every listing is a copy. |
| Commission | Flat 30% ☐  Per-seller column ☐  Lower at launch, then rise ☐ |
| Gateway ordering | Accept that P3/payout is now launch-critical, i.e. first ☐  Keep it last, and sell nothing until it's built ☐ |
| Triage cost | Platform keeps paying it ☐  Seller-funded ☐  Disabled until paid ☐ |
| Reviewer incentive | Paid ☐  Reworded (no subscription days) ☐  Removed ☐ |
| Pioneer "lifetime best commission" | Build the mechanism ☐  Delete the claim ☐ |
| Fork-independent work (§6) | Do all four ☐  Only 1–2 ☐  Hold until the fork is settled ☐ |

## 8. What I could not determine from code

- **Which listing table is the live sale path.** `marketplace_listings` and a separate `encrypted_prompts`
  table (`db/schema.ts:825`) coexist with `marketplace_listing_v2` (`:2232`). I found no code that wires a
  *buyer copy* to a *purchase* — which suggests Class A delivery is unbuilt rather than hidden, but that's an
  inference from absence.
- Whether `swarmQueue.enqueue` is durable across a restart.
- Whether any real seller today has a hosted runtime and connector. (None in this repo.)
- Runtime `feature_flags` rows in any deployed database — I read seeds and the local container only, so
  "`store_relaunch` is off" is proven for *fresh* installs, not for production.
- Whether the handoff's 4 `providerThrottle` failures exist in an integration file (§1), and whether
  `rateLimiter.test.ts` is really flaky: it passed inside the 495-test batch run, which is one observation,
  not a refutation of a flake.

---

## 9. Status after the decision (2026-10-13)

**Class A chosen.** Two increments shipped and verified:

| What | Commit | Proof |
|---|---|---|
| `api/services/pipelineDelivery.ts` — the materializer. Entitlement through `resolveProtectedExecutionRight` (the same authority a protected run consults), the certified definition written as a project the buyer owns plus steps, template and a first immutable version, the seller's `providerId`/`agentId` deliberately dropped, and `definitionHash` recomputed over what is about to be written and refused on mismatch | `d34f680` | 7 DB-backed cases in its own throwaway schema; **mutation-tested** — nulling the provider guard and bypassing the hash check each fail exactly the case that covers them, while all four entitlement refusals still pass |
| `deliver_purchased_copy` (MCP) + `marketplace.deliverCopy` (tRPC) | `b35c253` | presence verified against the live `TOOLS` array at runtime, not against the source file; `tsc -b` clean; unit suite unchanged at 495 passed / 0 failed |

**No migration was needed**, so §4A's migration row is dead: `marketplace_purchases.workflow_version_id`
(migration 029) plus the immutable `pipeline_versions.definitionHash` already record what a buyer is entitled
to and which hash that names. A column would copy a fact that cannot change.

**One behavior deserves your eye.** A purchase receipted *before* migration 029 names no version, so delivery
resolves to the listing's **current** version — possibly a build newer than the one money changed hands for.
It is allowed (stranding pre-migration buyers is worse than telling the truth about it) and it is disclosed in
`versionBinding: "legacy_current"` plus the `meaning` string the buyer keeps, with a test that proves the
disclosure happens. Refusing instead is a one-line change if you prefer strictness.

**Still open, untouched by this increment:** the other five rows of §7 — commission shape, gateway ordering,
triage funding, the reviewer "subscription days" promise (`src/locales/en/pages.json:727`, and its MCP mirror
at `api/mcp/tools/helpContent.ts:284`, along with `my_purchases` still offering "subscription status" at
`:274`), the Pioneer claim. Plus the two §6 items: signing the manifest, and
the archive `costObserved` residual.

**Export payload reshaped (was §6 item 3), and my earlier characterization was wrong.** I wrote that
`export_pipeline` leaked `providerId` "pointing at the seller's key rows". It does not: ownership is enforced
on the export itself (`export.ts:45-47`, and `DeeWaanAI-Next/PROGRESS.md:174` records that a *missing*
ownership check there was fixed before the MCP tools shipped), and execution re-resolves every credential from
the account that runs it (`api/services/swarmService.ts:479-480`), so a foreign id could never be honoured.
The real defect was that a portable file carried database row ids which mean nothing outside the exporter's
own account, and a `version: 1` tag that read like a workflow version when it was a format marker. Now:
`format: 2`, no `id`/`projectId`/`userId`/`agentId`/`providerId`, and a `note` saying plainly that this is a
live snapshot and not a certified version. Proven by a test that delivers a copy and exports it, asserting the
prompts are present and every one of those keys is absent. The seller-leakage battery
(`a12Leakage.integration.test.ts`) still passes 10/10. Round-trip is still not claimed — the app's importer
accepts agents and templates, never steps.
