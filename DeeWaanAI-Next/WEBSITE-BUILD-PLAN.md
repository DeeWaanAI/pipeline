# Website Build Plan — implementation plan for WEBSITE-SPEC.md

Status: PLAN ONLY — no code written yet. Awaiting owner go.
Source spec: `DeeWaanAI-Next/WEBSITE-SPEC.md` (self-contained; copy + API contract + SEO + DoD frozen).

## Spec review (findings that shape the plan)

1. **Spec is build-ready.** Copy, page list, API contract, i18n architecture, and definition-of-done are all pinned. No design ambiguity except: accent color (pick electric teal/cyan), font (Inter, self-hosted), OG image approach.
2. **`site/` lives in the same repo** (`youssef-hariri/deewaanai`), deployed as a **second Railway service** with root directory `site/`. CI (`.github/workflows/ci.yml`) must be path-filtered so site-only changes don't run the app suite and vice versa.
3. **Waitlist backend is marked "built separately"** — the natural home is the main app (`api/waitlist-route.ts`, Hono, like `backup-route.ts`): `POST /api/waitlist/join` + `GET /api/waitlist/count`, new `waitlist_entries` table, `checkRateLimitAsync` on join, referral codes, position = row order. Small, self-contained, reuses existing infra. **Owner decision needed: build it (recommended) or stub with mock.**
4. **DoD item "adding a test locale produces working routes with zero code edits"** is the riskiest requirement — i18n architecture must be proven with a throwaway `xx` locale at the end, then removed.
5. **Placeholders stay placeholders** (`{{COMPANY_LEGAL_NAME}}` etc.) collected in `site/src/config.ts` — same discipline as the app's COMMERCIAL.md: never invent values.
6. Execution constraint: no subagent workers available reliably (quota failures observed) — waves execute **inline, sequentially**, in the disjoint file scopes below so a future parallel retry stays possible.

## Wave plan (disjoint file scopes)

### Wave 0 — Owner decisions (before any code)
- [ ] Waitlist backend: build in main app now? (recommended — small)
- [ ] Accent color final pick (suggest electric cyan `#22d3ee` family on near-black)
- [ ] Confirm `site/` in same repo vs separate repo (recommend same repo, path-filtered CI)

### Wave 1 — Foundation (blocks everything else)
Scope: `site/package.json`, `astro.config.mjs`, `tsconfig.json`, `tailwind.config.*`, `src/config.ts` (all placeholders), `src/layouts/Base.astro`, `src/components/{Header,Footer,LanguageSwitcher}.astro`, `src/i18n/` (locale helpers + `ui/en.json` string loader), `src/styles/`.
- Astro static output, `@astrojs/tailwind`, `@astrojs/sitemap` with i18n options
- i18n routing: `defaultLocale: 'en'`, unprefixed EN; content collections locale-scoped (`src/content/{docs,blog}/en/…`); UI strings in `src/content/ui/en.json`; EN-fallback helper ("not yet translated" note); RTL-safe Tailwind (logical properties only)
- Base layout: SEO head partial (title/description/canonical/OG/Twitter/hreflang slots), semantic landmarks, dark theme tokens, self-hosted Inter, sticky header, footer with switcher (hidden at 1 locale)
- Gate: `npm run build` green with one stub page

### Wave 2 — Landing page (the main build)
Scope: `src/pages/index.astro`, `src/components/landing/*` (Hero, WorksWith, HowItWorks, TrustSection, Audiences, Waitlist, Faq), `src/scripts/waitlist.ts` (only JS besides nav toggle), `public/media/` poster placeholder.
- All §4 sections with spec copy verbatim, strings via `ui/en.json`
- Waitlist: fetch POST join / GET count per §6 contract; graceful degradation (no env → disabled form + fallback email; count fail → "Limited to 100 spots"); `?ref=` → hidden field + localStorage persistence; success state with position, referral URL, copy button, X/LinkedIn share links; sessionStorage 10-min count cache
- FAQ as native `<details>`; JSON-LD: Organization + SoftwareApplication + FAQPage
- Demo video `<video poster>` with styled missing-file placeholder
- Gate: build green; JS budget check (< 15 KB gzip); manual mock-endpoint test documented

