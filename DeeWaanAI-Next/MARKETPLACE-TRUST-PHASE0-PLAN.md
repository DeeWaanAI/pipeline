# Marketplace Trust & Certification — Phase 0 Implementation Plan

> Derived from `MARKETPLACE-TRUST-SPEC.md` (v2, "Ready to implement"). Anchors verified against the tree on 2026-07-20. Scope: **Phase 0 only** — Phase 1/2 wait for the owner's explicit go (phase-gating rule).

## What Phase 0 is, in one paragraph

Insert two gates in front of the existing human certification path: (1) a deterministic, no-LLM security scan that gates **visibility**, and (2) a non-gating AI triage on a platform-controlled model (`qwen3.6-flash` via Alibaba Model Studio, OpenAI-compatible) that sees **test I/O only** and gives creators instant feedback. Add a `certifying` listing status (visible, not buyable), retire the user-key AI ensemble auto-publish path (AI must never set `published`), and convert human review into a **blind, randomized per-prompt pool** — reviewers never see listing/creator identity, creators never review themselves. Buyability stays human-gated at 5 reviewers × 3 reviews + Fleiss' kappa > 0.60 via the existing `submitReview` aggregation, which remains the certification anchor.

## Verified code anchors

| Spec claim | Reality (2026-07-20) |
|---|---|
| `submitForReview` ~L700 | L698 ✓ (calls `checkAiReviewProviders` L715) |
| Duplicated ">50% failed → draft" block L875–891 | L875 + L884 (two copies) ✓ |
| AI auto-publish block L893–936 | L923 `status: "published"` + log L930 ✓ |
| Kappa + human quorum | `calculateFleissKappa` L399; human `submitReview` auto-publish at L1936–1958 (5×3, kappa) — **keep intact** |
| Reviewer infra | `listingReviews` (schema L536), `reviewerProfiles` (L579), `enrollReviewer` MCP tool + ReviewerPortal enrollment ✓ |
| `aiEnsembleReviewService.ts` | exists; imports `calculateFleissKappa` from marketplace.ts (cross-worker import — do not move) |

## Worker split (disjoint file scopes)

