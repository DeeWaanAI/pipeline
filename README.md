# DeeWaanAI

DeeWaanAI is the evolution of AI Swarm Studio — a pipeline-building studio — into a
multi-product platform:

- **Companion (MCP server)** — any desktop LLM app (Claude Desktop, ChatGPT, Qwen Code,
  Kimi) connects to `/mcp` over streamable HTTP + OAuth 2.1 and can run the user's
  pipelines. MCP tools are a versioned public API contract: never renamed, only added.
- **DeeWaanAI Market** — a certified cross-app marketplace: public certification reports,
  5-reviewer grading, Stripe purchases, and "buy once, run in your app" entitlements.
- **Enterprise** — SSO (OIDC + SAML), an outbound-only on-prem relay, signed compliance
  exports, and per-customer MCP rate limits (behind `enterprise_sso` / `enterprise_relay`).

**Stack:** Hono + tRPC + MySQL/drizzle on the server; React 19 + Vite + i18next on the
client; optional Redis (queue/pub-sub — in-memory fallbacks without it); Stripe for
billing. The same Node process serves the API, the MCP surface, and the built SPA.

## Quickstart

Prerequisites: Node 20+, Docker (for MySQL + Redis).

```bash
docker compose up -d        # MySQL 8.0 + Redis 7 (see docker-compose.yml)
cp .env.example .env        # then edit values
npm ci
npm run db:push             # push the drizzle schema to MySQL
npm run dev                 # Vite dev server on http://localhost:3000 (API + SPA)
```

Production-style run:

```bash
npm run build               # vite build → dist/public, esbuild api/boot.ts → dist/boot.js
npm start                   # NODE_ENV=production node dist/boot.js (PORT=3000)
```

Health check: `GET /api/health` (200 when MySQL is reachable, 503 when degraded).

## Environment variables

All variables are read by `api/lib/env.ts` (via `dotenv`). In production the process
refuses to boot without the required ones — or with a known dev default secret.

