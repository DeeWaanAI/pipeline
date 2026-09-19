# DeeWaanAI → Business Transformation Plan
### From "AI swarm platform" to the neutral skill layer & team-collaboration fabric for every LLM desktop app

*Prepared July 2026. Grounded in the DeeWaanAI codebase (`/Users/youssefhariri/Documents/app 25`) and current MCP ecosystem facts.*

---

## 0. Executive summary

Stop competing with ChatGPT, Claude, Kimi, and Qwen for the user's chat window. Instead, sell to **every user of those apps** through the one channel they all now share: **MCP (Model Context Protocol)** — the "USB-C for AI" that Claude Desktop supports natively, ChatGPT supports via Apps/Developer Mode with OAuth (all paid plans), Qwen Code/Agent supports with OAuth remote servers, and Kimi's agentic stack integrates.

You become three sellable products, 80% of which is code you already wrote:

1. **DeeWaanAI Companion** — a hosted MCP server that gives any desktop LLM app access to your certified pipelines, multi-provider orchestration, and project memory. *(Subscription.)*
2. **The Certified Cross-App Skill Store** — your marketplace, repositioned: pipelines that work in *whatever app the buyer already uses*, with the Kappa-validated quality badge and encrypted-prompt IP protection nobody else offers. *(Take rate + certification fees.)*
3. **TeamSync** — the "team plugin" you described: a per-team MCP server + cloud workspace that lets a mixed team (Alice on Claude, Bob on Kimi, Carol on ChatGPT) share context, pipelines, runs, approvals, and feedback **without anyone switching apps**. *(Per-seat subscription — your highest-margin, stickiest product.)*

---

## 1. Why this is winnable (the verified facts)

| Fact | Source (July 2026) | What it means for you |
|---|---|---|
| Claude Desktop supports MCP servers natively (local + remote) | Anthropic docs, Nov 2024→ | Channel #1 open today |
| ChatGPT has full read/write MCP support ("Apps", formerly Connectors) with OAuth, on Plus/Pro/Business/Enterprise; **remote servers only, no localhost** | OpenAI dev docs, Sept–Dec 2025 | A *hosted* MCP server is the only way in — which conveniently forces cloud billing through you |
| Qwen Code / Qwen-Agent support MCP incl. **OAuth remote servers** | qwenlm.github.io, 2026 | Channel #3, auth+billing model already expected by the client |
| Kimi K2 is agentic with MCP integration | Moonshot ecosystem, 2025 | Channel #4 |
| MCP is transport-agnostic (stdio/SSE/streamable HTTP), model-agnostic, open spec; 1000+ servers exist; Google/Microsoft/OpenAI all endorsed | modelcontextprotocol.io ecosystem | One server build covers all current and future hosts; zero per-provider integration tax |
| Provider team plans run ~$25/seat/mo | Anthropic/OpenAI pricing | Your TeamSync at $8–12/seat sits comfortably beneath as an add-on, not a replacement |

