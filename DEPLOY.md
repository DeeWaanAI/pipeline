# Deploying DeeWaanAI to Railway — Click-by-Click Checklist

**Time needed:** ~45 minutes · **Cost:** ~$25–45/month · **Skill needed:** none beyond copy-paste

What you're doing: putting the app on a cloud computer with a database (MySQL), a cache (Redis), and a secure web address (HTTPS) — all managed for you by Railway.

---

## Before you start (5 min, on your Mac)

1. Create a free account at **github.com** if you don't have one.
2. Create a new **private** repository (github.com → "+" → "New repository" → name it `deewaanai` → Private → Create). Leave it empty — no README, no .gitignore.
3. In the project folder on your Mac, push the code (the repo is already git-initialized):
   ```
   git remote add origin https://github.com/<your-username>/deewaanai.git
   git push -u origin main
   ```
4. Generate your three secrets — run each command once and **save the output somewhere safe** (a password manager):
   ```
   openssl rand -hex 32    # → APP_SECRET
   openssl rand -hex 32    # → AI_SWARM_MASTER_KEY
   openssl rand -hex 32    # → MARKETPLACE_MASTER_KEY
   ```
   ⚠️ These three protect user data. Never paste them into GitHub, Slack, or email.

---

## Step 1 — Create the Railway project (2 min)

1. Go to **railway.com** → sign up (GitHub login is easiest).
2. Click **"New Project"** → **"Deploy from GitHub repo"** → authorize Railway → select `deewaanai`.
3. Railway detects the `Dockerfile` automatically and starts building. The first deploy will **fail** — that's expected (no database or variables yet). Continue below.

## Step 2 — Add MySQL (2 min)

1. In your project canvas, click **"+ Add"** (or right-click) → **"Database"** → **"Add MySQL"**.
2. Wait ~30 seconds for it to provision. Click the MySQL service → **"Variables"** tab — you'll see `MYSQL_URL` (and possibly `DATABASE_URL`). You'll copy its **value** in Step 4.

> **Why the connection line might not show:** Railway draws a line between services on the canvas only when one service's variable **references** another using the `${{MySQL.MYSQL_URL}}` syntax. If you paste the plain URL string (the foolproof method below), the app connects fine but the visual line won't appear. Both work identically at runtime — the line is just dashboard cosmetics. If you want the line, use the reference syntax instead of the plain value in Step 4.

## Step 3 — Add Redis (1 min)

1. **"+ Add"** → **"Database"** → **"Add Redis"**.
2. Same — a `REDIS_URL` variable appears on the Redis service.

## Step 4 — Set the app's environment variables (10 min)

Click the **app service** (the GitHub one, named after your repo) → **"Variables"** tab → add each row below (**"+ New Variable"** per row, or paste into the raw editor):

| Variable | Value to enter |
|---|---|
| `DATABASE_URL` | **Option A (foolproof, recommended):** Copy the **value** of `MYSQL_URL` from the **MySQL** service → Variables — pick the one **without** "PUBLIC" in the name — and paste it here as a plain string.<br><br>**Option B (shows the connection line on the Railway canvas):** Use Railway's reference syntax: `${{MySQL.MYSQL_URL}}` (or `${{MySQL.DATABASE_URL}}` if that's what your MySQL service shows). The app works the same way; Railway just draws a line between the services in the UI. |
| `REDIS_URL` | Same: copy the `redis://...` value (not the PUBLIC one) from the **Redis** service → Variables and paste it here. Or use `${{Redis.REDIS_URL}}` if you want the canvas line. |
|---|---|
| `DATABASE_URL` | Copy the **value** of `MYSQL_URL` (or `DATABASE_URL`, whichever is present) from the **MySQL** service → Variables — pick the one **without** "PUBLIC" in the name — and paste it here as a plain value |
| `REDIS_URL` | Same: copy the `redis://...` value (not the PUBLIC one) from the **Redis** service → Variables and paste it here |
| `APP_SECRET` | your first `openssl rand -hex 32` output |
| `AI_SWARM_MASTER_KEY` | your second output |
| `MARKETPLACE_MASTER_KEY` | your third output |
| `APP_ID` | `deewaanai` (placeholder — required by the app, unused by features) |
| `VITE_APP_ID` | `deewaanai` (same) |
| `NODE_ENV` | `production` (already set by the Dockerfile; adding it here is harmless) |
| `AUDIT_EXPORT_KEY` | *(optional)* a fourth `openssl rand -hex 32` — separates compliance-export signatures from the session secret, so rotating `APP_SECRET` later won't break verification of old exports. Can be added any time; old exports stay verifiable either way. |

