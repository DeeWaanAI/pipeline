# WEBSITE-FEATURES-UPDATE — Handoff for the coding team

**Goal:** Update the marketing site (`site/`) to advertise four newly-built platform
capabilities: **Batch runs (Research Mode)**, **Pipeline chaining**, **TeamSync**, and
**Marketplace trust / AI triage**. The headline differentiator to emphasize is that
**TeamSync lets teammates collaborate while each works in their own LLM desktop app**
(one on Kimi, one on Claude, one on Cursor…) on the same shared workspace.

**Owner note:** All four features are implemented and flag-gated (`batch_mode`,
`pipeline_chaining`, `teamsync`, `marketplace_ai_triage`). Phrase them as available /
in beta — do **not** imply they are on by default for every user.

---

## 1. How the site is built (read this first)

- **Astro** marketing site in `site/`. Scripts: `npm run dev` / `npm run build` /
  `npm run preview` (run from inside `site/`).
- **All copy lives in JSON, not in the layouts.** The single source of truth is
  `site/src/content/ui/en.json`. Layouts (`site/src/pages/[...locale]/index.astro`, etc.)
  are generic templates that render whatever the JSON provides — they contain **no**
  hardcoded marketing text.
- `site/src/i18n/ui.ts` auto-discovers bundles via `import.meta.glob`. The TypeScript
  type `UiStrings = typeof en` means **adding a key to `en.json` automatically extends
  the type** — no other wiring needed.
- **Only the `en` locale exists today** (`LOCALES = ["en"]` in `src/i18n/locales.ts`,
  only `en.json` in `src/content/ui/`). You only need to edit `en.json`. The
  architecture already supports more locales later (drop a `<locale>.json` in place).
- Existing landing sections (in render order): `hero` → `worksWith` → `howItWorks`
  (3 steps) → `trust` (3 layers) → `audiences` (creators/users bullets) → `waitlist`
  (Pioneer 100) → `faq` (7 items).

**Rule of thumb:** most of this task is editing `en.json`. You touch `index.astro`
only once — to add the new Features section (§2.1).

---

## 2. Changes to make (best-practice placement)

### 2.1 NEW — dedicated "Features" section on the landing page (primary change)

Four substantial features deserve their own section rather than being buried. Add a
`features` block to `en.json` under `landing`, and render it in `index.astro`.

**JSON to add** (`site/src/content/ui/en.json` → inside `"landing"`):

```jsonc
"features": {
  "title": "Built for serious work, not just demos",
  "intro": "Everything below ships today behind a feature flag — ask for early access.",
  "items": [
    {
      "title": "Batch runs (Research Mode)",
      "body": "Run up to 100 inputs through a pipeline in one go. Live progress, pause/resume on provider outages, and one-click CSV export — built for experiments, evaluations, and large-scale jobs."
    },
    {
      "title": "Pipeline chaining",
      "body": "Feed one pipeline's output straight into another. Generation → evaluation → review becomes a single submission, with depth and cycle guards so chains never run away."
    },
    {
      "title": "TeamSync — your team, any app",
      "body": "Share pipelines, context, and skills with your team. Each member works in their own LLM desktop app — Kimi, Claude, Cursor, anything MCP-compatible — on the same shared workspace. Bring your own provider; DeeWaanAI keeps the team in sync."
    },
    {
      "title": "Marketplace trust",
      "body": "Every public pipeline passes a deterministic security scan and platform-model AI triage before certification. Fail-closed by design: if anything errs, the listing stops."
    }
  ]
}
```

