# Phase 3 — Enterprise: Coordination Spec (2026-07-13)

Goal (roadmap §PHASE 3): SSO (SAML/OIDC), on-prem relay, signed compliance exports, scale baseline (read replica, CDN cache, per-customer rate limits).
Reference: `DeeWaanAI-Code-Update-Roadmap.md` Phase 3 + `DeeWaanAI-Next/PROGRESS.md`.

## Already done by main agent (do not redo)

- `db/migrations/013_enterprise.sql` applied to dev DB: `sso_connections`, `relay_registrations`, `relay_requests`
- `db/schema.ts` drizzle defs: `ssoConnections`, `relayRegistrations`, `relayRequests` (after approvalAssignments)
- `@node-saml/node-saml` installed (package.json + lockfile committed by npm)
- tsc green baseline

## Stack / conventions (verified from code)

- Hono + tRPC + MySQL/drizzle + React 19 + i18next. No git repo — parallel workers edit DISJOINT file sets.
- Hono route registration pattern: `register*Route(app)` functions called from `api/boot.ts` (see `registerMcpRoutes`, billing webhook). **Workers do NOT edit `api/boot.ts`** — report exact registration lines; main agent wires them.
- Local auth: `api/routers/localAuth.ts` — stateless JWT (`signLocalToken(userId, username)`, 7d, HS256 from APP_SECRET), transported via `x-local-auth-token` header. SSO must end by issuing this same token. Existing `checkRateLimit`/`RATE_LIMITS` in `api/lib/rateLimiter.ts`.
- tRPC procedures: `publicQuery` / `authedQuery` / `adminQuery` from `api/middleware.ts`; `createRouter`.
- Encryption at rest: `cryptoService.encrypt(text, getMasterKey())` / `decrypt(...)` (AES-256-GCM, `salt:iv:authTag:cipher` hex format) — use for OIDC client secrets.
- Feature flags: `isFeatureEnabled(key, userId)` from `api/plugins/featureFlags.ts`; flag OFF → 404 (indistinguishable from unmounted). Phase 3 flags: **`enterprise_sso`**, **`enterprise_relay`**.
- Server i18n: `api/lib/messages.ts` (`msg`, `resolveLocale`); errors thrown as plain `Error` with user-safe text.
- Export router exists: `api/routers/export.ts` (`exportRouter`, registered in `api/router.ts`).
- Admin router exists: `api/routers/admin.ts` (additive procedures OK).
- Frontend auth form lives in `src/pages/Dashboard.tsx` (also renders `/login`; already handles `?next=` OAuth return path). Audit UI: `src/pages/Audit.tsx`.
- i18n: one namespace block per language in `src/i18n-languages.ts`; `npm run i18n:check` enforces en/zh parity.
- Env: optional vars in `api/lib/env.ts` (pattern: `process.env.X ?? ""`); `.env.example` documents them.
- Gates: `npm run check`, `npm run i18n:check`, `npm run build` must stay green.

## Worker A — SSO (SAML/OIDC) + login domain routing

Owns (write): `api/services/sso.ts` (new), `api/sso-route.ts` (new, exports `registerSsoRoutes(app)`), `api/routers/admin.ts` (ADDITIVE SSO CRUD procedures only), `src/pages/Dashboard.tsx` (login form SSO branch + `sso_token` handling only — preserve everything else), `src/locales/en/login.json` + `src/locales/zh/login.json` (new keys, identical key sets).
Reads: `api/routers/localAuth.ts` (signLocalToken, rate-limit pattern), `api/services/cryptoService.ts`, `api/services/tokenService.ts` (HMAC/JWT patterns), `api/mcp/auth.ts` (OAuth route patterns in Hono), `db/schema.ts` (users, ssoConnections), `src/pages/Dashboard.tsx` (full), `src/locales/*/login.json`.

Contract:
1. `api/services/sso.ts`:
   - `findConnectionByDomain(domain)` → enabled connection or null (normalize domain lowercase).
   - OIDC: `buildOidcAuthorizeUrl(conn, redirectUri, state)` via discovery (`${issuer}/.well-known/openid-configuration`, cached in-process 1h); `exchangeOidcCode(conn, code, redirectUri)` → verified ID-token claims (jose `createRemoteJWKSet` + `jwtVerify` with issuer/audience); decrypt client secret with cryptoService.
   - SAML: build a `SAML` instance (@node-saml/node-saml) per connection (`entryPoint`, `issuer`, `cert`, callbackUrl); SP metadata XML generator; `validateSamlResponse(postBody)` → profile (NameID = email).
   - Stateless CSRF/nonce: signed state JWT (jose, HS256 APP_SECRET, 10-min TTL) carrying `{connectionId, nonce, next?}`; verify on callback/ACS.
   - `findOrProvisionSsoUser(email, displayName)`: match `users.email`; create user with role "user" + username derived from email (collision-safe suffix) when missing; mark `lastSignInAt`. Never overwrite an existing user's passwordHash.
