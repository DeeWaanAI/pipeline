# v3 Handoff — local-first MCP, hosted marketplace

Written 2026-10-12 at the end of the v2 line of work. **Start here.** Read this before exploring the
code; several things below look obvious in the source and are not, and two of them are already decided.

## What this folder is

`app25_v3` is `app25_v2` renamed, not rebuilt. `git remote` still points at `deewaanai-v2`, HEAD is
`09a942f`, working tree clean. Two other trees exist and neither is for editing:

| path | what it is |
|---|---|
| `~/Documents/app25_v2 copy` | the owner's deliberate v2 trace. **Read-only. Never write here.** |
| `~/Documents/app25_v2-inherited/` | two inherited `" 2"` files moved aside by owner decision (`20586bd`), byte-identical to blobs in `2e7be2d` / `3042b16`. Do not "restore" them. |

Project memory lives at `~/.qoder/projects/-Users-youssefhariri-Documents-app25-v3/memory/` — copied
from the v2 key, 10 notes, identical. If a session reports no project memory, that key name is wrong
(the underscore may not be sanitized the same way); the original still lives under `-app25-v2`.

## Before touching anything

```bash
docker compose -f docker-compose.v2.yml up -d   # mysql :3307, redis :6380
# kill whatever is still on :3000 — the old dev server was launched from a deleted path
npm run dev                                      # http://localhost:3000/mcp
```

Local `swarm` accounts: `p3-owner`, `p3-tester` (**userId 354**, the owner of benchmarks 1–8).

## Decided, not open

**The commercial model changed on 2026-10-12 and overrides everything older wherever they conflict:**

- **No monthly subscription.** The flat $9.99 plan is gone as a product decision. It already granted
  nothing in code — `syncSubscriptionEntitlements` returns early on an active subscription
  (`api/services/billingService.ts:197-212`) and `api/config/plans.ts:9-12` says a plan grants no
  capability — so removing it is copy and surface work, not a security change.
- **Users self-host** the MCP and everything except what a seller publishes for sale (pipeline, data, judging).
- **Only the marketplace stays hosted. Revenue is commission on sales.**
- **The MCP is free, deliberately, for adoption.** Not a giveaway to correct later.

Also already ruled: v2 does not need to remain sellable once v3 works.

## Proven, so don't re-investigate

- **Desktop OAuth works.** Loopback redirect URIs are accepted on *any* port since `8b7f0fd`
  (RFC 8252 §7.3) — the exact match that broke it is gone. Verified live with 76 tools connected.
- **`09a942f` fixed two archive/status defects and both were verified against the live server:**
  `benchmark_status` on a never-frozen plan answers `plannedCalls` null-with-reason instead of
  throwing, and `export_benchmark` writes a ledger-derived cost disclosure into `manifest.json`.
- **The archive mechanism is sound across completed / cancelled / failed.** `incomplete` names what
  the server no longer holds instead of shipping empty files. That is the property v3 depends on.

## What is actually unbuilt — verify before quoting any of it

1. **Nobody can be paid.** `PLATFORM_FEE_RATE = 0.30` is a module-private constant in
   `api/services/entitlementSync.ts:21`. `creatorEarnings` is a recorded number, never a transfer.
   `settlementEntries` / `payoutAttempts` exist as unwired scaffold, and the schema comment is explicit:
   *"a recorded earning is NOT a bank payout."* No Stripe Connect. `v2Commercial` is hard-off
   (`api/plugins/featureFlags.ts:118`). No Stripe keys in `.env`, by design.
   The UI already advertises "70% to creator, 30% to platform" (`src/pages/MarketplaceDetail.tsx`).
2. **Self-hosting and secrecy contradict each other for the same listing.** See the fork below.
3. **There is no stdio transport.** `/mcp` is streamable-HTTP + legacy SSE
   (`api/mcp/register.ts:144-151`); sessions are process-local, so multi-node needs sticky routing.
   A real local install still needs MySQL + Redis + the in-process worker — that weight, not price, is
   the adoption barrier.
