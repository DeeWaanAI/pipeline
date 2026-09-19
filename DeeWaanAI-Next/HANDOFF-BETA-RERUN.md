# Handoff: re-run marketplace beta simulation (post certification-gate redesign)

You are continuing work on DeeWaanAI in `/Users/youssefhariri/Documents/app 25` (note the space — quote paths). Start by reading `DeeWaanAI-Next/PROGRESS.md` (sections "Trust Phase 0 — LIVE VERIFICATION" and the beta simulation entries).

## What just changed (deployed via push of commit cb03020, Railway auto-deploys)
- Certification gate redesigned: publish requires avg ≥ 3.5 AND ≥ 80% of reviews passing the 3.5 bar. Fleiss' kappa is now only a logged diagnostic (prevalence paradox made it unattainable — see PROGRESS.md).
- Review pool fairness: claim order is RAND() (was lowest-id-first, which starved listings); per-reviewer-per-listing cap = 3 completed reviews.

## Your task: verify the redesign live by re-running the beta simulation
1. Confirm the new deploy is live: `curl -s https://deewaanai-production.up.railway.app/api/health` (uptime should be small right after the push).
2. Use the guardrailed script `scripts/beta-simulation.mjs` (fully documented header). Run stages in order, each as a separate Bash call:
   - `REHEARSAL_DB_URL='<PROD_DB_URL>' node scripts/beta-simulation.mjs setup`
   - `... wait` (may need several 5-min calls)
   - `... review` (reviewer cap may need raising like last time; edit REVIEWS_PER_REVIEWER_CAP)
   - `... verify`
   - `... cleanup` (ALWAYS run cleanup, then verify DB is pristine: only listing 4 remains, no beta-% users, no stray providers/projects, listing 4 has 50 tasks and status certifying)
3. Expected NEW outcomes vs the previous run: good listings should now PUBLISH (previously all 4 rejected on kappa despite grades 4.13–4.87); reviews should spread across listings instead of draining one first; each listing should complete near 15 reviews instead of 25–43.
4. Update PROGRESS.md with the results and commit.

## Access facts (already on disk, gitignored — do not commit)
- Owner OAuth token with auto-refresh: `.deewaanai-test-token.json` (refresh token valid ~30 days from 2026-07-26; client: `scripts/mcp-call.mjs <tool> '<json>'`, `--list` to see tools).
- PROD_DB_URL: the owner must paste it again in chat (it is the Railway public MySQL proxy URL; used only for scoped verification queries and manifest-driven cleanup — never echo it into files).
- Real listing 4 "PR Review Companion" is LIVE in certifying — the script protects it (draft flip + restore); if anything crashes, re-run `cleanup` and verify listing 4 is certifying.

## Working agreements with the owner
- Pause (don't retry) when a Bash approval expires; owner says "go" when back.
- Never ask the owner to paste LLM API keys in chat. DB URL is the accepted exception.
- Keep replies concise; end with one bold next-step suggestion.
