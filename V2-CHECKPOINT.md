# V2 PROGRESS CHECKPOINT — autonomous continuation point

**Updated:** 2026-09-19 22:57 (+03:00)
**Purpose:** if the implementing session or laptop dies, ANY new session resumes from this file + the plan doc. Do not restart completed work.

## Read first (in order)
1. `DeeWaanAI-Next/OFFERING-REDESIGN-V2-IMPLEMENTATION-PLAN.md` — phases, gates, decisions D-a/b/c/e
2. `DeeWaanAI-Next/OFFERING-REDESIGN-TECH-SPECS.md` — governing spec (v2.0); §1.3 open policies P1–P7 are owner-gated
3. `DeeWaanAI-Next/G0-INVENTORY.md` — baseline facts
4. `git log --oneline -15` — source of truth for what is DONE (checkpoint text may lag by one commit)

## Status
| Phase | State |
|---|---|
| P0 baseline | ✅ done (tag `v2-baseline`, repo `github.com/youssef-hariri/deewaanai-v2`) |
| P1 additive foundations | ✅ done + pushed |
| P2a durable design jobs | ✅ done + pushed (commit `2e7be2d`) |
| P2b benchmark engine | ▶️ in progress — see "current step" below |
| P3 evidence + protected exec | pending (unblocked) |
| P5 frontend | pending (unblocked; contracts frozen in `contracts/offeringV2.ts`) |
| P6/W6 rehearsal + verification | local prep unblocked; Railway service creation + ANY domain/production action = OWNER GO ONLY |
| P4 commercial | BLOCKED by spec: owner must resolve policies P1–P7 (never invent defaults) |

## Hard rules (violating any = stop)
- Never modify `/Users/youssefhariri/Documents/app 25` (frozen prod copy). All work in `/Users/youssefhariri/Documents/app25_v2`.
- Never connect to production DB/Redis (`hopper/acela.proxy.rlwy.net`). Local stack only: `docker compose -f docker-compose.v2.yml` (`v2-mysql`:3307, `v2-redis`:6380). Integration tests use throwaway DB `swarm_v2test` and revoke ONLY their own grant.
- Never delete archives/backups/snapshots. Additive migrations only (next number: check `db/migrations/`, was 023).
- No pushes to the OLD repo, no Railway/DNS/domain mutations, no Stripe anything beyond test-mode config files.
- Before EVERY commit: security scan (staged file list, secret patterns in `git diff --cached`), then commit AND `git push origin main` immediately.
- After every phase: `npm run check` + `npm test` + `npm run build` + `npm run i18n:check`; baseline = 4 pre-existing `providerThrottle` failures ONLY.
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

## Update discipline
When finishing any increment: (1) commit+push, (2) tick the plan-doc checkboxes with evidence, (3) rewrite "current step" below, (4) when a phase completes set its row ✅ and the next ▶️. When ALL unblocked phases (P2b, P3, P5, P6-local) are done and verified, disable the cron task `v2-phase-watchdog` (qoder_cron remove/run list to find id) and write `V2-ALL-BLOCKED-PHASES-COMPLETE.md` with the acceptance-matrix summary.

## Current step
P2b — private evaluation benchmark engine. Start: read spec §4.1–4.2/§7/§9/§10; design `api/services/benchmarkService.ts` (draft→freeze plan+hash→quote→spendApprovals→coordinator fan-out reusing swarmService execution over `pipelineVersions` snapshots; `callAttempts` ledger replaces the P2a JSON bridge), `api/routers/benchmark.ts`, flag `v2Benchmarks`. Tests: A01, A02, A06, A08 (3×2×1×3=18 rubric vs 9 pairwise), A21 + descriptive-only summaries (no CIs/badges).
