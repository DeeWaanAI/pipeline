# Batch E — Live-Site Fixes + Batch D Close-Out

Source: live verification of https://deewaanai.com after domain cutover (2026-07-14).
E1 is a beta-blocker (testers cannot connect following the docs). E3 closes Batch D,
which is still incomplete and entirely uncommitted.

---

## Fix E1 — BLOCKER: docs quickstart prints the wrong MCP connect URL

**Symptom (live):** /docs quickstart and troubleshooting render the MCP URL as
`https://deewaanai.com/mcp` — that is the static marketing site (Caddy), not the app.
Anyone following the manual fails at step 1.

**Cause:** `APP_DOMAIN` on the Railway **site** service was set to the site's own domain.
The substitution mechanism (site/Dockerfile CMD) works correctly — the value is wrong.

**Change (proper fix, do this one):**
1. Railway **app** service (`deewaanai-production`): add custom domain `app.deewaanai.com`.
2. Porkbun zone `deewaanai.com`: add `CNAME` — Host: `app` (Porkbun auto-appends the
   domain; do NOT type the full name) — Answer: the target Railway shows for it.
3. Railway **site** service: set `APP_DOMAIN=app.deewaanai.com`, redeploy site.
4. App service env review: any base-URL / OAuth issuer / callback vars that embed the
   `*.up.railway.app` hostname must be updated to `app.deewaanai.com` so OAuth discovery
   and issued URLs match the new hostname. Keep the old Railway domain attached — existing
   MCP client connections keep working during transition.
5. Waitlist CORS origins already include https://deewaanai.com — no change needed.

**Acceptance:** `curl -sL https://deewaanai.com/docs/ | grep -o 'https://[a-z0-9.-]*/mcp'`
returns `https://app.deewaanai.com/mcp` only; a real MCP client completes the OAuth
connect flow against that URL.

---

## Fix E2 — raw {{...}} placeholders visible on the live site

**Symptom (live):** footer/legal areas literally render `{{COMPANY_LEGAL_NAME}}`,
`{{DISCORD_URL}}`, `{{GITHUB_URL}}`, `{{X_URL}}`.

**Constraint from founder:** the Discord server and social handles are NOT registered yet.
So this fix must degrade gracefully — placeholders must never render raw, and unset links
must disappear, not point nowhere.

**Change:**
1. Social links (`DISCORD_URL`, `GITHUB_URL`, `X_URL`): render each footer icon/link ONLY
   when its value is configured (env/site config). Unset → element omitted entirely.
   No dead `#` links, no empty hrefs.
2. `COMPANY_LEGAL_NAME`: required value — wire it through the same runtime substitution
   as APP_DOMAIN (site/Dockerfile CMD + Railway site env) or the Astro site config,
   whichever the site already uses for SITE_DOMAIN. Founder supplies the exact registered
   UK company name; use `DeeWaanAI Ltd` as the interim value ONLY if the founder has not
   provided it by merge time, and flag it in the PR description.
3. Grep the built dist for any OTHER `{{...}}` tokens and treat them the same way
   (render-if-set or substitute) — the four above are what the live check caught, not
   necessarily the full set.

**Acceptance:** `curl -sL https://deewaanai.com/ https://deewaanai.com/docs/ | grep -o
"{{[A-Z_]*}}"` returns nothing on every public page; footer shows no dead links while
socials are unregistered.

**Founder follow-up (not coding team):** register Discord server + X/GitHub org handles
("DeeWaanAI"), then set the three env values — links appear without a code change.

**UPDATE (2026-07-14) — values confirmed by founder, verified live:**

| Env var | Value |
|---|---|
| `DISCORD_URL` | `https://discord.gg/nuRKGEEVdE` (verified permanent: `expires_at: null`) |
| `X_URL` | `https://x.com/DeeWaanAI` |
| `GITHUB_URL` | **leave UNSET** — org exists but has no public repos until the repo publication protocol runs at launch; render-if-set must hide the link |
| `COMPANY_LEGAL_NAME` | `Mug and Beyond Ltd` — but do NOT render the bare name; use the full trading-name formula below |

**Legal footer text (replaces any bare {{COMPANY_LEGAL_NAME}} usage):**
> DeeWaanAI is a trading name of Mug and Beyond Ltd, registered in England and Wales
> (Company No. 14916888). Registered office: 20 Wenlock Road, London N1 7GU,
> United Kingdom.

Implement as site config/env like the other values. All values are now final — no
pending inputs remain for E2.

Set `DISCORD_URL` + `X_URL` on the Railway site service alongside the E2 code change.

---

## Fix E3 — Batch D close-out (still open, still uncommitted)

Current repo state: ALL Batch D work sits uncommitted in the working tree. Additionally:

1. **Beta tab frontend was never built** (D3 frontend). Backend is done and typechecks
   (`listWaitlist`, `markWaitlistInvited`, migration 017). Build the AdminPanel "beta" tab
   per AUDIT-FIXES-BATCH-D.md Fix D3 + its "implementation references" section
   (exact line numbers for TabKey, tabs array, i18n blocks).
2. **Delete tooling debris before commit:**
   - `api/routers/admin_temp_endpoints.ts` (0 bytes, leftover)
   - `insert_endpoints.py` (repo root, leftover patch script)
3. **Note:** db/schema.ts contained a corrupted duplicate of `waitlistEntries` (broke the
   entire server typecheck). Already repaired in the working tree — do not re-paste old
   fragments; run `npx tsc --noEmit -p tsconfig.server.json` before committing.
4. **Deploy reminder:** migration 017 must run against production MySQL when this ships
   (`waitlist_entries.invited_at`).

**Acceptance:** `git status` clean after a single Batch D+E commit series; typecheck,
tests, `npm run check-i18n` all green; /admin shows the Beta tab with waitlist +
voucher sections; debris files gone from the tree.

---

## Out of scope
- Registering social accounts (founder action, see E2 follow-up).
- Removing the `*.up.railway.app` generated domains (keep as debugging fallback).
- Email/DNS — verified live and closed (Porkbun forwarding, single SPF).