Leave these **empty for now** (the app runs fine without them): `STRIPE_*`, `SENTRY_DSN`, `DATABASE_READ_URL`.

Railway redeploys automatically when you save variables.

## Step 5 — Create the database tables (10 min, one-time, from your Mac)

The app container can't create its own tables, so you do it once from your Mac:

1. In Railway, click the **MySQL service** → **"Settings"** → **"Networking"** → enable the **public TCP endpoint**. Note the host and port it shows (e.g. `shuttle.proxy.rlwy.net:12345`).
2. Click MySQL → **"Variables"** → copy the `MYSQL_PUBLIC_URL` (or build it: `mysql://root:<password>@<host>:<port>/railway` — password is on the same Variables tab).
3. On your Mac, in the project folder:
   ```
   DATABASE_URL="<the public mysql URL>" npm run db:push
   ```
   On a fresh database this creates all tables with **no questions asked**. If it ever asks about renames/data loss on a *fresh* database, stop and re-check the URL.
4. You can disable the public TCP endpoint again afterward (Settings → Networking) — the app uses the private internal URL.

## Step 6 — Turn on core feature flags (2 min)

Feature flags live in the database and start empty. Click **MySQL service → "Data" tab → "Query"** and run:

```sql
INSERT INTO feature_flags (`key`, name, description, enabled, rollout_percent) VALUES
  ('circuit_breaker', 'Circuit Breaker', 'Pipeline safety limits', 1, 100),
  ('local_folder', 'Local Folder Access', 'Link local project folders', 1, 100),
  ('store_relaunch', 'Store Relaunch', 'Stripe marketplace purchases', 1, 100),
  ('marketplace_ai_triage', 'Marketplace AI Triage', 'Platform AI triage for marketplace submissions (non-gating)', 1, 100),
  ('enterprise_sso', 'Enterprise SSO', 'OIDC/SAML login', 0, 0),
  ('enterprise_relay', 'Enterprise Relay', 'On-prem relay', 0, 0),
  ('gitee_sync', 'Gitee Sync', 'Gitee repo integration (incomplete feature)', 0, 0),
  ('mcp_sampling', 'MCP Sampling', 'Let MCP tools use the connected desktop app LLM (auto-detected per client)', 0, 0);
```

(the two enterprise flags and `gitee_sync` stay off until you've tested them live — the burial checklist in `ENGINEERING.md` explains when to remove them entirely. `companion_mcp` needs no flag — it's permanently on.)

Marketplace trust flow (see `DeeWaanAI-Next/MARKETPLACE-TRUST-SPEC.md`): submissions pass a deterministic security scan → optional platform AI triage (`marketplace_ai_triage` + `AI_TRIAGE_*` env vars; off/unconfigured = skipped, non-gating) → `certifying` (visible, not buyable) → blind human review (5×3, kappa > 0.60) → `published` (buyable). AI never publishes; humans gate buyability.

## Step 7 — Get your web address (1 min)

1. Click the **app service** → **"Settings"** → **"Networking"** → **"Generate Domain"**.
2. You get `https://<something>.up.railway.app` — that's your live app.

## Step 8 — Smoke test (5 min)

1. Open `https://<your-domain>/api/health` → must show `"status":"ok"` (the JSON also reports `redis`, `queue`, and `worker` status).
2. Open `https://<your-domain>/api/ready` → must show `"status":"ready"` — this one returns 503 unless MySQL **and** Redis are both reachable.
3. Open `https://<your-domain>` → the app loads.
4. **Sign up immediately** — the very first user automatically becomes admin (this is your account). Passwords must be at least 8 characters.
5. Open `/connect` and connect Claude Desktop to `https://<your-domain>/mcp` — run one pipeline end-to-end. This is your first real-world test on real hosting.

