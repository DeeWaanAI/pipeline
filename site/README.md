# DeeWaanAI Marketing Site

Static Astro site (landing, connect guide, trust deep-dive, docs manual, blog, legal) deployed as its own Railway service. Fully static — no SSR, no client framework; total JS budget < 15 KB gzipped.

## Local dev

```bash
npm i
npm run dev        # http://localhost:4321
```

## Build & preview

```bash
npm run build      # static output → dist/
npm run preview    # serve the built site locally
```

## Environment variables (build-time, public)

| Variable | Purpose | Without it |
|---|---|---|
| `PUBLIC_WAITLIST_API_URL` | Waitlist backend base, e.g. `https://<app-domain>/api/waitlist` | Form renders disabled state with fallback email |
| `PUBLIC_SITE_DOMAIN` | Canonical origin, e.g. `https://<site-domain>` | Placeholder stays in canonical/OG/sitemap |

Container runtime variables (no `PUBLIC_` prefix):
- `SITE_DOMAIN` — substitutes `{{SITE_DOMAIN}}` into `robots.txt` at container start.
- `APP_DOMAIN` — substitutes `{{APP_DOMAIN}}` into all built HTML files (docs code blocks). If unset, the placeholder stays visible (a loud failure beats a silently wrong URL).
- `PORT` is injected by Railway (Caddy defaults to 80).

## Placeholders

All owner-supplied values (legal name, domains, social URLs, fallback email) live in exactly one file: `src/config.ts`. Do not invent values; replace them there when supplied.

## Docker (the Railway path)

```bash
docker build -t deewaanai-site .
docker run --rm -p 8080:80 -e SITE_DOMAIN=example.com -e APP_DOMAIN=app.example.com deewaanai-site
# → http://localhost:8080
```

## Railway setup

1. New service → from the same GitHub repo (`youssef-hariri/deewaanai`).
2. Settings → Root directory: `site/` → Dockerfile is auto-detected.
3. Variables: `PUBLIC_WAITLIST_API_URL` (build arg), `PUBLIC_SITE_DOMAIN` (build arg), `SITE_DOMAIN` (runtime, robots.txt), `APP_DOMAIN` (runtime, docs HTML substitution).
4. Attach the custom domain when ready.

## Verifying the waitlist client

The real built inline script is smoke-tested against a mock of the API contract (26 checks — counter cache, referral capture, 201/409/500 flows, clipboard):

```bash
PUBLIC_WAITLIST_API_URL=http://127.0.0.1:8787/api/waitlist npm run build
node scripts/smoke-waitlist-client.mjs
```

## Adding a language

1. Add the locale code to `LOCALES` in `src/i18n/locales.ts`.
2. Add `src/content/ui/<locale>.json` (UI strings) and translated content under `src/content/docs/<locale>/` / `src/content/blog/<locale>/`.

No page, layout, or component edits — routes, the footer switcher, hreflang, and the EN-fallback note all follow from the locale list. Untranslated pages render the English version with a "not yet translated" note; they never 404.
