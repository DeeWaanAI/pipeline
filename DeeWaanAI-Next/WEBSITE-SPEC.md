# DeeWaanAI Marketing Website — Build Instructions

> Self-contained spec. Paste this entire document into a coding agent/chat.
> It contains everything needed: context, stack, structure, copy, API contract, SEO/GEO requirements, and deployment.

---

## 1. Context (read first)

**Product:** DeeWaanAI — a marketplace for AI pipelines (multi-step LLM workflows). Its differentiator: **every listed pipeline is certified through a 3-layer trust process** (automated security scan → AI triage → blind human review). Users interact with the product **from inside their existing LLM chat clients** (Claude, ChatGPT, Cursor, any MCP-compatible client) by connecting to DeeWaanAI's MCP server — there is no separate app to learn.

**This website's job:** the product is invisible (it lives inside chats), so the site must (1) make it visible with a demo video, (2) explain the trust/certification story, (3) convert visitors into "Pioneer 100" beta-waitlist signups with a referral loop, and (4) be maximally readable by search engines AND AI assistants (GEO/AEO — we want LLMs to cite this site).

**Status:** product is in private beta ("Pioneer 100" program). No public pricing. Everything free during beta.

**Brand:** "DeeWaanAI" — text wordmark only (no logo yet). Always render the name exactly as `DeeWaanAI`. Use `DeeWaanAI™` in the footer notice. The site is operated by a UK company (placeholder: `{{COMPANY_LEGAL_NAME}}`).

---

## 2. Tech stack & constraints

- **Framework:** Astro (latest), **fully static output** (`output: 'static'`). No SSR.
- **Styling:** Tailwind CSS (via `@astrojs/tailwind`).
- **JS budget:** near-zero. Plain HTML/CSS wherever possible. The ONLY client-side JS allowed: (a) the waitlist form submit, (b) the Pioneer spots counter fetch, (c) mobile nav toggle. No React/Vue on this site. No analytics scripts for v1.
- **Language:** English content only for v1, but the site MUST be built i18n-ready from day one (see §5.5): locale-prefixed routing, translations in per-locale content files, no hardcoded strings inside layout components. Adding a language later must require only adding content files — zero code changes.
- **Repo location:** create as a standalone `site/` directory with its own `package.json` (it will be deployed as a separate service).
- **Design direction:** modern developer-tool aesthetic. Dark theme base (near-black background, high-contrast text), one accent color (electric teal/cyan suggested — pick one and use it consistently), generous whitespace, monospace accents for technical elements (MCP URLs, code), subtle borders. Think Linear/Vercel-style restraint. No stock photos, no illustration clutter. System font stack or Inter.
- **Accessibility:** semantic HTML5 landmarks, WCAG AA contrast, focus states, alt text everywhere.

---

## 3. Pages

```
/            Landing page (the main build — see §4)
/connect     Setup guides per LLM client
/docs        User manual (7 pages — see §5.4)
/trust       Certification deep-dive (long-form GEO magnet)
/blog        Blog index (stub for now, list layout ready, one placeholder post)
/terms       Terms of Service (placeholder text + {{COMPANY_LEGAL_NAME}})
/privacy     Privacy Policy (placeholder text + {{COMPANY_LEGAL_NAME}})
/404         Not found
```

All content pages (`/docs/*`, `/connect`, `/trust`, blog posts, FAQ copy) live as **markdown/MDX content collections with a locale dimension** so they can be translated file-by-file (see §5.5).

---

## 4. Landing page — section by section (use this copy)

### 4.1 Header (sticky, minimal)
- Left: `DeeWaanAI` wordmark (link to `/`).
- Right nav: How it works · Trust · For creators · Blog · **[Join the Pioneer 100]** (accent button, anchors to waitlist section).

### 4.2 Hero
- **H1:** `The AI-pipeline marketplace where every pipeline is certified by blind human review.`
- **Subline:** `Create, discover, buy and sell AI workflows — from inside Claude, ChatGPT, or any MCP client. No new app to learn.`
- **Primary CTA:** `Join the Pioneer 100 →` (anchors to waitlist form)
- **Secondary CTA:** `How it works` (anchor link)
- **Demo video slot:** prominent 16:9 placeholder with poster frame and caption `Watch: using a certified pipeline inside a chat — 45 seconds.` Implement as an HTML5 `<video>` with `poster`, sourcing `/media/demo.mp4` — file will be added later; render a styled placeholder if missing.

### 4.3 "Works with" strip
- Label: `Connects to the tools you already use`
- Row of text badges (NOT logos — avoid trademark issues): `Claude` · `ChatGPT` · `Cursor` · `Any MCP client`
- Small caption: `DeeWaanAI runs as an MCP server. One URL, pasted once.`