| Variable | Required | Description |
|---|---|---|
| `APP_ID` | yes | Application identifier (also exposed to the client as `VITE_APP_ID`) |
| `APP_SECRET` | yes | Root secret — access-token signing (HS256, SHA-256 derived) and audit-export HMAC. Must not be a dev default in production |
| `DATABASE_URL` | yes | MySQL connection string, e.g. `mysql://swarm:swarmpass@localhost:3306/swarm` |
| `VITE_APP_ID` | yes | Client-side copy of `APP_ID` (Vite inlines `VITE_*` vars) |
| `DATABASE_READ_URL` | no | MySQL read-replica DSN; read-heavy browse/report queries go here. Empty = primary handles everything |
| `REDIS_URL` | no | Redis for queue + pub/sub backends. Empty = in-memory fallbacks (single node only) |
| `STRIPE_SECRET_KEY` | no | Stripe API key. Empty = billing routes return 503 |
| `STRIPE_WEBHOOK_SECRET` | no | Stripe webhook signing secret (`POST /api/billing/stripe-webhook`) |
| `STRIPE_PRICE_SOLO` | no | Stripe price id for the Solo plan |
| `SENTRY_DSN` | no | Sentry error reporting. Empty = disabled |
| `BACKUP_TOKEN` | no | Bearer token for `POST /api/admin/backup` (GitHub Actions cron). Requires `S3_*`; empty = backups disabled (503) |
| `TRUSTED_PROXY` | no | `false` = ignore `x-forwarded-for`, rate-limit by direct socket IP. Default `true` (safe behind Railway's edge) |
| `AI_TRIAGE_SLUG` | no | Provider slug for the platform AI triage model (e.g. `openai` for OpenAI-compatible endpoints). Empty = triage skipped (non-gating) |
| `AI_TRIAGE_MODEL` | no | Triage model name (e.g. `qwen3.6-flash` on Alibaba Cloud Model Studio). Required with `AI_TRIAGE_SLUG` to enable triage |
| `AI_TRIAGE_API_KEY` | no | API key for the triage endpoint. Optional — self-hosted endpoints may not need one |
| `AI_TRIAGE_BASE_URL` | no | Triage endpoint base URL, e.g. Model Studio `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` |
| `PUBLIC_APP_URL` | no | Public origin used for absolute links. Empty = Railway production URL fallback |

Additional variables read directly from `process.env` (not in `.env.example`):
`OWNER_UNION_ID`, `AI_SWARM_MASTER_KEY`, `MARKETPLACE_MASTER_KEY` (see `api/lib/env.ts`),
`PORT` (default 3000), `NODE_ENV`, `LOG_LEVEL`.

## Key scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Vite dev server — API (`api/boot.ts`) + SPA with HMR on port 3000 |
| `npm run build` | Client bundle (`dist/public`) + bundled server (`dist/boot.js`) |
| `npm start` | Run the production server from `dist/boot.js` |
| `npm run check` | Type-check the whole project (`tsc -b`) |
| `npm test` | Vitest — pure-function unit tests under `api/**` |
| `npm run i18n:check` | Locale key-parity gate (`scripts/check-i18n.cjs`, client + server bundles) |
| `npm run lint` / `format` | ESLint / Prettier |
| `npm run db:push` | Push `db/schema.ts` to the database (dev) |
| `npm run db:generate` / `db:migrate` | Generate / apply drizzle migrations (`db/migrations/`) |
| `npm run make-admin` | Promote a user to admin (`scripts/make-admin.cjs`) |

Release gates (all must be green): `npm run check` → `npm run i18n:check` → `npm test` →
`npm run build`. Boot smokes: `scripts/smoke-teamsync.mjs`, `scripts/smoke-enterprise.mjs`.

## Deployment

- **Railway (recommended for beta)** — [DEPLOY.md](DEPLOY.md): click-by-click checklist,
  no ops experience needed (~45 min, ~$25–45/mo).
- **Docker** — `Dockerfile` is a two-stage `node:20-alpine` build: `npm ci` → `npm run build`
  → production-deps-only runner image, non-root `appuser`, `PORT=3000`, healthcheck on
  `/api/health`, `CMD ["node", "dist/boot.js"]`. `docker-compose.yml` ships MySQL + Redis
  and has a commented-out `app` service for a fully containerized local stack.
- **PM2** — `ecosystem.config.cjs` runs `dist/boot.js` as `swarm-studio`: single fork
  instance, `max_memory_restart: 280M`, 256 MB heap cap (`NODE_OPTIONS`), auto-restart
  with backoff, rotated logs under `logs/`.
- **Alibaba Cloud** — see `deploy/aliyun-optimized.md` plus `deploy/install.sh` /
  `deploy/aliyun-setup.sh`.
- **On-prem relay** — `relay/connector.mjs` (zero-dependency outbound-only connector) +
  `docker-compose.relay.yml` (no inbound ports). Requires the `enterprise_relay` flag.

## Documentation map

- [ENGINEERING.md](ENGINEERING.md) — module map, request flows, and how-to recipes
  (add a language / MCP tool / billing plan / LLM provider / feature flag / migration).
- [DeeWaanAI-Next/README.md](DeeWaanAI-Next/README.md) — transformation overview and
  design contract (the six never-rewrite rules).
- [DeeWaanAI-Next/PROGRESS.md](DeeWaanAI-Next/PROGRESS.md) — phase-by-phase progress
  tracker with acceptance evidence (Foundation Sprint → Phase 3 → Final Sprint).
- Strategy docs (archived in `DeeWaanAI-Next/`):
  [Features Report](DeeWaanAI-Next/DeeWaanAI-Features-Report.md),
  [Business Transformation Plan](DeeWaanAI-Next/DeeWaanAI-Business-Transformation-Plan.md),
  [Code Update Roadmap](DeeWaanAI-Next/DeeWaanAI-Code-Update-Roadmap.md).

## License

DeeWaanAI is **dual-licensed**:

- **Open source:** [AGPL-3.0](LICENSE) — free to use, modify, and self-host under
  the AGPL-3.0 terms.
- **Commercial:** using the code without the AGPL obligations (proprietary or
  white-label use) requires a paid commercial license — see
  [COMMERCIAL.md](COMMERCIAL.md).
