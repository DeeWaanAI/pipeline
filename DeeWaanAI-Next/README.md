# DeeWaanAI-Next — Transformation Progress Tracking

This folder tracks implementation progress for the **DeeWaanAI business transformation**: evolving the existing AI Swarm Studio (React 19 + Vite, Hono + tRPC, MySQL/drizzle, Docker on Alibaba Cloud) from a single web app into a multi-product platform.

## The three products

1. **Companion (MCP server)** — Phase 0. Any desktop LLM app (Claude Desktop, ChatGPT, Qwen Code, Kimi) connects to `https://<host>/mcp` via streamable HTTP + OAuth and can run the user's pipelines. MCP tools are a versioned public API contract: never renamed, only added.
2. **DeeWaanAI Market** — Phase 1. Certified cross-app store relaunch: public certification reports, Stripe purchases, purchase → MCP entitlement ("buy once, run in your app").
3. **TeamSync** — Phase 2. Mixed-app teams share memory, runs, handoffs, and feedback — nobody switches desktop apps. Cross-app approval handoffs are the magic demo.

Phase 3 (Enterprise) adds SSO, an on-prem relay, compliance exports, and SLA/scale work.

## Strategy documents (this folder)

- [DeeWaanAI-Features-Report.md](DeeWaanAI-Features-Report.md) — current product/feature inventory
- [DeeWaanAI-Business-Transformation-Plan.md](DeeWaanAI-Business-Transformation-Plan.md) — business strategy and product definitions
- [DeeWaanAI-Code-Update-Roadmap.md](DeeWaanAI-Code-Update-Roadmap.md) — engineering plan; the **"0. Design contract"** (six never-rewrite rules) and **"FOUNDATION SPRINT (F0)"** sections govern all implementation work

## Design contract (summary — see roadmap for full text)

1. Stateless app nodes — shared state in MySQL / object storage / Redis, never process memory
2. Long work runs in workers, not requests — pipeline execution moves to a job queue; runs survive deploys
3. One auth/entitlement brain — a single `entitlements` service answers "can user X do Y"
4. Feature-flag everything — each phase ships behind a flag (`companion_mcp`, `store_relaunch`, `teamsync`, `enterprise_sso`)
5. i18n is one file + one folder — extended to server-side messages via keyed bundles
6. MCP tools are a public API contract — versioned, never renamed, only added

## This folder's purpose

`PROGRESS.md` is the living checklist: every roadmap item gets marked complete with the date and the files created/modified, so the transformation state is auditable without reading git history. Update it as each item lands.
