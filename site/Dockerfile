# ─── DeeWaanAI marketing site (SPEC §8) ───────────────────────────────
# Build stage: static Astro build. Serve stage: Caddy on Railway's $PORT.

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Build-time public env (baked into the static output):
#   PUBLIC_WAITLIST_API_URL — e.g. https://<app-domain>/api/waitlist
#     (omit → waitlist form renders its graceful disabled state)
#   PUBLIC_SITE_DOMAIN      — e.g. https://<site-domain> (canonical/OG/sitemap)
ARG PUBLIC_WAITLIST_API_URL
ARG PUBLIC_SITE_DOMAIN
ENV PUBLIC_WAITLIST_API_URL=$PUBLIC_WAITLIST_API_URL \
    PUBLIC_SITE_DOMAIN=$PUBLIC_SITE_DOMAIN

RUN npm run build


FROM caddy:alpine

COPY --from=build /app/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile

# robots.txt carries the {{SITE_DOMAIN}} placeholder in its Sitemap line;
# substitute it at container start from SITE_DOMAIN (set in Railway).
# Also replace {{APP_DOMAIN}} in all built HTML files (docs code blocks)
# with the separate APP_DOMAIN env var (app/MCP host, often different from
# the marketing domain). No-op-safe when either var is unset.
CMD ["sh", "-c", "if [ -n \"$SITE_DOMAIN\" ]; then sed -i \"s|{{SITE_DOMAIN}}|$SITE_DOMAIN|g\" /srv/robots.txt; fi; if [ -n \"$APP_DOMAIN\" ]; then find /srv -name '*.html' -exec sed -i \"s|{{APP_DOMAIN}}|$APP_DOMAIN|g\" {} +; fi && exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile"]
