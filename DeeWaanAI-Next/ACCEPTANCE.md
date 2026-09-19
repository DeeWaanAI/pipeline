# DeeWaanAI — Acceptance Runbook (third-party-dependent items)

Operator checklist for the items automated smokes cannot cover: they need a
real third party (Stripe, an IdP, a second desktop, a customer network, a
second MySQL). Each section: offline pre-check → live steps → pass criteria.
Run every section against the deployed app before calling the feature done.

Conventions: `<app>` = public app origin (e.g. `https://x.up.railway.app`),
`<db>` = MySQL `DATABASE_URL`. SQL checks run against the primary database.

---

## A. Live Stripe test-card cycle

**Goal:** real Stripe Checkout payment → entitlement granted; real refund →
entitlement revoked. Offline webhook logic is already covered by the smoke.

**Offline pre-check (no Stripe account needed):**

1. Boot the app with test env: `STRIPE_SECRET_KEY=sk_test_smoke STRIPE_WEBHOOK_SECRET=whsec_smoke_local npm run dev`
2. `STRIPE_WEBHOOK_SECRET=whsec_smoke_local node scripts/smoke-stripe-webhook.mjs http://127.0.0.1:3000` → must print `SMOKE stripe-webhook OK` (grant, idempotent replay, bad-signature 400, refund revoke).

**Live steps (Stripe test mode):**

1. Follow `DEPLOY.md` Step 9 exactly: set `STRIPE_SECRET_KEY` (`sk_test_...`), `STRIPE_PRICE_SOLO`, `STRIPE_PRICE_TEAM_SEAT`, and `STRIPE_WEBHOOK_SECRET` from the webhook you register for `<app>/api/billing/stripe-webhook` (events: `checkout.session.completed`, `customer.subscription.*`, `charge.refunded`).
2. In the app, publish a marketplace listing (or use an existing published one) and note its id.
3. Buy it with test card `4242 4242 4242 4242`, any future expiry, any CVC. Complete Checkout.
4. Verify the grant:
   ```sql
   SELECT id, status, amount_paid FROM marketplace_purchases ORDER BY id DESC LIMIT 1;   -- status=active
   SELECT capability, source FROM entitlements ORDER BY id DESC LIMIT 1;                 -- pipeline:run:<listingId>, purchase
   ```
5. Stripe Dashboard → Payments → the test payment → **Refund** (full).
6. Verify the revoke: same two queries → purchase `status=refunded`, entitlement row gone.
7. Subscribe to the Solo plan with the test card → `subscriptions` row `status=active` and plan capabilities present via `billing.myCapabilities` in the UI.
8. Team-seat path (team_seats `checkout.session.completed` calls the live Stripe API — the smoke excludes it deliberately): create a team, buy seats with the test card, then check `team_seats` row exists and the owner's entitlements include `team:sync`.

**Pass criteria:** steps 4, 6, 7, 8 all show the expected rows; Stripe
Dashboard → Webhooks shows `2xx` for every delivered event (no retries).

---

## B. Two-desktop TeamSync handoff (Alice → Bob)

**Goal:** a run handed off from Alice in Claude Desktop is approved by Bob in
Kimi — proving cross-client team state, not just single-host wiring.

**Single-host pre-check:**

1. `node scripts/smoke-teamsync.mjs on` → must print `SMOKE on OK` (8 team tools listed, `team_runs_list` executes).

**Live steps:**

1. Enable the flag: `teamsync` = enabled, rollout 100 (DB `feature_flags`, or the admin UI).
2. Two accounts: Alice and Bob. Put both in one team (team with a shared project).
3. Alice's desktop: connect Claude Desktop to `<app>/mcp` with Alice's token (see `/connect`).
4. Bob's desktop: connect Kimi to `<app>/mcp` with Bob's token.
5. Alice starts a pipeline run on the shared project and drives it to a pending approval step.
6. Alice calls `team_handoff` with `{ runId, assigneeUserId: <Bob's user id> }`.
7. Bob, in Kimi: calls `team_runs_list` — the run must appear under `waitingForYou`.
8. Bob approves the pending step with `approve_step` from Kimi.
9. Confirm the run resumes and completes; both clients see the same final state via `team_runs_list` / `team_context_get`.

**Pass criteria:** step 7 shows the run waiting for Bob (not Alice); step 8
succeeds from Bob's client and is rejected if attempted by a non-assignee;
the run reaches completion with the approval attributed to Bob in the DB
(`team_run_assignments` / run record).

---

## C. Live IdP SSO (Okta / Microsoft Entra)

**Goal:** a real user signs in via the corporate IdP and lands in the app with
a provisioned local account.

**Offline pre-check:**

1. `node scripts/smoke-enterprise.mjs on` → must print `SMOKE on OK` (seeded-connection lookup + authorize 302 with a fake IdP).

**Live steps:**