### Worker A — services + env *(no router/UI files)*
- `api/services/promptSecurityScan.ts` **(new)** — `scanListingSecurity(listingId)`; NFKC/unicode hygiene (zero-width, bidi overrides, C0/C1, homoglyph runs), injection phrases, exfiltration patterns, API-key/base64/PII shapes. Pure functions, decrypts prompts in-memory, **never logs/returns plaintext**. Fail → `rejected` + findings into `aiFeedback` prefixed `[SECURITY]`.
- `api/services/aiEnsembleReviewService.ts` — add `runAiTriage(listingId)`; adapter built **from env only** (never `llmProviders`); test I/O only (never `encryptedPrompts`); sealed system message + fenced untrusted data; **score computed in code** from the 6 dimensions; returns `null` on any error.
- `api/lib/env.ts` — `AI_TRIAGE_SLUG/API_KEY/BASE_URL/MODEL` + `isAiTriageConfigured()`; `publicAppUrl` (`PUBLIC_APP_URL` w/ Railway fallback; covers spec 0.9b's env half).
- Tests: `promptSecurityScan.test.ts` (one case per attack class + clean pass), triage non-gating + **no-secret-leak test** (spy adapter asserts `encryptedPrompts` content never sent).
- `.env.example`, `README.md` env table.

### Worker B — schema + marketplace router *(no service/env files)*
- `db/schema.ts` — `marketplaceListings.status` += `"certifying"`; **new `blind_review_tasks`** (id, listingId FK server-only, promptIndex, reviewerId, status assigned/completed/expired, assignedAt, completedAt, unique(listingId,promptIndex,reviewerId)); `marketplace_listings.certifiedAt` (nullable). Migration via drizzle + apply to dev DB.
- `api/routers/marketplace.ts`:
  - `submitForReview`: security scan first (fail → rejected+findings, return) → test-data generation (unchanged, creator's keys) → triage (flag `marketplace_ai_triage` + configured; `null` → skip; `< 2.5` floor → rejected+feedback; else → `certifying` with `aiGrade`/`aiFeedback`).
  - **Delete** AI auto-publish block (L893–936) and dead duplicated ">50%" block (L875–891); update comment L714.
  - **Buyability guard:** purchase/checkout mutations reject unless `status === "published"` with a clear error.
  - **Blind pool:** on entering `certifying`, enqueue prompts (unassigned); `getNextReviewTask` (active reviewer, self-review ban via hidden listingId, no same-listing clustering; returns only `{taskId, inputText, actualOutput, rubric}`); `submitReviewTask` writes per-promptIndex `listingReviews` row, completes task, updates reviewer points/trust.
  - **Aggregate & certify:** ≥ `MARKETPLACE_MIN_REVIEWERS` distinct × `MARKETPLACE_MIN_REVIEWS_PER_REVIEWER` each → weighted avg + `calculateFleissKappa`; `avg ≥ 3.5 && kappa > 0.60` → `published` + `certifiedAt` + `marketplace.certify.outcome` log; else `rejected` w/ aggregate feedback; no quorum → stays `certifying` (fail-closed).
  - Flag: add `marketplace_ai_triage` (default on) to `seedDefaultFlags()` + DEPLOY.md seed SQL.
- Tests: blind-task identity-hiding, self-review ban, clustering ban, threshold/kappa outcomes, buyability guard.

### Worker C — frontend + i18n *(no api/ files except MCP tool registration if separated)*
- Listing-detail page: `certifying` badge ("Certifying"), disabled buy button w/ explanation, "Help certify this — become a reviewer" CTA → enrollment (spec 0.6).
- ReviewerPortal: blind-task flow UI (pull task → score → submit) using the new procedures — task payload has no listing identity by design.
- i18n: new keys en/zh in `src/i18n-languages.ts` + `src/locales/*` (parity CI-checked).

### Worker D — minor fixes (spec 0.9b/c/d)
- `api/mcp/tools/upgradeTier.ts` L64: use `env.publicAppUrl`.
- `api/feedback-screenshot-route.ts`: header-auth path → **admins only** (403 otherwise); signed-URL path unchanged.
- `api/lib/rateLimiter.ts`: `RATE_LIMITS.screenshotUpload` (20/min/user) + `screenshotServe` (120/min/IP via `getClientIp`, honors `trustedProxy`); wrap both handlers; tests.

## Cross-cutting requirements (from working agreements)

1. **Chat-first rule:** `getNextReviewTask` / `submitReviewTask` / reviewer enrollment must also be reachable as MCP tools (enrollment tool exists — `enrollReviewer`; add the two task tools), gated like their web counterparts.
2. **Execution order:** A ∥ B ∥ D in parallel (spec fixes all signatures); C can start against the defined procedure contracts, integrate after B lands. Sequence: workers → integration → gates.
3. **Gates:** `npm run check` → `npm run i18n:check` → `npm test` → `npm run build` → boot smoke `scripts/smoke-marketplace-trust.mjs` (security-fail → rejected+invisible; triage-off → straight to certifying; triage-low → rejected; certifying visible-but-not-buyable; blind task has no identity; creator never gets own prompt; 5×3+kappa → published; below-threshold → rejected). Flag `marketplace_ai_triage` reset per rollout-control policy (default on per spec — confirm with owner whether to ship it on).
4. **Docs:** update PROGRESS.md, ENGINEERING.md (new gates + blind-pool invariants), DEPLOY.md (new env vars + flag seed), README env table.
5. **Pre-push:** clean-clone build/boot sim (Railway parity), then commit/push (CI + auto-deploy).
6. **Invariants (never violate):** AI never sets `published`; secret prompts only to the platform security scanner, never to triage/humans/free tiers; fail closed everywhere; keep the 5×3/kappa human path intact.

## Out of scope this phase

Phase 1 (prepaid credits, creator reputation/queue ranking, semantic LLM security pass, certification levels) and Phase 2 (fast lane, provisional status, auto-delist, Sybil resistance, honeypots) — gated on owner approval + Phase 0 calibration data (`certifiedAt` ↔ refunds/reports).

## Ops note (owner, not code)

Model Studio setup (International site, `ap-southeast-1`, API key, verify current `qwen3.6-flash` pricing/quota) is a console task. Phase 0 ships fine without it — triage is non-gating and skips cleanly when unconfigured.