### 4.4 How it works (3 steps, cards)
1. **Connect** — `Paste one MCP URL into your chat client. That's the whole install.`
2. **Create or discover** — `Build multi-step AI pipelines with your own prompts and models, or browse pipelines built by others.`
3. **Trust what you buy** — `Every marketplace listing passes a security scan, AI triage, and blind review by real humans before it can be sold.`

### 4.5 The trust section (differentiator — give it visual weight)
- **H2:** `Certification, not vibes.`
- Intro line: `Anyone can upload a prompt. DeeWaanAI is built for the ones worth paying for.`
- 3-layer visual (horizontal timeline or stacked cards):
  1. **Deterministic security scan** — `Code, not AI. Catches injection patterns, hidden Unicode tricks, and data-exfiltration attempts. Ungameable.`
  2. **AI triage** — `A platform-controlled model scores quality and gives creators instant feedback. It advises — it never decides.`
  3. **Blind human review** — `Independent reviewers evaluate real outputs without knowing whose pipeline it is. Only human consensus makes a listing buyable.`
- Closing line: `Fail-closed by design: if anything errs, the listing stays unpublished.` 
- Link: `Read how certification works →` (`/trust`)

### 4.6 Two audiences (side-by-side blocks)
- **For creators:** H3 `Sell your best work. Keep your IP.` — bullets: `Your secret prompts stay encrypted and are never shown to reviewers` · `Certification badge that actually means something` · `Pioneer creators lock in our best commission rate, for life`
- **For users:** H3 `Pipelines that work, in the chat you already have.` — bullets: `Every purchase is human-certified` · `Runs with your own API keys — your data goes to your providers, not ours` · `One-line setup in any MCP client`

### 4.7 Pioneer 100 (waitlist section — the conversion engine)
- **H2:** `Be one of the first 100.`
- Perks list (checkmarks): `Pioneer badge on your profile — permanent` · `Free Pro during beta and beyond` · `Lifetime discounted commission as a creator` · `3 invites to bring people you trust` · `Direct line to the founder — your feedback ships`
- **Scarcity counter:** `{N} of 100 Pioneer spots claimed` — fetched from API (§6); if the fetch fails, show `Limited to 100 spots` instead (never show an error).
- **Form:** email (required) + role select `I want to… [Build & sell pipelines / Use pipelines / Both]` + hidden `ref` field (auto-filled from `?ref=` URL param, persisted to localStorage so it survives navigation).
- Submit button: `Request my spot`
- **Success state (replaces form):** `You're in the queue at #{position}.` + `Share your link to move up: {referralUrl}` with a copy button + prewritten share links for X and LinkedIn (`Just joined the DeeWaanAI Pioneer 100 waitlist — the AI-pipeline marketplace with blind human certification. {referralUrl}`).
- Small print under form: `Free during beta. Beta perks are promotional benefits and do not constitute equity or ownership.`

### 4.8 FAQ (accordion, native `<details>` elements — no JS)
Write these exact Q&As (they double as GEO content):
1. **What is DeeWaanAI?** — `DeeWaanAI is a marketplace for AI pipelines — multi-step AI workflows you can create, buy, and sell. Every listing is certified through an automated security scan, AI triage, and blind human review before it can be purchased.`
2. **What is a certified AI pipeline?** — `A certified pipeline has passed three independent checks: a deterministic security scan of its prompts, an AI quality triage, and blind evaluation of its real outputs by multiple human reviewers who don't know who built it.`
3. **How do I use DeeWaanAI?** — `Paste the DeeWaanAI MCP server URL into any MCP-compatible client — Claude, ChatGPT, Cursor, and others. You then create and use pipelines directly from your chat.`
4. **Do I need new API keys?** — `You bring your own LLM provider keys. Your pipeline runs go to your providers under your keys — DeeWaanAI orchestrates, it doesn't intercept.`
5. **Is my pipeline IP protected if I sell it?** — `Yes. Secret prompts are encrypted, never shown to human reviewers, never used for training, and the buyer receives usage rights, not your source prompts.`
6. **What does beta cost?** — `Nothing. During beta everything is free, and marketplace listings are in free preview. Pioneer members lock in the best terms we'll ever offer for when paid launch comes.`
7. **What is the Pioneer 100?** — `Our first 100 beta members. Pioneers get a permanent badge, free Pro, a lifetime discounted creator commission, and 3 invites each. Spots are limited by our human-review capacity — the scarcity is real, not marketing.`

