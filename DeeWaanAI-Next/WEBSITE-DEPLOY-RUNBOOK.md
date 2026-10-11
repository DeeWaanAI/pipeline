# WEBSITE-DEPLOY-RUNBOOK — how to push a site update live

**For the coding team.** The marketing site (`site/`) is a static Astro app deployed as
its **own Railway service** from the main GitHub repo. **Going live = committing and
pushing to `main`.** There is no separate upload step; Railway rebuilds and serves the
site automatically on every push.

---

## The facts

| Item | Value |
|---|---|
| Repo | `youssef-hariri/deewaanai` (git remote `origin` = `github-deewaanai:youssef-hariri/deewaanai.git`) |
| Branch that deploys | `main` |
| Site location in repo | `site/` (a subdirectory — **not** a separate repo) |
| Hosting | Railway, service **"site"**, Root directory `site/`, `site/Dockerfile` auto-detected |
| Custom domain | `www.deewaanai.com` (attached to the Railway service; DNS at Porkbun) |
| Build | `site/Dockerfile`: `node:22-alpine` builds Astro → `caddy:alpine` serves `dist/` |

**What a push to `main` triggers (automatic):**
1. **GitHub Actions → "Site CI"** (`.github/workflows/site-ci.yml`, runs only for `site/**`):
   `npm ci` + `npm run build` (must be warning-free) + a check that the `{{site_domain}}`
   placeholder survives the build. This is a gate — it does **not** deploy.
2. **Railway GitHub integration** → rebuilds the "site" service via the Dockerfile and
   serves the new `dist/`. Live in ~1–2 minutes.

---

## Standard workflow (every update)

```bash
cd "/Users/youssefhariri/Documents/app 25/site"

# 1. Make your edits (en.json, *.astro layouts, content/docs/*.md, etc.)

# 2. Build — MUST be green and warning-free (this is also the CI gate)
npm run build

# 3. Preview the production build locally
npm run preview          # or: npm run dev  (live reload at http://localhost:4321)

cd "/Users/youssefhariri/Documents/app 25"

# 4. Stage ONLY the site changes (keep unrelated WIP out of the commit)
git add site/

# 5. Commit
git commit -m "site: <short description of the change>"

# 6. Push — this is the deploy
git push origin main
```

Then verify (allow ~1–2 min for Railway):
- Check the **Railway "site" service** deploy logs (build succeeded, container started).
- Open the **Railway public URL** (`https://<service>.up.railway.app`) first.
- Open **https://www.deewaanai.com** — use a hard refresh / incognito window to bypass cache.
- Confirm the GitHub Actions **Site CI** check is green.

---

## Environment variables (already set on the Railway service — don't change unless asked)

| Variable | When | Purpose |
|---|---|---|
| `PUBLIC_WAITLIST_API_URL` | build arg | Waitlist backend base (`https://<app-domain>/api/waitlist`). Optional since 2026-10-11: unset, the form still renders and posts to `SITE.appDomain`, and a signup the API refuses shows a prefilled mail link instead of disappearing |
| `PUBLIC_SITE_DOMAIN` | build arg | Canonical origin for OG/sitemap/canonical |
| `SITE_DOMAIN` | runtime | Substituted into `robots.txt` at container start |
| `APP_DOMAIN` | runtime | Substituted into built HTML (docs code blocks) at container start |
| `PORT` | runtime | Injected by Railway (Caddy listens on it) |

**Placeholders are normal:** a local or CI build keeps `{{site_domain}}` / `{{APP_DOMAIN}}`
literally in the output. Railway substitutes them when the container starts. The CI gate
*requires* the placeholder to survive — so **never** set `PUBLIC_SITE_DOMAIN` in CI.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `npm run build` fails locally | Fix it before pushing — Site CI would reject it anyway. |
| Pushed, Railway URL updated, but `www.deewaanai.com` stale | CDN/browser cache — hard refresh / incognito. |
| Pushed, but nothing changed anywhere | Railway auto-deploy may be disabled, or the push didn't reach `main`. Check Railway service → Settings → auto-deploy; check `git log origin/main -1`. |
| Custom domain doesn't resolve at all | Porkbun DNS. Must be: **ALIAS** (apex `deewaanai.com`) + **CNAME** (`www`) → the Railway custom-domain target; **no URL forwarding**; wait for Railway to issue the TLS cert. (This was previously mis-set to Porkbun parking — now fixed.) |
| Site CI fails: "site-domain placeholder missing" | Something baked a real domain into the build. Ensure `PUBLIC_SITE_DOMAIN` is **not** set in the CI environment. |
| Waitlist form posts to the wrong origin | `PUBLIC_WAITLIST_API_URL` is missing from the build, so `src/config.ts` fell back to `https://APP_DOMAIN`. Set the build arg to the real app origin (`https://<app-service-domain>/api/waitlist`) — or check the fallback mail link is reaching `hello@deewaanai.com`. |

---

## Rollback

- **Fastest:** in Railway, open the "site" service → **Deployments** → redeploy the previous
  deployment.
- **Via git:** `git revert <bad-commit>` then `git push origin main` (Railway rebuilds).

---

## Governance note

The repo owner runs an **L3 security review** before pushing site changes; on 0 findings it
is pushed. Pure content/copy changes (markdown, `en.json` strings, presentational `.astro`
sections) are low-risk. **Flag the owner** before pushing anything that adds scripts,
external URLs, iframes, form endpoints, or build/runtime config changes.

---

## One-time setup (already done — reference only)

1. Railway: new service from repo `youssef-hariri/deewaanai`, Root directory `site/`
   (Dockerfile auto-detected).
2. Set the env vars in the table above.
3. Attach custom domain `www.deewaanai.com`; configure Porkbun DNS (ALIAS + CNAME);
   wait for TLS.

See `site/README.md` for local dev, the waitlist client smoke test, and adding a language.