### Wave 3 — Content pages
Scope: `src/pages/connect.astro`, `src/pages/trust.astro`, `src/pages/blog/*`, `src/pages/{terms,privacy,404}.astro`, `src/content/blog/en/*.md`, `src/layouts/{Article,Legal}.astro`.
- /connect: MCP URL copy block + 5 `<details>` client guides
- /trust: 800–1200-word GEO article (H2/H3, quotable, no hype)
- /blog: index + one stub post, Article JSON-LD
- /terms + /privacy: skeletons with `{{COMPANY_LEGAL_NAME}}` + `<!-- LEGAL REVIEW REQUIRED BEFORE LAUNCH -->`, beta/assignment/IP/acceptable-use clauses
- Gate: build green, unique titles/descriptions everywhere

### Wave 4 — Docs manual
Scope: `src/layouts/Docs.astro` (sidebar nav + "on this page"), `src/content/docs/en/*.md` (7 pages), `src/pages/docs/[...slug].astro`.
- 7 pages per §5.4, task-oriented style, `<!-- SYNC-WITH: helpContent.ts -->` marker, chained "Next:" links
- TechArticle JSON-LD + hreflang alternates
- Gate: build green; sidebar + anchors verified

### Wave 5 — SEO/GEO infra + deploy
Scope: `public/robots.txt`, OG image (`public/og.png` — generated dark/wordmark/tagline static asset), `site/Dockerfile`, `site/Caddyfile`, `site/README.md`, `.github/workflows/ci.yml` path filters.
- robots.txt explicit-allow AI crawlers (GPTBot, ClaudeBot, Claude-Web, PerplexityBot, Google-Extended, CCBot) + sitemap ref
- Caddy: static serve, `try_files` clean URLs, gzip/zstd, hashed-asset long cache, `$PORT`
- Gate: container boots locally, serves all routes, headers correct

### Wave 6 — Definition-of-done verification
- [ ] build zero warnings; all routes render statically
- [ ] **i18n proof:** copy `en` content to throwaway `xx` locale → `/xx/...` routes + switcher + hreflang work with ZERO code edits → then remove `xx`
- [ ] 7 docs pages: sidebar, chained Next links, TechArticle JSON-LD
- [ ] Waitlist against mock + degraded-without-env; `?ref=abc123` survives navigation
- [ ] FAQ JSON-LD structure validates; sitemap + robots correct
- [ ] No client framework; JS < 15 KB gz; dark theme 360px→1440px+
- [ ] Lighthouse: perf ≥ 95, SEO 100, a11y ≥ 95 (on the container, not dev server)
- [ ] Update PROGRESS.md; commit; hand Railway setup steps to owner

### (Parallel, main app) Wave W — Waitlist backend [if approved]
Scope: `api/waitlist-route.ts`, `db/migrations/015_waitlist.sql` (`waitlist_entries`: id, email UNIQUE, role, ref, referral_code UNIQUE, created_at; position = id-ordered rank), mount in `api/boot.ts`, tests.
- `POST /api/waitlist/join` — validate, dedupe (409 already_joined with position+code), insert, return `{position, referralCode}`; rate-limited via `checkRateLimitAsync`
- `GET /api/waitlist/count` — `{claimed}` with short CDN cache headers
- Gates: tsc + tests + boot smoke; prod migration applied via Railway query tab (drizzle explicit-column pitfall — migrate before deploy)
- i18n server messages for errors (en/zh)

## Ordering
Wave 0 (decisions) → Wave 1 → Waves 2–4 (sequential inline, independent scopes) → Wave 5 → Wave 6. Wave W can run any time after Wave 0, independently.

## Risks / notes
- **Lighthouse on Railway container locally** (Docker run + lighthouse CLI) — dev-server scores are meaningless.
- **OG image**: generate at build time via a tiny script (satori or sharp) or ship a designed static PNG; decide in Wave 1.
- **helpContent.ts sync**: docs copy is a first draft by design; wording sync is a later, separate task.
- **No auto-redirect locale detection** — URL-only, per spec (GEO-friendly).