### 4.9 Footer
- Columns: Product (How it works, Trust, Connect guide) · Company (Blog, Terms, Privacy) · Community (Discord `{{DISCORD_URL}}`, X `{{X_URL}}`, GitHub `{{GITHUB_URL}}`).
- Legal line: `© {year} {{COMPANY_LEGAL_NAME}}. "DeeWaanAI" and the DeeWaanAI wordmark are trademarks of {{COMPANY_LEGAL_NAME}}. All rights reserved.`

---

## 5. Inner pages content

### /connect
- H1: `Connect DeeWaanAI to your chat client`
- Intro: one MCP URL placeholder shown in a copyable code block: `https://{{APP_DOMAIN}}/mcp`
- One `<details>` section per client with numbered steps (write reasonable current instructions, clearly marked as collapsible guides): **Claude Desktop**, **Claude.ai (web)**, **ChatGPT**, **Cursor**, **Generic MCP client**. Exact steps will be refined later — structure and placeholders matter more than perfection.
- End CTA back to waitlist.

### /trust
Long-form article (800–1200 words) expanding §4.5: the problem (marketplaces full of unverified prompts, self-reviewed listings, gameable AI judges), the DeeWaanAI model (3 layers, what each sees, what each decides — security scan gates visibility; AI advises only; blind human consensus gates buyability), why blind review prevents collusion, why fail-closed matters, what creators' IP protection looks like. Tone: confident, technical, no hype. H2/H3 structure, short paragraphs. This page is the primary GEO asset — write it to be quotable by AI assistants.

### /blog
Index page listing posts (title, date, 1-line excerpt). Create one placeholder post: `Building DeeWaanAI in public — why we publish our trust system` (200-word stub). Use Astro content collections so posts are markdown files.

### /docs — user manual (docs layout: left sidebar nav + content + "on this page" anchors)

Seven markdown pages. Where content overlaps with the product's built-in MCP `help` tool, the writing style should match it (task-oriented, imperative, short) — the product team will later sync exact wording from `helpContent.ts`; for now write reasonable first drafts and mark each page with a `<!-- SYNC-WITH: helpContent.ts -->` comment.

1. **/docs (index) — Quickstart:** connect in one paste → create your first pipeline by asking your chat (`"Create a pipeline that ..."`) → run it → see results. Target: first success in 5 minutes. Link prominently to /connect.
2. **/docs/pipelines — Creating & running pipelines:** what a pipeline is (ordered steps: agents, if/while control flow, approval gates), creating via natural language vs. explicit steps, running, checking run status, updating.
3. **/docs/providers — Models & API keys:** bring-your-own-keys model, adding a provider, how keys are stored (encrypted, only used to call YOUR providers), switching models per pipeline.
4. **/docs/selling — Selling on the marketplace:** listing a pipeline, setting a price, what certification involves (scan → AI triage → blind human review), what reviewers can and cannot see (never your prompts), what happens on approval/rejection.
5. **/docs/buying — Discovering & buying:** searching from chat, what the Certified badge guarantees, acquiring and running a purchased pipeline.
6. **/docs/reviewing — Being a reviewer:** how blind review works, enrolling, getting tasks, scoring honestly, why self-review is impossible.
7. **/docs/troubleshooting:** connection issues per client, auth popup problems, common errors, where to get help (Discord + feedback tool in-app).

Each page: H1 + short intro + task sections with H2s, code blocks for anything copyable, and a "Next: …" footer link chaining the pages in the order above.

### /terms and /privacy
Standard skeleton sections with `{{COMPANY_LEGAL_NAME}}` placeholders and a visible note comment `<!-- LEGAL REVIEW REQUIRED BEFORE LAUNCH -->`. Terms must include: beta terms (free preview, perks are promotional and not equity), an assignment clause (`we may assign this agreement to an affiliated entity`), IP (creators retain pipeline IP), acceptable use.

### §5.5 Multi-language architecture (build now, translate later)

- Use **Astro's built-in i18n routing**: `defaultLocale: 'en'`, `locales: ['en']` for v1 — adding `'es'`, `'hi'`, `'zh'`, `'pt'`… later must be a config-array addition plus content files, nothing else.
- **URL scheme:** English unprefixed (`/docs/selling`); other locales prefixed (`/es/docs/selling`). 
- **Content collections are locale-scoped:** `src/content/docs/en/selling.md` → later `src/content/docs/es/selling.md`. Same for blog, and extract ALL landing/connect/trust page strings + FAQ into per-locale data files (e.g. `src/content/ui/en.json`) — layout components receive strings, never contain them.
- **Fallback:** a page not yet translated in locale X renders the English version with a small "not yet translated" note — missing translations must never 404.
- **Language switcher** in the footer (hidden while only one locale exists — driven by the locales array length).
- **SEO:** emit `hreflang` alternate links for every translated page + `og:locale`; per-locale sitemap entries (both supported by `@astrojs/sitemap` i18n options).
- **RTL-safe:** use CSS logical properties (`ms-`/`me-` Tailwind utilities, `text-start`/`text-end` instead of left/right) so Arabic/Hebrew work later without a retrofit.
- Locale detection: none/minimal — respect the URL only (no auto-redirect by browser language; just an optional suggestion banner). Auto-redirects hurt crawlers and GEO.