## Step 9 — Stripe when you're ready (test mode, 15 min)

1. stripe.com → keep **Test mode** ON → Developers → API keys → copy the **secret key** (`sk_test_...`) into Railway variable `STRIPE_SECRET_KEY`.
2. Create one test price (Products → Add product: "Solo" monthly) → copy its `price_...` id into `STRIPE_PRICE_SOLO`. There is no per-seat/team price any more — quantity is always 1.
3. Developers → Webhooks → Add endpoint: `https://<your-domain>/api/billing/stripe-webhook`, events: `checkout.session.completed`, `customer.subscription.*`, `charge.refunded` → copy the **Signing secret** (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`.
4. Buy a listing with test card `4242 4242 4242 4242` (any expiry/CVC). No real money moves.

---

## Good to know

- **Screenshot storage:** by default, feedback screenshots save to local disk, which Railway wipes on each redeploy — fine for beta. To make them durable, create a bucket on any S3-compatible storage (Cloudflare R2 has a free tier) and set five variables: `S3_ENDPOINT` (from your provider), `S3_REGION` (`auto` for R2), `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. Objects stay private — the app serves them through the existing auth check. Verify the wiring any time with `node scripts/smoke-storage.mjs` (see its header).
- **Backups (automated, Batch A):** the repo ships a daily GitHub Actions cron (`.github/workflows/backup.yml`, 03:00 UTC) that calls `POST /api/admin/backup` on production, which mysqldumps the database, gzips it, uploads it to your S3 bucket under `backups/`, and prunes dumps older than 7 days. To activate: (1) set the five `S3_*` variables (same bucket as screenshots, or a different one), (2) generate a token (`openssl rand -hex 32`) and set it as Railway variable `BACKUP_TOKEN`, (3) add the same value as GitHub repo secret `BACKUP_TOKEN` (Settings → Secrets and variables → Actions). Verify any time with Actions → db-backup → Run workflow. **Fallback:** `docker compose -f docker-compose.backup.yml up -d` on any always-on machine runs a daily mysqldump into local `./backups` (needs the MySQL **public** endpoint, Step 5.1). Set one of these up **before** real customer data — Railway's volume backups alone are not a recovery plan.
- **Trusted proxy:** the app trusts `x-forwarded-for` for rate-limit IPs because Railway's edge sets it. If you ever serve the app directly (no proxy), set `TRUSTED_PROXY=false` so rate limits key off the real socket IP instead.
- **Costs:** watch the Railway usage page weekly during beta; ~$25–45/mo is normal for light traffic.
- **Redeploys:** every `git push` to `main` redeploys automatically — and every push runs the CI gates (`.github/workflows/ci.yml`: typecheck, i18n parity, tests, build, plus integration tests against real MySQL/Redis). A red CI run means don't celebrate the deploy; check Actions first.
- **If the app crashes:** app service → "Deployments" → click the deployment → "View Logs". The `/api/health` check will show `degraded` if the database is unreachable.
- **Going live with real payments:** flip Stripe to live mode keys (same three variables) and buy a real domain (Railway Settings → Networking → Custom Domain, ~$12/yr at any registrar). The full go-live acceptance checklist (Stripe card swipe, live SSO, on-prem relay, read replica) is in `DeeWaanAI-Next/ACCEPTANCE.md`.

## Optional: dedicated worker service (before heavy traffic)

By default the pipeline worker runs **inside** the web process (`START_WORKER` unset). Long pipeline runs then share CPU/heap with HTTP serving. To split them:

1. **"+ Add" → "GitHub Repo"** → select `deewaanai` again (same repo, second service).
2. On the new service → **Settings → Deploy → Custom Start Command**: `node dist/workerEntry.js`. Add the same variables as the web service (`DATABASE_URL`, `REDIS_URL`, the three secrets, `APP_ID`).
3. On the **web** service, add variable `START_WORKER=false`.
4. Verify: web `/api/health` shows `"worker":"disabled"`, and the worker service logs show `Worker process started` + `swarmWorker: started`. Pipeline runs should still complete — now processed by the worker service.

Single-node is fine for beta; do this when pipeline runs start slowing page loads.