1. Enable the flag: `enterprise_sso` = enabled, rollout 100.
2. At the IdP: create an OIDC app integration (Okta: "OIDC — Web Application"; Entra: "App registration" → Web).
   - Redirect URI: `<app>/api/sso/oidc/callback`
   - Scopes: `openid email profile`
   - Assign a test user.
3. In DeeWaanAI, as admin, call the tRPC procedure `admin.ssoUpsertConnection` with the customer domain, `type: "oidc"`, `oidcIssuer`, `oidcClientId`, `oidcClientSecret` (the procedure encrypts the secret at rest — never insert it into SQL in plaintext).
4. Open the login page, enter an email at that domain → `GET /api/sso/lookup?domain=` returns `sso: true` and the page branches to SSO.
5. Click through: 302 to the IdP → authenticate as the test user → 302 back to `/login?sso_token=...` → app session established.
6. Verify provisioning: `SELECT id, email, username FROM users ORDER BY id DESC LIMIT 1;` → a row for the IdP user exists.
7. Negative: a user at an unconfigured domain gets no SSO branch; a wrong IdP password never reaches the app (fails at the IdP).

**Pass criteria:** steps 4–6 succeed end to end; the secret column
`oidc_client_secret_enc` is ciphertext; SSO failures redirect to
`/login?sso_error=<key>` (never a 500). SAML path (`/api/sso/saml/*`) follows
the same checklist if the customer is SAML-only: SP metadata at
`/api/sso/saml/metadata/:id`, ACS at `/api/sso/saml/acs/:id`.

---

## D. Live on-prem relay

**Goal:** a connector on a customer network (egress-only, no inbound ports)
serves relayed requests against a private local service.

**Local pre-check:**

1. App running with an admin user present, then:
   `node scripts/smoke-relay-loop.mjs http://127.0.0.1:3000` → must print `SMOKE relay-loop OK` (register → connector child → enqueue → completed in DB). The script enables `enterprise_relay` itself and restores its prior state.

**Live steps:**

1. Enable the flag for the deployment: `enterprise_relay` = enabled, rollout 100.
2. As an admin, mint a connector: `POST <app>/api/relay/register` with `{"name": "<customer-site>"}` → save the raw `token` (shown once; only its SHA-256 is stored).
3. On the customer machine (outbound HTTPS only):
   ```sh
   export CLOUD_URL=<app>
   export RELAY_TOKEN=<token from step 2>
   export LOCAL_URL=http://host.docker.internal:3000   # the private service
   docker compose -f docker-compose.relay.yml up -d
   ```
4. Verify the container publishes no ports: `docker ps` → empty `PORTS` column for `swarm-relay`.
5. From the cloud side, enqueue: `POST <app>/api/relay/enqueue` with `{ "relayId": <id>, "kind": "http_proxy", "payload": { "method": "GET", "path": "/health" } }` (path on the LOCAL service).
6. Verify completion:
   ```sql
   SELECT status, result_json FROM relay_requests ORDER BY id DESC LIMIT 1;  -- completed, result from the LOCAL service
   SELECT last_seen_at FROM relay_registrations WHERE id = <id>;             -- recent
   ```
7. Pull the customer's egress firewall rule for anything except 443 → connector keeps working (it only dials out).

**Pass criteria:** steps 4, 6, 7 hold; connector logs show `job completed`
with `failed: false`; revoking the registration (set `relay_registrations.status='revoked'`) makes polls return 401.

---

## E. Real read-replica DSN (`DATABASE_READ_URL`)

**Goal:** read-heavy queries are served by a real MySQL read replica, not the
primary. (`getReadDb()` in `api/queries/connection.ts` falls back to the
primary only when the variable is unset.)

**Live steps:**

1. Provision a MySQL replica (Railway: second MySQL with replication, or any managed replica) and confirm replication lag ≈ 0.
2. Set `DATABASE_READ_URL=mysql://user:pass@<replica-host>:<port>/<db>` on the app service; redeploy.
3. `<app>/api/health` → `"status":"ok"`.
4. Generate read traffic: browse the app, list pipelines/templates, open the marketplace.
5. On the replica, confirm it served the reads: enable the general log briefly (`SET GLOBAL general_log = ON;`) or watch `mysqladmin processlist` / performance-schema digest counts while repeating step 4. On the primary, confirm the same read statements are absent.
6. Write path still on primary: create/update one record in the UI → appears on the primary and propagates to the replica within lag.
7. Document the failure mode honestly: there is no runtime failover — if the replica dies, read queries that use `getReadDb()` fail until `DATABASE_READ_URL` is unset. Verify by stopping the replica, observing read errors, unsetting the variable, and confirming recovery.

**Pass criteria:** step 5 shows reads on the replica only; step 6 shows
writes on the primary only; step 7 recovery works and the failure mode is
recorded in the ops notes.