---

## 6. Waitlist API contract (site consumes; backend is built separately)

Base URL from env: `PUBLIC_WAITLIST_API_URL` (e.g. `https://{{APP_DOMAIN}}/api/waitlist`). Build the site against this contract with graceful degradation (form disabled state + `Join via email: {{FALLBACK_EMAIL}}` if env missing).

```
POST {PUBLIC_WAITLIST_API_URL}/join
Body: { "email": string, "role": "creator" | "user" | "both", "ref": string | null }
201 → { "position": number, "referralCode": string }
409 → { "error": "already_joined", "position": number, "referralCode": string }  // treat as success
4xx/5xx → show inline friendly error, keep input

GET {PUBLIC_WAITLIST_API_URL}/count
200 → { "claimed": number }   // for the "N of 100" counter; cache in sessionStorage 10 min
```

Referral URL format: `https://{{SITE_DOMAIN}}/?ref={referralCode}`.

---

## 7. SEO / GEO requirements (non-negotiable)

1. Unique `<title>` + meta description per page. Title pattern: `{Page} — DeeWaanAI` ; homepage: `DeeWaanAI — The certified AI-pipeline marketplace`.
2. Open Graph + Twitter card tags on every page; generate a simple branded OG image (dark background, wordmark, tagline) at `/og.png` (create as a static asset via code or a placeholder instruction).
3. **JSON-LD structured data:** homepage → `Organization` + `SoftwareApplication`; FAQ section → `FAQPage` with all 7 Q&As; /blog posts → `Article`.
4. `sitemap.xml` (use `@astrojs/sitemap`) and `robots.txt` that **explicitly allows** all crawlers including AI crawlers (`GPTBot`, `ClaudeBot`, `Claude-Web`, `PerplexityBot`, `Google-Extended`, `CCBot`) — full allow, plus sitemap reference.
5. Semantic HTML: one `h1` per page, logical heading hierarchy, `<article>`/`<section>`/`<nav>`/`<footer>` landmarks.
5b. `/docs/*` pages additionally emit `TechArticle` JSON-LD and `hreflang` alternates per §5.5.
6. Canonical URLs via `Astro.site` — set `site` in `astro.config.mjs` to `https://{{SITE_DOMAIN}}`.
7. Lighthouse targets: Performance ≥ 95, SEO = 100, a11y ≥ 95. No render-blocking third-party assets, self-host the font if any font is used.

---

## 8. Deployment (Railway, static)

- Add a `Dockerfile` in `site/`: build stage (`node:22-alpine`, `npm ci && npm run build`) → serve stage using **Caddy** (`caddy:alpine`) serving `dist/` with: SPA-less static file serving, `try_files` for clean URLs, gzip/zstd, long-cache headers for hashed assets, and listening on `$PORT` (Railway injects it; default 80). Provide the `Caddyfile`.
- Also add `npm run preview` for local checks.
- Provide a short `site/README.md`: local dev (`npm i && npm run dev`), env vars (`PUBLIC_WAITLIST_API_URL`), Railway setup steps (new service → root directory `site/` → Dockerfile auto-detected → attach custom domain `{{SITE_DOMAIN}}`).

---

## 9. Placeholders to leave as-is (do not invent values)

`{{COMPANY_LEGAL_NAME}}` · `{{SITE_DOMAIN}}` · `{{APP_DOMAIN}}` · `{{DISCORD_URL}}` · `{{X_URL}}` · `{{GITHUB_URL}}` · `{{FALLBACK_EMAIL}}` · `/media/demo.mp4`

Collect them in one `site/src/config.ts` so they're replaced in a single file.

## 10. Definition of done

- `npm run build` succeeds with zero warnings; all pages render statically.
- Adding a test locale (e.g. copy `en` docs to `xx/`) produces working `/xx/...` routes with switcher + hreflang, with NO component/code edits — proves §5.5.
- All 7 docs pages exist with sidebar nav, chained "Next" links, and `TechArticle` JSON-LD.
- Waitlist form works against a mocked endpoint (document how to mock), degrades gracefully without env.
- `?ref=abc123` lands in the hidden field and survives page navigation.
- FAQ JSON-LD validates (Google Rich Results test structure).
- No client-side framework shipped; total JS < 15 KB gzipped.
- Dark theme, responsive from 360px to 1440px+.
