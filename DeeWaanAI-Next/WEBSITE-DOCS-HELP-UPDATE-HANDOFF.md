# WEBSITE-DOCS-HELP-UPDATE — Handoff for the coding team (Handoff #2)

> **Read first:** [`WEBSITE-FEATURES-UPDATE-HANDOFF.md`](./WEBSITE-FEATURES-UPDATE-HANDOFF.md)
> (Handoff #1) covers the **landing page** marketing copy. This Handoff #2 covers the
> **documentation**: the website **user manual** and the **in-app help catalog**. They
> are separate so the team already working on Handoff #1 is not blocked.

**Goal:** Document the four new capabilities — **Batch runs (Research Mode)**,
**Pipeline chaining**, **TeamSync**, and **Marketplace trust / AI triage** — in:
- **Surface A — the website user manual** (`site/src/content/docs/en/*.md`), and
- **Surface B — the in-app help catalog** (`api/mcp/tools/helpContent.ts`, surfaced by
  the `deewaanai_help` MCP tool).

These two surfaces are **deliberately kept in sync** — the manual pages carry a
`<!-- SYNC-WITH: helpContent.ts -->` marker. Tool names and grouping must match across
both. The headline TeamSync point to convey everywhere: **teammates collaborate on the
same shared pipelines while each works in their own LLM desktop app** (Kimi, Claude,
Cursor — anything MCP-compatible), each using their own provider (BYOK).

---

## 0. Coordination with Handoff #1 (avoid merge conflicts)

| Handoff | Files touched |
|---|---|
| #1 (landing) | `site/src/content/ui/en.json` → **`landing.*`** keys; `site/src/pages/[...locale]/index.astro` |
| #2 (this one) | `site/src/content/docs/en/*.md`; `site/src/content/ui/en.json` → **`docsNav.*`** keys; `api/mcp/tools/helpContent.ts` + its test |

The **only shared file is `en.json`**, and the two handoffs edit **different top-level
keys** (`landing` vs `docsNav`) — no semantic conflict, just merge both key sets.
Unlike Handoff #1, **this handoff includes a small backend change** (`helpContent.ts`).

---

## Surface A — Website user manual

### A1. Two NEW manual pages

Docs are an Astro content collection (`site/src/content.config.ts`, collection `docs`).
Each page is markdown with YAML frontmatter `{ title, description, order }`; the nav is
sorted by `order`. Only the `en` locale exists — write English only (other locales fall
back to EN automatically).

**Create `site/src/content/docs/en/research-mode.md`** (`order: 3`):

```markdown
---
title: "Research Mode: batch runs & chaining"
description: "Run up to 100 inputs in parallel with batch runs, and chain one pipeline's output into another — built for experiments and large-scale evaluation."
order: 3
---

<!-- SYNC-WITH: helpContent.ts -->
```

Suggested body outline (write in the existing manual's plain, task-oriented voice):
1. **What Research Mode is** — batch runs + pipeline chaining, available behind a feature
   flag (ask for early access).
2. **Batch runs** — `run_batch` (1–100 inputs in one call), poll `batch_status`,
   `resume_batch` after a provider outage, `export_batch_results` to CSV. Use case:
   running the same pipeline over a dataset.
3. **Pipeline chaining** — pass `chain: { targetProjectId, inputTemplate }` on
   `run_pipeline` / `run_batch`; on success the final output is rendered into
   `inputTemplate` (supports `{{finalResponse}}` and `{{originalInput}}`) and fed into the
   target pipeline. Example: generation pipeline → evaluation pipeline in one submission.
4. **Guardrails** — chain depth capped at 3; cycles and cross-user targets are blocked;
   failed runs never chain.

**Create `site/src/content/docs/en/teams.md`** (`order: 4`):

```markdown
---
title: "Teams (TeamSync)"
description: "Create a team, invite members, and collaborate on shared pipelines, context, and skills — with each member working in their own LLM desktop app."
order: 4
---

<!-- SYNC-WITH: helpContent.ts -->
```

Suggested body outline:
1. **What TeamSync is** — a shared workspace for pipelines, agents, context/memory, and
   skills, with roles (owner / admin / member). Available behind the `teamsync` flag.
2. **The headline: any app, any provider.** DeeWaanAI is an MCP server, so each teammate
   connects their **own** chat client — Kimi desktop, Claude desktop, Cursor, or any
   MCP-compatible app — and everyone works on the **same** shared pipelines. Each member
   uses their own configured providers (BYOK); DeeWaanAI keeps the team's context and runs
   in sync. *(Make this prominent — it is the differentiator.)*
3. **Create & join** — create a team (you become owner), share the invite code, members
   join by code.
4. **Collaborate** — shared context (`team_context_get`, `team_memory_append`), shared
   runs (`team_runs_list`, `team_run_resume`), handoff (`team_handoff`), feedback
   (`team_feedback_submit`), shared skills (`team_skills_list`, `team_skill_use`).
5. **Share pipelines** — share a project you own to the team; teammates can view and
   import its pipelines/agents.

### A2. Renumber existing pages + cross-link

Insert the two new pages after **Creating & running pipelines**. Final nav order:

| order | page | note |
|---|---|---|
| 1 | `index.md` (Quickstart) | unchanged |
| 2 | `pipelines.md` (Creating & running pipelines) | **add a short "Chaining" cross-link** to `/docs/research-mode` |
| 3 | `research-mode.md` | **NEW** |
| 4 | `teams.md` | **NEW** |
| 5 | `providers.md` (Models & API keys) | bump from 3 |
| 6 | `selling.md` (Selling on the marketplace) | bump from 4 |
| 7 | `buying.md` (Discovering & buying) | bump from 5 |
| 8 | `reviewing.md` (Being a reviewer) | bump from 6 |
| 9 | `troubleshooting.md` (Troubleshooting) | bump from 7 |

### A3. Add nav labels to `en.json` → `docsNav`

`site/src/content/ui/en.json` → `docsNav` currently has keys: `quickstart, pipelines,
providers, selling, buying, reviewing, troubleshooting, …`. Add labels for the new pages
(the docs nav renders these):

```jsonc
"researchMode": "Research Mode: batch & chaining",
"teams": "Teams (TeamSync)",
```

> Verify how the docs nav maps `docsNav` keys to slugs (see `site/src/layouts/Docs.astro`
> and the `nav` prop built in `site/src/pages/[...locale]/docs/[...slug].astro` — the nav
> is actually generated from the collection entries' `title`, so the new pages appear
> automatically; the `docsNav` labels above are for any hardcoded nav references). Confirm
> which mechanism is used and update accordingly.

---

## Surface B — In-app help catalog (`api/mcp/tools/helpContent.ts`)

The catalog (`HELP_CATALOG`) currently lists every MCP tool **except** the Research Mode
tools. The Team tools (8) are already present with `flag: "teamsync"`. Add the missing
batch/export tools.

### B1. Add a "Research" group

- `HelpCatalogEntry["group"]` union (L9): add `"Research"`.
- `GROUP_ORDER` (L43–45): insert `"Research"` after `"Run"`:
  `["Discover", "Run", "Research", "Author", "Marketplace", "Account", "Your data", "Team", "Diagnostics"]`.

### B2. Add catalog entries (after the `run_status` / `approve_step` "Run" entries)

```ts
{ name: "run_batch", group: "Research", scopes: ["mcp:run"], flag: "batch_mode",
  summary: "Start a batch of 1–100 pipeline runs in parallel. Returns immediately — poll batch_status. Supports chaining to a target project on completion." },
{ name: "batch_status", group: "Research", scopes: ["mcp:read"], flag: "batch_mode",
  summary: "Check a batch's progress: queued/running/completed/failed counts and member runs." },
{ name: "resume_batch", group: "Research", scopes: ["mcp:run"], flag: "batch_mode",
  summary: "Resume a paused or partially-failed batch from where it stopped." },
{ name: "export_batch_results", group: "Research", scopes: ["mcp:read"], flag: "batch_mode",
  summary: "Export all of a batch's run results as CSV for analysis." },
{ name: "export_run", group: "Research", scopes: ["mcp:read"],
  summary: "Export one run's full granular history (every step, prompt, token count, and response) as portable JSON." },
```

- `flags` in `BuildHelpInput` is `Record<string, boolean>` (L22), so `flag: "batch_mode"`
  needs **no interface change**. **But** confirm the `deewaanai_help` tool handler resolves
  the `batch_mode` flag into the `flags` map it passes to `buildHelp` (add it alongside
  `teamsync` / `mcp_sampling` if missing).
- Also extend the `run_pipeline` (and the new `run_batch`) summaries to mention chaining,
  e.g. append: "Optionally chain the output into another project via the `chain` parameter."

### B3. UPDATE THE TEST — `api/mcp/tools/helpContent.test.ts`

This is mandatory; the build/CI will fail otherwise:
- **L124** asserts the exact group list — add `"Research"` in the right position:
  ```ts
  expect(groups).toEqual(["Discover", "Run", "Research", "Author", "Marketplace", "Account", "Your data", "Team", "Diagnostics"]);
  ```
- The `base()` helper passes `flags: { teamsync, mcp_sampling }` — add `batch_mode` so
  Research tools can be exercised.
- Add a test mirroring the existing teamsync one (L47–51): Research tools appear only when
  `batch_mode` is on:
  ```ts
  it("includes research tools only when the batch_mode flag is on", () => {
    const off = buildHelp(base({ flags: { teamsync: false, mcp_sampling: false, batch_mode: false } }));
    expect(toolNames(off)).not.toContain("run_batch");
    const on = buildHelp(base({ flags: { teamsync: false, mcp_sampling: false, batch_mode: true } }));
    expect(toolNames(on)).toContain("run_batch");
  });
  ```
- Keep the existing assertion that every entry `summary.length > 10` (L148) — the new
  summaries satisfy it.

---

## Copy & accuracy guardrails (both surfaces)

- These features are **flag-gated / beta**. Write "available behind a feature flag — ask
  for early access," never "enabled for everyone."
- TeamSync cross-app claim is accurate (provider-agnostic MCP server + per-user BYOK +
  shared workspace). Say "works with any MCP-compatible app (Kimi, Claude, Cursor, …)";
  do **not** claim a specific app is officially integrated.
- Batch limit **1–100 inputs**; chain depth **≤ 3**; failed runs never chain.
- Match the existing manual's voice: plain, task-oriented, second person ("Ask your
  chat…", "Poll batch_status…").

---

## Build & verify

```bash
# Surface A — site (Astro build fails on missing i18n keys / bad frontmatter)
cd site && npm install && npm run build && npm run preview

# Surface B — help catalog unit tests
npx vitest run api/mcp/tools/helpContent.test.ts
# plus a typecheck of the server project
npx tsc --noEmit -p tsconfig.server.json
```

**Verify:**
- [ ] `/docs` nav shows the two new pages in the correct position (order 3 & 4).
- [ ] `/docs/research-mode` and `/docs/teams` render; TechArticle JSON-LD present.
- [ ] `pipelines.md` cross-links to research-mode.
- [ ] `deewaanai_help` (with `batch_mode` on) shows a **Research** section with the 5 tools;
      with the flag off, they are hidden.
- [ ] `helpContent.test.ts` passes (group list + new batch_mode test).
- [ ] `npm run build` (site) and `tsc --noEmit` pass with zero errors.

---

## Definition of Done

1. Two new manual pages (`research-mode.md`, `teams.md`) + renumbered orders + pipelines
   cross-link + `docsNav` labels.
2. `helpContent.ts` has a **Research** group with 5 new entries (batch ×4 + export_run),
   `batch_mode` flag wired into the `deewaanai_help` handler, run_pipeline/run_batch
   summaries mention chaining.
3. `helpContent.test.ts` updated (group list L124, base() flags, new batch_mode test) and
   passing.
4. Site build + server typecheck + vitest all green; preview verified on desktop + mobile.
5. Copy obeys the guardrails above. PR includes screenshots of the two new docs pages and
   a sample `deewaanai_help` output showing the Research section.

---

## Source-of-truth references

- Research Mode (batch + chaining semantics, guards): `DeeWaanAI-Next/RESEARCH-MODE-SPEC.md`.
- Batch MCP tools: `api/mcp/tools/runBatch.ts`, `batchStatus.ts`, `resumeBatch.ts`,
  `exportBatchResults.ts`; granular export `exportRun.ts`.
- TeamSync: `api/routers/team.ts` + `api/mcp/tools/team/*`; `DeeWaanAI-Next/TEAM-FEATURE-TEST-SPEC.md`.
- Help catalog + test: `api/mcp/tools/helpContent.ts`, `api/mcp/tools/helpContent.test.ts`.
- Docs collection schema: `site/src/content.config.ts`; loader `site/src/i18n/content.ts`.
- Feature flags (names): `api/plugins/featureFlags.ts` (`batch_mode`, `pipeline_chaining`,
  `teamsync`, `marketplace_ai_triage`).