**The strategic asymmetry remains:** providers will never be neutral (OpenAI won't route to Claude mid-pipeline) and will never objectively certify competitors' skills. You own neutrality + certification. MCP hands you the distribution pipe.

---

## 2. Product 1 — DeeWaanAI Companion (the cross-app bridge)

**What the user experiences:** In Claude Desktop / ChatGPT / Qwen / Kimi, they add one MCP connection (`https://mcp.deewaan.ai`, OAuth login). Their desktop app gains tools like:

- `run_pipeline(name, input)` — execute any of their (or purchased) certified pipelines; results stream back into their native chat
- `list_my_skills` / `search_marketplace` — discover certified skills by category + quality grade
- `project_context(path)` — pull the Project Intelligence Card + relevant file contents for a connected repo
- `memory_get` / `memory_append` — persistent cross-session project memory
- `run_status(runId)` / `approve_step(runId, action)` — human-in-the-loop from *inside their own app*

**Why users pay:** (a) multi-model pipelines their single-provider app cannot run — your cloud orchestrates OpenAI→Claude→Qwen chains, or uses the user's own keys; (b) certified quality instead of prompt-lottery; (c) memory/context that survives across sessions and apps.

**Billing model that protects your margins:** BYOK (bring-your-own-keys) by default — users plug provider keys into your existing encrypted key store (`apiKeyStore`, PBKDF2 480k iterations — already built), so LLM token cost is *theirs*; you charge for orchestration, certification, and marketplace access, not tokens. Optional "managed keys" tier with token markup for convenience users.

**What you already have vs. what to build:**
- ✅ Pipeline execution engine, SSE streaming (`stream-route.ts`), resumable runs (`swarmRuns.executionState`), approvals (`approveStep`), multi-provider adapters (`api/lib/providers`), encrypted key store, Intelligence Card (`projectIntelligence.ts`), memory (`memoryManager.ts`, `stateSummarizer.ts`), export scaffolding (`api/routers/export.ts`)
- 🔨 Build: remote MCP server wrapper (~1 thin service mapping MCP tools → your existing tRPC procedures), OAuth token issuance tied to user accounts, Stripe billing, rate limiting (your circuit-breaker plugin is a head start)

**Estimated build: 3–5 engineering weeks for an MVP.** This is your Phase 0.

---

## 3. Product 2 — The Certified Cross-App Skill Store

Your marketplace module is already unusually complete: listings with structured objectives/input/output specs, auto-generated 5-class test suites (simple→adversarial), per-step intermediate capture, 6-dimension human review, AI ensemble scoring, **Fleiss' Kappa** auto-approval (≥3.5/5 avg AND κ>0.60), AI–human correlation, encrypted prompts, deposits, refund ledger, reviewer points economy.

Reposition it: **"Buy once, run in your app."** Every listing page gets a public, SEO-indexable **certification report** — the grade, the Kappa score, sample test outputs. "DeeWaanAI Certified" becomes the Michelin star; provider stores are the restaurants.

**Economics (all already in your schema):**
- **Take rate: 20%** of sales + payment fees (below Apple's 30%, above Gumroad — justified by certification + cross-app portability).
- **Certification deposit** ($49–99 per listing, refunded out of sales commissions — your `creatorDeposits`/`refundLedger` tables already implement exactly this). Kills spam listings, funds the human review pool.
- **Reviewer points → subscription days** (already built: 10 pts/prompt + completion bonus; 72 pts/day Master, 120 pts/day Sage). This is a **zero-cash-CAC growth loop**: reviewers are paid in your own product.
- Keep the Artist / Master / Sage （诗斋） tier poetry as consumer branding — it tested well, keep the equity.
- **Research Mode (batch runs + pipeline chaining + CSV export, see RESEARCH-MODE-SPEC.md) ships bundled and included in Sage** — it becomes the top-tier upgrade reason ("Run 100 experiments in parallel; DeeWaanAI ran a peer-reviewed study on itself"). No micro add-ons; optional $14.99–19.99/mo standalone add-on for lower tiers later only if demanded. Marginal infra cost ≈ 0 (users' own API keys + Railway usage-based autoscaling); abuse controlled by per-tier batch quotas (fairness), not pricing.
- **Pricing architecture: tiers × seats, no "Team tier".** The Artist/Master/Sage ladder is the *individual* axis (what one person can do); team collaboration stays a separate per-seat plan (Team Seat / TeamSync) stacked on each member's tier — the Notion/Figma/Linear pattern. Team value scales with headcount, so per-seat captures it; folding teams into Sage would inflate the solo researcher's price. In team workspaces, Research Mode follows the run owner's individual tier (Sage member can batch, Artist member can't) — no new SKU, and it upsells members to Sage one by one.

---

## 4. Product 3 — TeamSync: the "Team" plugin for mixed-app teams (your idea, sharpened)

### The pain (today, in every AI-native team)
Alice uses Claude Desktop, Bob uses Kimi, Carol uses ChatGPT. They cannot share AI context, prompts, agent runs, or review each other's AI output. The state of the art is copy-paste into Slack. Nobody can switch apps without losing their workflows, and no provider will ever interoperate with a rival's desktop app.

### What TeamSync is
A **per-team hosted MCP server + cloud workspace**. Each member connects it in their own desktop app (60-second OAuth setup). Nothing else changes for them. Under the hood it's your existing teams module pointed outward:

| TeamSync capability | Existing code it rides on |
|---|---|
| Shared project workspaces with roles (owner/admin/tester/viewer) & invite codes/QR | `teams`, `teamMembers`, `teamProjects`, `team.joinByCode` |
| **Shared memory** — one project brain every member's app reads/writes (`team_context_get`, `team_memory_append`) | `stateSummarizer` (project-state.md), `memoryManager` (episodic memory) |
| **Cross-app handoffs** — Alice starts a run in Claude; Bob gets the pending approval *inside Kimi* and resumes it | `swarmRuns.executionState` (resumable), `approveStep`, `resumePipeline`, `notifications` |
| Team skill pool — licensed + private pipelines shared across the team | `team.getSharedPipelines/importPipeline`, `customAgents`, marketplace team licenses |
| Shared audit ledger — every run's full response chain, tokens, latency, visible to the whole team | `agentResponses`, `agentRuns`, `myData` audit views |
| Feedback → issues → fix verification loop, from inside any app | `feedback`, `issues`, `fixVerifications`, screenshot route |
| Changelog broadcasts into each member's app | `changelogEntries`, `eventBus` |

**Positioning line:** *"Slack unified team messages. TeamSync unifies team AI work — across Claude, ChatGPT, Kimi, and Qwen."* Or: **"Figma's multiplayer mode, for AI agents."**

### Why this is your best product
- **Stickiest:** shared memory + shared run ledger create switching costs providers can't erode (they'd have to interoperate with rivals).
- **Land-and-expand:** one member installs → invites the team → seats grow organically. Your invite-code/QR flow is built.
- **Heterogeneity is your moat:** the more fragmented the desktop-app market becomes, the more teams *need* you. Every new LLM app that ships with MCP grows your TAM.

### Pricing
- **Team: $10/seat/mo, 3-seat minimum.** Free 2-seat tier to seed viral invites (your `vouchers` table already does promo codes/temporary tier grants — reuse it for trials).
- Includes: TeamSync server, shared memory, shared audit, feedback/issues, a monthly team skill credit for the marketplace.
- **Enterprise add-on:** SSO, on-prem/VPC relay (for the ChatGPT-remote-only constraint), compliance export of the audit ledger (already exportable), certification SLAs — custom pricing, target $500–2k/mo/team.

---

## 5. Monetization architecture (the full stack)

| Stream | Model | Illustrative Year-1 exit run-rate* |
|---|---|---|
| Solo subscription (Companion + certified library) | $12/mo; 2,000 subs | $288k ARR |
| TeamSync seats | $10/seat/mo; 150 teams × 5 seats | $90k ARR |
| Marketplace take (20%) | $50k/mo GMV | $120k ARR |
| Certification fees (store listings + external "certify my skill") | 30/mo × $250 avg | $90k ARR |
| Enterprise (SSO, relay, compliance, audit contracts) | 10 contracts × $1k/mo | $120k ARR |
| **Total illustrative** | | **~$700k ARR exit rate** |

\* Clearly labeled assumptions, not forecasts — the point is the *shape*: four independent revenue lines, three of them recurring, none dependent on winning the chat window.

**Cost structure stays lean because:** reviewers are paid in points (product, not cash); LLM costs for the testing gauntlet are pass-through via creator deposits; BYOK means you don't fund user token burn; infra is one Hono/MySQL stack you already run.

---

## 6. Phased roadmap with validation gates

### Phase 0 (Weeks 1–6) — "Prove the pipe"
Build the Companion MCP server (remote, OAuth), Stripe billing, and the **"Export as MCP server"** button on pipelines. Recruit 20 power users who each run one DeeWaanAI pipeline from **two different desktop apps**.
- **Gate:** ≥15 of 20 activate; ≥2 desktop apps represented; ≥30% week-2 retention. This is the highest-signal experiment and reuses ~90% existing infra.

### Phase 1 (Weeks 6–14) — "Prove the store"
Relaunch marketplace as the cross-app certified store; public certification-report pages; seed 30 creator listings (recruit from prompt-engineering communities; waive deposits for the first cohort); seed reviewer pool via the points economy.
- **Gate:** ≥10 sales/week GMV; ≥3 creators earning; Kappa pipeline holding (auto-approval precision vs. spot audits).

### Phase 2 (Weeks 10–18, overlapping) — "Prove the team"
TeamSync beta with 5–10 genuinely mixed-app teams (AI agencies, research groups, OSS maintainer teams — they already suffer heterogeneity). Ship shared memory + cross-app handoffs first; those are the magic moments.
- **Gate:** ≥40% of invited teammates activate; ≥3 cross-app handoffs/team/week; 1 team converts to paid without being asked.

### Phase 3 (Months 5+) — "Prove the enterprise"
Certification-as-a-service for external skills + enterprise audit/compliance contracts. Hire/contract the first solutions engineer.

**Kill criteria honesty:** if Phase 0 fails activation, the MCP bridge thesis is wrong → fall back to Pivot C (pure certification authority) which needs no desktop integration at all.

---

## 7. Repositioning checklist (messaging)

- Homepage: from "AI swarm platform" → **"Build, certify, and sell AI skills that run in every desktop app."**
- Lead with the demo that reframes you permanently: *one listing, running in Claude Desktop, ChatGPT, and Kimi, with the certification badge visible.*
- Publish your certification methodology (it's Kappa-based and genuinely rigorous — publish it; transparency *is* the trust product).
- Neutrality must be contractual: a public "we will never favor a provider" charter + open scoring data.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Providers restrict/duplicate MCP | MCP is an open spec endorsed by all four majors; keep a REST + browser-extension fallback; your certification/marketplace value doesn't depend on any single host |
| Reviewer-supply chicken-and-egg | AI-ensemble-only "Silver" badge first; human-reviewed "Gold" badge as premium; points economy bootstraps supply at zero cash cost |
| Marketplace supply drought | Certification deposit waiver for cohort 1; guarantee featured placement; let creators import existing GPTs/skills as draft listings |
| "Feature, not product" | The wedge is authoring + certification + team fabric, not runtime — keep de-emphasizing standalone chat |
| Token-cost exposure | BYOK default; managed keys only at markup; per-tier run caps (your tiers already gate LLM counts 1→3) |

---

## 9. Next 30 days (concrete)

1. **Week 1:** Stand up remote MCP server skeleton mapping 5 tools (`run_pipeline`, `list_my_skills`, `project_context`, `run_status`, `approve_step`) to existing tRPC procedures; OAuth tokens via your JWT infra.
2. **Week 2:** Test end-to-end from Claude Desktop + ChatGPT Developer Mode + Qwen Code (all three verified MCP-capable today); write the one-page "connect your app" guide per desktop app.
3. **Week 3:** Stripe integration; free/Solo/Team plans; reuse `vouchers` for beta invites; flip the feature-flag system to gate Companion access.
4. **Week 4:** Recruit the 20-user pilot from mixed-app teams; instrument the North Star metric: **weekly cross-app pipeline runs**.

**North Star:** weekly pipeline runs executed from a provider desktop app through DeeWaanAI. Everything else is a lagging indicator.