2. `api/sso-route.ts` — `registerSsoRoutes(app)` mounting (all behind `enterprise_sso` flag → 404 when off; public endpoints, no Bearer):
   - `GET /api/sso/lookup?domain=` → `{ sso: true, connectionId, displayName, type }` or `{ sso: false }`. Rate-limited via checkRateLimit.
   - `GET /api/sso/oidc/authorize?connectionId=&next=` → 302 to IdP authorize URL (state JWT).
   - `GET /api/sso/oidc/callback` → verify state + code exchange → user → `signLocalToken` → 302 to `/login?sso_token=<jwt>&next=...`.
   - `GET /api/sso/saml/metadata/:id` → SP metadata XML.
   - `POST /api/sso/saml/acs/:id` → validate SAMLResponse (raw form body) → user → 302 `/login?sso_token=...`.
   - Failure paths redirect to `/login?sso_error=<key>` with localized server message logged; never 500 on bad IdP responses.
3. `api/routers/admin.ts` additive procedures (adminQuery): `ssoListConnections` (secret fields masked), `ssoUpsertConnection` (zod: type, domain, displayName, enabled, oidc/saml fields; encrypts client secret before write), `ssoDeleteConnection`.
4. `src/pages/Dashboard.tsx`: login form gains an email field + "Continue with SSO" flow — on blur/submit, call `/api/sso/lookup?domain=`; if sso → full-page redirect to `/api/sso/{oidc/authorize|saml...}?connectionId=` (use the authorize URL shape you built; SAML SP-initiated via redirect to entry point is optional — if IdP-initiated only, show a hint). On mount: if `?sso_token=` present → store token exactly like a normal login response, clean the URL, proceed; if `?sso_error=` → toast localized error. Keep the `?next=` behavior intact.
5. i18n: new keys in login.json (en+zh parity): SSO button, email label, error messages.

## Worker B — Signed compliance audit exports

Owns (write): `api/services/auditExport.ts` (new), `api/routers/export.ts` (ADDITIVE procedures — do not alter existing exports), `src/pages/Audit.tsx` (download button section only), `src/locales/en/audit.json` + `src/locales/zh/audit.json` (new keys).
Reads: `db/schema.ts` (swarmRuns, approvalAssignments, entitlements, subscriptions, mcpAuditLog, oauthClients, oauthRefreshTokens metadata, users), `api/routers/export.ts` (existing patterns), `api/services/tokenService.ts`.

Contract:
1. `api/services/auditExport.ts`:
   - `buildAuditLedger({ from?, to? })` → JSON-serializable ledger: runs (id, projectId, userId, status, createdAt, updatedAt, error presence — NO prompts/outputs content beyond existing truncation norms), approval decisions (from executionState.pendingApproval + approval_assignments), entitlement grants/revokes, subscriptions, MCP audit log rows (clientId, tool, latency, userId, createdAt), oauth client registrations (no secrets), refresh-token issue/revoke metadata (no token hashes). Batch queries (LIMIT/OFFSET, ≤1000/batch) — never load whole tables.
   - `signLedger(ledger)` → `{ payload, signature, algorithm: "HMAC-SHA256", signedAt, keyId: "app-secret" }` where signature = hex HMAC-SHA256 over canonical JSON (stable key sort) using key derived from APP_SECRET (sha256). Also `verifyLedgerSignature(signed)` for completeness.
   - `toCsv(rows)` — RFC-4180-ish CSV with header row, proper quoting; one CSV per section, returned as a map `{ section: csvString }`.
2. `api/routers/export.ts` additive (adminQuery):
   - `auditLedgerJson({ from?, to? })` → signed JSON envelope (above) + row counts per section.
   - `auditLedgerCsv({ from?, to? })` → `{ files: { runs: csv, approvals: csv, ... }, signature, signedAt }`.
   - Both rate-limited (checkRateLimit, generous admin budget) and logged via logger.info with admin userId.
3. `src/pages/Audit.tsx`: admin-visible "Compliance export" card with JSON + CSV download buttons (blob download via anchor; if not admin, hide — use existing `me`/role pattern from the page). New i18n keys in audit.json (en+zh parity).

