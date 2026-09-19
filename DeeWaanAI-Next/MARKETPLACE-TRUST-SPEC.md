# Marketplace Trust & Certification — Implementation Spec (v2)

**Owner:** Marketplace / Platform team
**Status:** Ready to implement
**Supersedes:** v1 (platform-judge model). This version reflects the finalized design.
**Prereq reading:** `api/routers/marketplace.ts`, `api/services/aiEnsembleReviewService.ts`, `api/plugins/featureFlags.ts`, `db/schema.ts`, `api/lib/providers`, `api/services/cryptoService.ts`

---

## 1. The model (read this first)

Certification is split across three actors by **who can safely see what** and **who can safely be trusted**:

| Layer | Runs on | Sees | Role | Gates what |
|---|---|---|---|---|
| **Deterministic security scan** | our code (no LLM, free) | secret prompts + test I/O + title/desc | ungameable safety check | **visibility** |
| **AI triage** | **platform-controlled** model (managed `qwen3.6-flash`, §2) | test I/O only (never secret prompts) | advisory quality feedback + queue ranking | **nothing** (non-gating) |
| **Blind human review** | people | anonymized single test I/O pairs | quality certification | **buyability** |

Two hard rules that make this safe and cheap:

1. **The AI decides *nothing* about buyability.** It is triage + creator feedback only. Because it gates nothing, gaming it merely gets a listing to the human queue faster — where humans catch it. This is why it can run on cheap/free models without a trust problem.
2. **Never fail open.** Missing config, errors, low confidence, no reviewer quorum → the listing stays not-visible or not-buyable. Every fallback is closed.

### Listing lifecycle

```
draft
  └─(submit)→ [1] deterministic security scan ──fail──→ rejected (+findings)
                    │ pass
                    ▼
              [2] auto-generate test data (creator's keys — their own pipeline)
                    │
                    ▼
              [3] AI triage (platform model, non-gating) ──below floor──→ rejected (+feedback, creator revises)
                    │ above floor
                    ▼
              certifying   ← VISIBLE in marketplace, NOT buyable ("Certifying — help review this")
                    │
                    ▼
              [4] blind human review pool (per-prompt, anonymized) ──fail──→ rejected (+aggregate feedback)
                    │ pass (5×3, kappa > 0.60)
                    ▼
              published    ← BUYABLE, badged "Certified"
```

---

## 2. Model hosting (Alibaba Cloud Model Studio)

**Decision:** run **both** the AI triage (0.3) and the semantic security scan (1.3) on **Alibaba Cloud Model Studio** using **`qwen3.6-flash`** — the cheapest first-party Qwen tier, ample for coarse JSON scoring and security flagging. It is OpenAI-compatible, so it plugs into the `AI_TRIAGE_*` env vars with **no code change**.

**Config (International site, Singapore / `ap-southeast-1`):**
```
AI_TRIAGE_SLUG     = openai        # generic OpenAI-compatible adapter
AI_TRIAGE_MODEL    = qwen3.6-flash
AI_TRIAGE_BASE_URL = https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
AI_TRIAGE_API_KEY  = <Model Studio API key>   # from the Model Studio console
```
(`{WorkspaceId}` is part of the **hostname** on the international endpoint, not a path.)