**Layout to add** (`site/src/pages/[...locale]/index.astro`): insert a new `<section>`
between the **How it works** section (§4.4) and the **Trust** section (§4.5). Model it
on the existing `trust` grid (3-col responsive card grid). Suggested markup pattern
(copy the `trust` section's structure and swap the data source to `l.features`):

```astro
{/* ── Features ── */}
<section id="features" aria-labelledby="features-title" class="border-t border-ink-800 py-20">
  <div class="container-page">
    <h2 id="features-title" class="text-center text-3xl font-bold text-white">{l.features.title}</h2>
    <p class="mx-auto mt-4 max-w-xl text-center text-neutral-400">{l.features.intro}</p>
    <div class="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
      {l.features.items.map((f) => (
        <article class="card">
          <h3 class="text-base font-semibold text-white">{f.title}</h3>
          <p class="mt-3 text-sm leading-6 text-neutral-400">{f.body}</p>
        </article>
      ))}
    </div>
  </div>
</section>
```

> 4 cards → `lg:grid-cols-4` on wide screens, `md:grid-cols-2` on tablet, stacked on
> mobile. Use the existing `.card` utility class so styling matches the rest of the page.

### 2.2 Update the "works-with" strip to support the cross-app team story

Current: `landing.worksWith.badges = ["Claude", "ChatGPT", "Cursor", "Any MCP client"]`,
caption `"DeeWaanAI runs as an MCP server. One URL, pasted once."`

- **Add `Kimi`** to the badges array (the team feature's flagship example). Consider:
  `["Claude", "ChatGPT", "Kimi", "Cursor", "Any MCP client"]`.
- Optionally tweak the caption to hint at teams, e.g.
  `"DeeWaanAI runs as an MCP server. One URL, pasted once — per teammate, in any app."`

### 2.3 Weave the features into the two-audiences section

`landing.audiences.creators.bullets` and `landing.audiences.users.bullets` (3 each today).
Add or replace bullets so the new capabilities are visible without scrolling to the new
section. Suggestions:

- **users.bullets** add: `"Run batches of up to 100 inputs and chain pipelines end-to-end."`
- **users.bullets** add: `"Work as a team — everyone in their own AI app, on shared pipelines."`
- **creators.bullets** add: `"Sell batch-ready, chainable pipelines to research and ops teams."`

(Keep each bullet ≤ ~90 characters to match the existing voice.)

### 2.4 Add FAQ entries

`landing.faq.items` (7 today). Add 2–3 items, e.g.:

```jsonc
{ "q": "Can my team use different AI apps?",
  "a": "Yes. DeeWaanAI is an MCP server, so each teammate connects their own client — Kimi, Claude, Cursor, or any MCP-compatible app — and collaborates on the same shared pipelines and context." }

{ "q": "What is Research Mode?",
  "a": "Research Mode adds batch runs (up to 100 inputs in parallel) and pipeline chaining (feed one pipeline's output into another). It's available now behind a feature flag — request early access." }
```

### 2.5 SEO / structured data

`index.astro` builds JSON-LD (`SoftwareApplication`). Add a `featureList` so the four
capabilities are machine-readable:

```js
featureList: l.features.items.map((f) => f.title),
```

Also consider updating `landing.metaDescription` and `landing.hero.subline` to mention
"batch runs, pipeline chaining, and team collaboration" if it reads naturally — do not
stuff keywords.

---

## 3. Copy & voice guidelines

- Match the existing tone: confident, concrete, no hype. Short sentences. Benefit first.
- Every feature card body ≤ ~220 characters.
- **Accuracy guardrails (important):**
  - These features are **flag-gated / beta**. Use "available behind a feature flag",
    "ask for early access", "in beta" — never "enabled for everyone".
  - TeamSync cross-app claim is accurate because DeeWaanAI is a provider-agnostic MCP
    server (any MCP client connects) + per-user BYOK providers + a shared team workspace.
    Do not claim a specific desktop app is "officially integrated" — say "works with any
    MCP-compatible app (Kimi, Claude, Cursor, …)".
  - Batch limit is **1–100 inputs** per batch. Chaining depth is capped at **3**.

---

## 4. i18n checklist

- [ ] Edit `site/src/content/ui/en.json` (the only bundle that exists).
- [ ] Because `UiStrings = typeof en`, new keys are typed automatically — the
      `index.astro` references (`l.features.*`) will type-check once the JSON has them.
- [ ] If/when other locales are added later, the same keys must be translated; missing
      keys fall back to EN and show a "not yet translated" note (never a 404). Nothing to
      do now beyond `en.json`.

---

## 5. Build, preview, verify

```bash
cd site
npm install        # if not already
npm run dev        # local preview → http://localhost:4321
npm run build      # production build (must succeed with zero errors)
npm run preview    # preview the production build
```

**Verify:**
- [ ] `npm run build` passes (Astro will fail the build on any missing i18n key or type
      error — this is your safety net).
- [ ] New **Features** section renders with 4 cards, responsive (4/2/1 columns).
- [ ] Works-with strip shows Kimi.
- [ ] New FAQ items expand/collapse (native `<details>`, no JS).
- [ ] No layout shift / styling drift — new section uses existing `.card`, `.container-page`,
      `border-ink-800` utilities.
- [ ] Run the project i18n integrity check if present: `node scripts/check-i18n.cjs`
      (from repo root) — confirms en.json keys are well-formed.
- [ ] Lighthouse/axe sanity: the new section has a labelled heading (`aria-labelledby`).

---

## 6. Definition of Done

1. `en.json` has `landing.features` (4 items) + updated `worksWith.badges` (+Kimi) +
   new audience bullets + 2–3 new FAQ items.
2. `index.astro` renders the new Features section between How-it-works and Trust, plus
   the JSON-LD `featureList`.
3. `npm run build` succeeds with zero errors; preview looks correct on desktop + mobile.
4. Copy obeys the accuracy guardrails in §3 (beta/flag-gated phrasing, no overclaim).
5. PR includes a screenshot of the new section (desktop + mobile) and a link to the
   preview deployment.

---

## 7. Files touched (summary)

| File | Change |
|---|---|
| `site/src/content/ui/en.json` | add `landing.features`; update `worksWith.badges`/caption; add audience bullets; add FAQ items; optional hero/meta tweak |
| `site/src/pages/[...locale]/index.astro` | add Features `<section>`; add JSON-LD `featureList` |

No backend changes. No new dependencies. No new locales.

---

## 8. Source-of-truth references (for accurate copy)

- Batch runs + chaining spec: `DeeWaanAI-Next/RESEARCH-MODE-SPEC.md` (Feature A `runBatch`,
  Feature B Pipeline chaining; guards in §4.2; 1–100 inputs; depth ≤ 3).
- TeamSync: `api/routers/team.ts` + `api/mcp/tools/team/*` (team_context_get,
  team_memory_append, team_feedback_submit, team_handoff, team_runs_list,
  team_run_resume, team_skills_list, team_skill_use); test spec
  `DeeWaanAI-Next/TEAM-FEATURE-TEST-SPEC.md`.
- Marketplace trust: `DeeWaanAI-Next/MARKETPLACE-TRUST-SPEC.md`; flag
  `marketplace_ai_triage`.
- Feature flags (names/descriptions): `api/plugins/featureFlags.ts`.
- MCP-agnostic / one-URL positioning already on the site: `landing.worksWith`.