## Worker C — On-prem relay + read replica + per-customer rate limits

Owns (write): `api/relay-route.ts` (new, exports `registerRelayRoutes(app)`), `relay/connector.mjs` (new standalone Node script), `docker-compose.relay.yml` (new), `api/queries/connection.ts` (add `getReadDb()`), `api/lib/rateLimiter.ts` (extend — keep existing exports/behavior intact), `api/mcp/register.ts` (rate-limit hook only), `api/routers/marketplace.ts` + `api/routers/certification.ts` (read-split + Cache-Control ONLY, targeted edits), `api/lib/env.ts` (+`databaseReadUrl`), `.env.example` (+`DATABASE_READ_URL`).
Reads: `api/lib/rateLimiter.ts` (full), `api/infra/redis.ts`, `api/services/tokenService.ts` (hashing pattern), `api/routers/admin.ts`, `db/schema.ts` (relayRegistrations, relayRequests), `api/mcp/register.ts`, `api/services/billingService.ts` (plan tier lookup), `api/routers/marketplace.ts`, `api/routers/certification.ts`.

Contract:
1. Read replica: `getReadDb()` in connection.ts — drizzle instance over `env.databaseReadUrl` when non-empty, else the primary instance. Zero behavior change when unset. Switch READ-heavy queries to `getReadDb()` in: marketplace browse/search procedures and certification report/badge-data procedures. Leave writes and all other files untouched.
2. Rate-limit tiers: extend `api/lib/rateLimiter.ts` with `checkCustomerRateLimit(key, tier)` where tier ∈ `solo` (default), `team`, `admin` → per-tier token-bucket configs (document numbers; team ~4× solo, admin ~10×). Keep `checkRateLimit`/`RATE_LIMITS` untouched for existing callers. Redis-backed counter when `getRedis()` available (INCR+EXPIRE fixed window is fine), in-memory fallback otherwise. Apply in `api/mcp/register.ts` mcpGate: after auth, key `mcp:<userId>`, tier from user's subscription/team membership (solo default; team if any team_seats-active membership... simplest: tier "team" if user is member of any team with a team_seats row carrying a stripeSubscriptionId; "admin" if users.role='admin'). Exceeded → 429 with `Retry-After`.
3. Relay cloud side (`api/relay-route.ts`, all behind `enterprise_relay` flag → 404 when off):
   - Admin tRPC-equivalent is NOT needed here; expose Hono endpoints: `POST /api/relay/register` (admin local-auth token required — verify via verifyLocalToken from localAuth + role check; body name → returns one-time raw relay token + relayId; store SHA-256 hash).
   - Relay-authenticated (Bearer relay token, hash lookup, status=active, bump last_seen_at): `GET /api/relay/poll?wait=25` (long-poll: return oldest pending relay_request for this relay, mark claimed; empty after timeout → 204), `POST /api/relay/result` (`{requestId, result|error}` → mark completed/failed).
   - Enqueue for smoke/testing: `POST /api/relay/enqueue` (admin local-auth; `{relayId, kind, payload}` → pending row).
4. Relay connector (`relay/connector.mjs`): standalone Node 18+ script, zero npm deps beyond what node_modules already has (use global fetch). Env: `CLOUD_URL`, `RELAY_TOKEN`, `LOCAL_URL` (default http://localhost:3000). Loop: long-poll cloud → execute request against LOCAL_URL (kind `http_proxy`: `{method, path, body}` → fetch local → result `{status, bodyBase64?/json}`) → POST result. Backoff on errors, log lines to stdout. `docker-compose.relay.yml`: builds/uses the existing app image or plain node:20-alpine mounting `relay/`, env-driven, no inbound ports (outbound-only), `restart: unless-stopped`.
5. CDN cache: add `Cache-Control: public, max-age=300, s-maxage=3600` (+ keep existing ETag) to the certification badge route and public certification report JSON responses; marketplace browse responses get `Cache-Control: public, max-age=60, s-maxage=300`. Do not cache authed/personalized responses.

## Merge & verification (main agent)

1. Wire `registerSsoRoutes(app)` + `registerRelayRoutes(app)` in `api/boot.ts` from worker reports.
2. Review all diffs for scope violations.
3. `npm run check` → `npm run i18n:check` → `npm run build` green.
4. Boot smoke: flags off → SSO/relay 404; sso lookup with seeded OIDC connection → discoverable; relay register → poll → enqueue → result round-trip; signed audit ledger signature verifies; rate limit 429 after burst.
5. Update `DeeWaanAI-Next/PROGRESS.md` Phase 3 section.