**Ops:** managed = zero GPU ops. (Pricing is a business-side concern and intentionally kept out of this repo doc, since Alibaba's offers change.)

**Data handling (why sending secret prompts here is acceptable):**
- **Not used for training** + **AES-256** at rest/in transit (Model Studio privacy-notice); SOC 2 (Confidentiality).
- Content **is** processed by **automated moderation** and **stored / possibly transferred cross-border** (Product ToS §4.48(g)(iii) & (viii)); **no explicit retention window is published**.
- Acceptable because: (1) automated scanning ≠ disclosure — the terms grant no public access; (2) the prompts **already reach external LLM providers** as part of normal pipeline execution, so the scan adds **no new category of exposure**; (3) Alibaba's own abuse detection is a **bonus** safety net on top of ours.
- **Precision note:** a scan needs **plaintext** — no external model can read ciphertext — so the provider necessarily sees decrypted content during the call. AES-256 is their at-rest/in-transit protection, not end-to-end secrecy.

**Optional upgrade — self-host (only if IP-confidentiality becomes a creator-facing guarantee):** if you ever promise creators "your pipeline IP never touches a third party," host **Qwen3-8B** (open-weight) on **ECS `gn7i` (A10 24 GB) or PAI-EAS** inside your VPC and point `AI_TRIAGE_BASE_URL` at that endpoint. Same env vars, same code. The reason is **consistency with the promise**, not a technical risk in the managed path.

**Bonus (Phase 2.4):** Model Studio also offers **`text-embedding-v4`** + **`qwen3-rerank`** — use them for near-duplicate listing detection and marketplace semantic search without adding a vendor.

**Verify (business/ops side, not in this repo):** current `qwen3.6-flash` pricing + free-quota; confirm the account is on the **International** site, region **`ap-southeast-1`**.

---

# PHASE 0 — Do now (beta, ~100 testers)

Fully specified. No credits yet (free allowance). Establishes the whole flow on managed `qwen3.6-flash` (§2).

## 0.1 New listing status: `certifying`

**Where:** `db/schema.ts` `marketplaceListings.status` enum (L498).
**How:** add `"certifying"` to the enum (visible-but-not-buyable). Keep `"published"` meaning **buyable & human-certified**. Apply via `npm run db:push` (existing workflow).
**Acceptance:** enum migration applies; existing rows unaffected.

## 0.2 Deterministic security scan — the visibility gate (no LLM, free)

**Why:** the only ungameable safety check; must pass before a listing is ever visible.
**Where:** new `api/services/promptSecurityScan.ts`; called at the top of `submitForReview` (`marketplace.ts` L700).
**How:**
1. `scanListingSecurity(listingId): Promise<{ ok: boolean; findings: string[] }>` — pure functions, no network. Inputs to scan:
   - `encryptedPrompts` for the listing (decrypt in-memory via `cryptoService`; **never** log or return the plaintext),
   - all `testPrompts.inputText`,
   - `title`, `description`, `objectives`, `inputFormat`, `outputFormat`, `remarks`.
2. Checks (all in code):
   - **Unicode hygiene:** NFKC-normalize; flag zero-width chars (U+200B–200D, U+FEFF), bidi/RTL overrides (U+202A–202E, U+2066–2069), other C0/C1 control chars, and mixed-script/homoglyph runs.
   - **Injection payloads:** case-insensitive patterns — "ignore (previous|above) instructions", "disregard (all|prior)", "you are now", "system prompt".
   - **Exfiltration:** "send/POST/upload … to http(s)://", "email (this|the) to", outbound-URL + imperative verb.
   - **Secrets / abuse:** API-key-shaped strings, long base64 blobs (> 512 chars), obvious PII dumps.
3. Fail → set `status: "rejected"`, store findings in `aiFeedback` (reuse column) prefixed `[SECURITY]`, return early. Pass → continue.
**Acceptance:** unit tests for each class (zero-width, bidi override, injection phrase, exfil URL, base64 blob) → `ok:false`; a clean listing → `ok:true`. Plaintext prompts never appear in logs or API responses.

## 0.3 AI triage — platform model, non-gating

**Why:** protect human-reviewer time + give creators instant feedback, at ~$0.
**Where:** `api/lib/env.ts`, `api/services/aiEnsembleReviewService.ts`, `submitForReview`.
**How:**
1. Add platform triage config to `env.ts`:
   ```
   aiTriageSlug:    process.env.AI_TRIAGE_SLUG    ?? "",   // e.g. "openai" / "ollama"
   aiTriageApiKey:  process.env.AI_TRIAGE_API_KEY ?? "",
   aiTriageBaseUrl: process.env.AI_TRIAGE_BASE_URL?? "",   // set for self-hosted / free tier
   aiTriageModel:   process.env.AI_TRIAGE_MODEL   ?? "",
   ```
   `isAiTriageConfigured()` = slug && model set (key optional for self-hosted).
2. Add `runAiTriage(listingId): Promise<{ score: number; feedback: string } | null>`:
   - Build the adapter from **env** (`createProviderAdapter(env.aiTriageSlug, env.aiTriageApiKey, env.aiTriageBaseUrl, env.aiTriageModel)`) — **never** from `llmProviders`.
   - Send **test I/O only** (input + actualOutput) — **never** `encryptedPrompts` (IP stays on our side / off third-party free tiers).
   - Reuse the injection-safe prompt hygiene: sealed system message, untrusted content fenced as data, **compute the score in code** from the 6 dimensions (do not trust a model-returned `weightedScore`).
   - Returns `null` on any error/timeout.
3. Wire into `submitForReview` **after** security pass + test generation:
   - `null` (not configured or errored) → **skip triage**, go straight to `certifying` (non-gating: absence of AI never blocks). 
   - `score < AI_TRIAGE_FLOOR` (start 2.5/5) → `status: "rejected"`, feedback saved; creator revises & resubmits.
   - else → `status: "certifying"`; store `aiGrade`/`aiFeedback` for display + queue ranking.
4. **Retire the user-key ensemble path.** Delete the L893–936 auto-publish block (AI must never set `published`). `checkAiReviewProviders` (user's 3 providers) is no longer required for judging; keep the creator's own provider only for **test-data generation** (step [2]). Update comments at L714.
**Acceptance:** with triage env unset, a submission lands in `certifying` (never blocked); with it set, a low-scoring submission is `rejected` with feedback; AI never produces `published`; `encryptedPrompts` are never sent to the triage model (assert in a test via a spy/mock adapter).

## 0.4 Buyability guard

**Why:** `certifying` listings are visible but must not transact.
**Where:** the purchase/checkout mutation(s) in `marketplace.ts` (e.g. `createMarketplaceCheckoutSession` caller) and any "buy" tRPC/MCP path.
**How:** reject purchase unless `listing.status === "published"`. Return a clear error ("This pipeline is still being certified and cannot be purchased yet."). Browse/detail endpoints may show `certifying` listings with a badge + a "Become a reviewer" CTA (0.6).
**Acceptance:** attempting to buy a `certifying` listing fails; buying a `published` one works.

## 0.5 Blind, randomized, per-prompt human review pool — the buyability gate

**Why:** breaks collusion (can't rubber-stamp a creator you can't identify), removes bias, and limits IP leakage (one prompt at a time; reviewers never see `encryptedPrompts`).
**Where:** new `blind_review_tasks` table; new procedures in `marketplace.ts`; reuses `listingReviews`, `reviewerProfiles`, `calculateFleissKappa`.
**How:**
1. Schema `blind_review_tasks`:
   ```
   id, listingId (FK, SERVER-ONLY — never sent to client), promptIndex,
   reviewerId (FK users), status enum('assigned','completed','expired') default 'assigned',
   assignedAt, completedAt, unique(listingId, promptIndex, reviewerId)
   ```
2. When a listing enters `certifying`, enqueue its prompts into the pool (do **not** pre-assign to people).
3. `getNextReviewTask` (authed): pulls one unassigned (listing,prompt) for this reviewer, respecting:
   - **self-review ban:** exclude tasks whose `listing.creatorId === reviewerId` (enforced server-side via the hidden `listingId`),
   - **no clustering:** don't hand a reviewer another prompt from a listing they've already been assigned within the window,
   - reviewer must be `reviewerProfiles.status='active'`.
   Returns **only** `{ taskId, inputText, actualOutput, rubric }` — no listing id, title, creator, or category.
4. `submitReviewTask(taskId, scores)`: writes a `listingReviews` row (already per-`promptIndex`), marks the task completed, updates reviewer points/trust.
5. **Aggregate & certify:** when a listing has ≥ `MARKETPLACE_MIN_REVIEWERS` (default 5) distinct reviewers × `MARKETPLACE_MIN_REVIEWS_PER_REVIEWER` (default 3) each, compute weighted average + Fleiss' kappa. `avg ≥ 3.5 && kappa > 0.60` → `status: "published"` (buyable, "Certified"); else `status: "rejected"` with aggregate feedback. **Fail-closed:** no quorum → stays `certifying`.
**Acceptance:** a reviewer response never contains listing/creator identity; a creator is never served their own prompt; certification to `published` requires the 5×3 + kappa threshold; below-threshold → `rejected`.

## 0.6 "Become a reviewer" CTA + MCP tool

**Why:** recruit reviewer supply at the point of interest; unblock the queue.
**Where:** client listing-detail page; reuse the existing `enrollReviewer` MCP tool + `reviewerProfiles`.
**How:** on a `certifying` listing, show "Help certify this — become a reviewer" linking to reviewer enrollment. After enrollment, the user pulls tasks via `getNextReviewTask` (0.5) — which, being blind, will **not** hand them this specific listing's prompts preferentially (and never if they're the creator). Add/confirm an MCP tool option surfacing the same enrollment path.
**Acceptance:** CTA appears only on `certifying` listings; clicking enrolls a reviewer; enrollment does not let a user target a specific listing.

## 0.7 Feature flags

**Where:** `featureFlags.ts` `seedDefaultFlags()` L85.
**How:** add:
- `marketplace_ai_triage` (default **on**; when off or unconfigured, submissions skip triage → `certifying`).
Human certification is **always** required for buyability (it is the model, not a flag). The existing `MARKETPLACE_MIN_REVIEWERS` env (default 5) still governs the self-review ban and quorum; beta may set `=1` to self-certify while testing.
**Acceptance:** toggling `marketplace_ai_triage` off routes submissions straight to `certifying`.

## 0.8 Outcome logging (calibration)

**Where:** `db/schema.ts`, review + refund/report paths.
**How:** add `certifiedAt timestamp` (nullable) to `marketplace_listings`, set when a listing reaches `published`. Log `marketplace.certify.outcome` with scores. Later joined against refunds/reports to tune the AI floor and thresholds.
**Acceptance:** certified listings have `certifiedAt`; log line present.

## 0.9 Minor fixes (from prior audits)

- **(a) Dead code:** delete the duplicated ">50% failed → draft" block at `marketplace.ts` L875–891 (second copy unreachable).
- **(b) Hardcoded origin:** add `publicAppUrl: process.env.PUBLIC_APP_URL ?? "https://deewaanai-production.up.railway.app"` to `env.ts`; use it in `api/mcp/tools/upgradeTier.ts` L64; document `PUBLIC_APP_URL` in `.env.example`.
- **(c) Screenshot read scoping:** in `api/feedback-screenshot-route.ts` GET (L38–74), keep the signed-URL path; restrict the `x-local-auth-token` path to **admins** (403 otherwise). Owners already get server-pre-signed URLs.
- **(d) Screenshot rate limits:** add `RATE_LIMITS.screenshotUpload` (20/min per user) and `screenshotServe` (120/min per IP) in `rateLimiter.ts`; wrap both handlers with `checkRateLimitAsync` (serve keyed by `getClientIp`, honoring `env.trustedProxy`).

## Phase 0 gate checklist
`npm run check` clean · `npm run i18n:check` passes · new unit tests (0.2 each class, 0.3 non-gating + no-secret-leak, 0.5 blind + self-review ban + threshold, 0.9c/d) · `npm test` green · `npm run build` clean. Manual: security fail → rejected & invisible; triage low → rejected; triage pass → `certifying` (visible, not buyable); human 5×3+kappa → `published` (buyable).

---

# PHASE 1 — Hundreds

## 1.1 Prepaid credits fund AI triage (replaces the beta free allowance)

**Why:** at scale, platform-run AI has real cost; the creator (who wants to earn) should pay to certify. Charging also deters spam/gaming — each attempt costs money.
**Where:** existing `creatorDeposits` (`depositType: 'ai_test' | 'human_review'`) + `refundLedger`; new `creator_credits` balance table.
**How:**
1. `creator_credits`: `creatorId (unique)`, `balanceCents int`, `updatedAt`. Top-up via existing Stripe integration.
2. On submit: estimate triage token cost, **reserve** it as a `creatorDeposits` row (`ai_test`), deduct from balance; on success mark `completed`; on **platform-side failure refund** via `refundLedger` (fail-closed + fair).
3. **Free allowance:** first N submissions/creator run on the beta free/self-hosted model at no charge; beyond that, require balance. Show estimated cost before submit; block submit with a top-up prompt if balance insufficient.
**Acceptance:** triage cost is deducted per submission; platform failures refund; insufficient balance blocks submit with a top-up CTA.

## 1.2 Creator reputation + queue ranking

**Where:** new `creator_reputation` (`creatorId unique, listingsPublished, salesCount, refundCount, reportCount, takedownCount, trustLevel enum('new','established','trusted'), updatedAt`) + `api/services/creatorReputation.ts`.
**How:** recompute after each sale/refund/report/takedown. Use `trustLevel` + AI triage score to **rank the blind-review queue** (good work from proven creators surfaces first). Thresholds seeded from Phase 0 calibration data. Reputation does **not** bypass human review in this phase.
**Acceptance:** unit tests mapping inputs → trustLevel; queue order reflects rank.

## 1.3 Semantic security LLM pass (managed)

**Where:** `promptSecurityScan.ts` (extend); uses the same Model Studio `qwen3.6-flash` endpoint as triage (see §2).
**How:** after the deterministic scan, run `qwen3.6-flash` over the (secret) prompts to catch semantic attacks regex misses. Advisory: a flag routes the listing to a **mandatory human security check** rather than auto-rejecting. (Point the endpoint at a self-hosted model instead **only** under the §2 confidentiality-guarantee scenario.)
**Acceptance:** a semantically-injecting prompt that passes regex is flagged for human security review.

## 1.4 Certification levels

**Where:** `marketplace_listings` add `certificationLevel enum('certified','gold') default 'certified'`.
**How:** `certified` = passed blind human review (buyable). `gold` = additionally passed an extended human panel. Surface as a badge; buyers can filter; creators aspire to it.

---

# PHASE 2 — Thousands

- **2.1 Fast lane:** `trusted` creators (1.2) get lighter/expedited review; fraud effort concentrates on `new`/outliers, so cost/item falls as the population proves itself. Still human-gated, just prioritized.
- **2.2 Provisional exposure:** add `provisional` status — newly-`published` listings from `new` creators get capped visibility + "New" badge until they survive a probation window (e.g. 14 days / first M sales) with refund/report rates below threshold, then auto-promote.
- **2.3 Auto delist/re-review:** add `listing_reports` (`listingId, reporterId, reason, status, createdAt`) + a one-click Report button. A scheduled job (reuse the worker / `backup-cron` pattern) computes per-listing refund-rate (`marketplace_purchases.status='refunded'`) + report count; over threshold → `status:'unpublished'` (auto-suspend) + notify creator & admin. Fail-closed: suspend first, review after.
- **2.4 Sybil resistance:** Stripe Connect KYC for payouts (needed anyway) + per-creator submission rate limits + near-duplicate listing detection.
- **2.5 Honeypot prompts:** maintain platform-owned hold-out test prompts per category that creators never see; mix into the blind pool. A creator who overfits the visible tests fails the hidden ones.

---

# Environment variables (summary)

| Var | Phase | Purpose | Empty/default |
|---|---|---|---|
| `AI_TRIAGE_SLUG` / `AI_TRIAGE_MODEL` | 0 | Model Studio triage + security model (`openai` / `qwen3.6-flash`, §2) | unset → triage skipped (non-gating) |
| `AI_TRIAGE_API_KEY` / `AI_TRIAGE_BASE_URL` | 0 | Model Studio key / Singapore `compatible-mode/v1` endpoint (§2) | self-host may need only base URL |
| `PUBLIC_APP_URL` | 0 | public origin for links | Railway URL fallback |
| `MARKETPLACE_MIN_REVIEWERS` | (exists) | human quorum + self-review ban | 5 |
| `MARKETPLACE_MIN_REVIEWS_PER_REVIEWER` | (exists) | reviews per reviewer | 3 |

Feature flag (DB): `marketplace_ai_triage` — default **on**, non-gating.

# Rollout sequence

1. **Ship Phase 0** on managed `qwen3.6-flash` (§2) — or with triage off entirely, since it's non-gating. Deterministic scan + blind human review do the real work. Collect calibration data (`certifiedAt`, refunds, reports).
2. **Ship Phase 1** once you have enough labeled outcomes: turn on prepaid credits (creator-funded triage) + reputation-ranked queue + optional semantic security pass.
3. **Ship Phase 2** as volume approaches thousands.

# Invariants — never violate
- **AI never sets `published`/buyable.** Code (security) gates visibility; humans gate buyability.
- **Secret `encryptedPrompts` (IP) are never shown to human reviewers and never used for model training.** They may be sent only to the **platform-controlled security scanner** (managed `qwen3.6-flash` under the no-training/encrypted policy in §2, or a self-hosted model) — never to third-party free tiers, and never to the non-gating triage step. Humans see test I/O only.
- **Fail closed everywhere:** any error/missing-config/no-quorum keeps a listing not-visible or not-buyable.
- Keep the existing human path (5×3, self-review ban, kappa > 0.60) intact — it is the certification anchor.