4. **Protected execution has never run end-to-end.** `trusted_provider_endpoints` ships EMPTY, so
   `assertTrustedEgress` refuses. Any claim that a buyer run works is false until an operator approves
   an endpoint.
5. **`protectedEgress.ts` blocks loopback and private addresses by design** (`:64`, `:117`). A seller
   running their own model on their own network cannot serve a protected listing.
6. **Residual from v2:** `benchmark.json` inside an archive still carries the stale cached
   `costObserved` figure (frozen at finalisation, predating the FLOOR wording) while the corrected
   number sits in `manifest.json`. Decide: drop the cached summary from archives, or mark it stale in
   place. Do not leave both readable without a pointer between them.
7. **Purchased v2 graphs are never delivered** — `start_protected_run`'s contract is "run WITHOUT ever
   receiving its definition." Meanwhile `export_pipeline` emits plain unencrypted JSON for the caller's
   *own* pipelines. There is no copy-protection of a delivered graph, and `purchaseLicenses` /
   watermark tables exist unwired.

## The fork that must be answered first

A listing is one of two things, and the code can't pretend otherwise:

**Class A — sold as a copy.** The buyer receives the graph and runs it locally with their own keys.
Delivery *is* the product; no secrecy is offered; evidence must be bound to the exact version shipped,
and any edit the buyer makes silently voids that evidence — say so in the artifact.

**Class B — sold as access.** The graph never leaves. Today that means the platform runs it, which
needs approved endpoints and a server. If the *seller* hosts the runtime instead, the marketplace must
broker calls to the seller's own edge — the existing `relay/` compose stack plus
`relayTokens` / `relayRequests` are the pieces — and that edge has to verify a signed, time-boxed
execution grant. That verification component does not exist yet.

Answer alongside it:

- Does *"the gateway is built LAST"* still hold when commission is the only revenue? It now reads as
  contradictory: the rail that carries the money is the product, not the last mile.
- Who pays for judging and computational certification until payouts exist?
- Commission: flat 30%, configurable per seller, or lower at launch to win supply? The Pioneer
  "best terms" and "lifetime discounted creator commission" copy is currently unbacked by any code.

## What v2 hands you that v3 should keep

- **`export_benchmark` is the replayable-artifact primitive.** With execution on the user's machine,
  the platform can no longer *observe* runs — evidence becomes a signed archive anyone can re-verify.
  Hashes today prove **integrity only, not provenance**: nothing attests that DeeWaanAI issued it or
  which listing/version it belongs to. Signing the manifest hash (with listing, seller and
  workflow-version inside what's signed) is the v3 feature that makes the trust model real.
- **Trust model is evidence, not reviewers.** Keep the judging prompts publicly inspectable; don't
  describe blind human review as what makes a listing buyable.
- **The user's folder is the archive.** Local-first ownership is a stated position, not an accident.

## Rules of engagement

- Small verified increments. Fix before feature.
- Prove a bug exists before asserting it; re-derive every number handed to you, including check
  tallies — a count that can't be reconstructed from its own check list is the tell.
- Test the rendered surface, not the declarations. Dry-run `toSQL()`. Confirm a test fails pre-fix.
- Integration files run one at a time, each on its **own throwaway database** on `:3307`. Never sweep
  real rows. Additive migrations only; next number from `db/migrations/`.
- Baseline failures are 4 pre-existing `providerThrottle` ones; `rateLimiter.test.ts` is independently
  flaky — re-run alone before believing it.
- Scan the staged diff for secrets before every commit; check `behind=0` before pushing. Push verified
  increments without waiting. Force-push, remote branch deletion, deploys: ask first.
- **Never delete an untracked oddity.** Grep `V2-CHECKPOINT.md` and `FIX-PROGRESS.md` for the path
  first — this project has move-aside rules that outlive the files they name.
- No production, no payment work, no provider-sharing changes without an explicit ask.

## First task

Write the v3 architecture decision document that answers the fork above, naming the code paths each
option touches and what each one costs to enforce. **Do not start implementation until the owner picks
Class A, Class B, or a declared split.**
