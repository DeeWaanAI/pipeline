// ═══════════════════════════════════════════════════════════════════
//  ENTERPRISE SSO ROUTES (Phase 3) — /api/sso/*
// ═══════════════════════════════════════════════════════════════════
// Public endpoints (no Bearer auth — these ARE the auth). Every endpoint
// self-gates behind the `enterprise_sso` feature flag → 404 when disabled
// (indistinguishable from unmounted). Successful SSO issues the app's
// normal local JWT (signLocalToken) and 302s to /login?sso_token=<jwt>;
// failures 302 to /login?sso_error=<key> — never a 500 on bad IdP input.
//
//   GET  /api/sso/lookup?domain=           login-page domain branching
//   GET  /api/sso/oidc/authorize           302 → IdP authorize URL
//   GET  /api/sso/oidc/callback            code exchange → sso_token
//   GET  /api/sso/saml/authorize           SP-initiated SAML (optional)
//   GET  /api/sso/saml/metadata/:id        SP metadata XML
//   POST /api/sso/saml/acs/:id             SAMLResponse → sso_token
//
// Wired from boot.ts (follow the registerMcpRoutes call-site pattern):
//   import { registerSsoRoutes } from "./sso-route";
//   registerSsoRoutes(app);

import type { Context, Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { isFeatureEnabled } from "./plugins/featureFlags";
import { checkRateLimitAsync, type RateLimitConfig } from "./lib/rateLimiter";
import { getClientIp } from "./lib/clientIp";
import { signLocalToken } from "./routers/localAuth";
import { logger } from "./lib/logger";
import {
  buildOidcAuthorizeUrl,
  buildSamlInstance,
  exchangeOidcCode,
  findConnectionByDomain,
  findOrProvisionSsoUser,
  generateNonce,
  generateSpMetadata,
  getEnabledConnectionById,
  normalizeDomain,
  signSsoState,
  validateSamlResponse,
  verifySsoState,
} from "./services/sso";

type SsoApp = Hono<{ Bindings: HttpBindings }>;
type Ctx = Context<{ Bindings: HttpBindings }>;

const FLAG_KEY = "enterprise_sso";

// Lookup budget: blur/submit-triggered, but abusable for domain enumeration.
const LOOKUP_LIMIT: RateLimitConfig = { maxTokens: 20, refillRate: 20 / 60, windowMs: 60_000 };

// Error keys consumed by the login page (mapped to localized toasts in
// src/locales/*/login.json → sso.errors.<key>).
type SsoErrorKey = "config" | "exchange" | "state" | "denied" | "provision";

/** Public origin of this server, honoring reverse-proxy headers. */
function requestOrigin(c: Ctx): string {
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const host =
    c.req.header("x-forwarded-host")?.split(",")[0]?.trim() ?? c.req.header("host");
  if (proto && host) return `${proto}://${host}`;
  try {
    return new URL(c.req.url).origin;
  } catch {
    return "";
  }
}

// Client-IP resolution for rate limiting lives in api/lib/clientIp.ts — it
// honors TRUSTED_PROXY (env.ts) and falls back to the direct socket address
// when no trusted edge proxy is in front of the app.
function clientIp(c: Ctx): string {
  return getClientIp(c.req.raw.headers, c.env?.incoming?.socket?.remoteAddress);
}

/** enterprise_sso flag check; true → caller must 404. Fails closed. */
async function flagDisabled(c: Ctx): Promise<boolean> {
  try {
    return !(await isFeatureEnabled(FLAG_KEY));
  } catch (err) {
    logger.error("SSO: feature-flag check failed — denying", { error: (err as Error).message });
    return true;
  }
}

/** Only same-origin /oauth/ paths may be carried as `next` (open-redirect guard,
 *  same rule the login form applies). */
function safeNext(next: string | undefined): string | undefined {
  return next && next.startsWith("/oauth/") ? next : undefined;
}

function redirectToLogin(
  c: Ctx,
  params: { token?: string; error?: SsoErrorKey; next?: string },
) {
  const url = new URL("/login", requestOrigin(c));
  if (params.token) url.searchParams.set("sso_token", params.token);
  if (params.error) url.searchParams.set("sso_error", params.error);
  const next = safeNext(params.next);
  if (next) url.searchParams.set("next", next);
  return c.redirect(url.toString(), 302);
}

function parseConnectionId(raw: string | undefined): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function registerSsoRoutes(app: SsoApp) {
  // ─── Domain lookup (login page branching) ───────────────────────
  app.get("/api/sso/lookup", async (c) => {
    if (await flagDisabled(c)) return c.notFound();

    const rl = await checkRateLimitAsync(`sso-lookup:${clientIp(c)}`, LOOKUP_LIMIT);
    if (!rl.allowed) {
      c.header("Retry-After", String(Math.ceil(rl.retryAfterMs / 1000)));
      return c.json({ error: "Too many requests" }, 429);
    }

    const domain = normalizeDomain(c.req.query("domain") ?? "");
    if (!domain) return c.json({ sso: false });

    try {
      const conn = await findConnectionByDomain(domain);
      if (!conn) return c.json({ sso: false });
      return c.json({
        sso: true,
        connectionId: conn.id,
        displayName: conn.displayName,
        type: conn.type,
      });
    } catch (err) {
      logger.error("SSO lookup failed", { domain, error: (err as Error).message });
      return c.json({ sso: false });
    }
  });

  // ─── OIDC: 302 to the IdP authorization endpoint ────────────────
  app.get("/api/sso/oidc/authorize", async (c) => {
    if (await flagDisabled(c)) return c.notFound();

    const connectionId = parseConnectionId(c.req.query("connectionId"));
    const next = safeNext(c.req.query("next"));
    if (!connectionId) return redirectToLogin(c, { error: "config", next });

    try {
      const conn = await getEnabledConnectionById(connectionId);
      if (!conn || conn.type !== "oidc") return redirectToLogin(c, { error: "config", next });

      const redirectUri = `${requestOrigin(c)}/api/sso/oidc/callback`;
      const nonce = generateNonce();
      const state = await signSsoState({ connectionId, nonce, next });
      const url = await buildOidcAuthorizeUrl(conn, redirectUri, state, nonce);
      return c.redirect(url, 302);
    } catch (err) {
      logger.error("SSO OIDC authorize failed", { connectionId, error: (err as Error).message });
      return redirectToLogin(c, { error: "config", next });
    }
  });

  // ─── OIDC: callback (code exchange → local JWT) ─────────────────
  app.get("/api/sso/oidc/callback", async (c) => {
    if (await flagDisabled(c)) return c.notFound();

    const q = c.req.query();
    const state = q.state ? await verifySsoState(q.state) : null;
    if (!state) {
      logger.warn("SSO OIDC callback: invalid or expired state");
      return redirectToLogin(c, { error: "state" });
    }
    const next = safeNext(state.next);

    if (q.error) {
      logger.warn("SSO OIDC callback: IdP returned an error", {
        connectionId: state.connectionId,
        idpError: q.error,
      });
      return redirectToLogin(c, { error: "denied", next });
    }
    if (!q.code) return redirectToLogin(c, { error: "exchange", next });

    try {
      const conn = await getEnabledConnectionById(state.connectionId);
      if (!conn || conn.type !== "oidc") return redirectToLogin(c, { error: "config", next });

      const redirectUri = `${requestOrigin(c)}/api/sso/oidc/callback`;
      const claims = await exchangeOidcCode(conn, q.code, redirectUri);
      if (claims.nonce !== state.nonce) {
        logger.warn("SSO OIDC callback: nonce mismatch", { connectionId: conn.id });
        return redirectToLogin(c, { error: "state", next });
      }

      const user = await findOrProvisionSsoUser(claims.email, claims.name);
      const token = await signLocalToken(user.id, user.username);
      logger.info("SSO OIDC login", { connectionId: conn.id, userId: user.id });
      return redirectToLogin(c, { token, next });
    } catch (err) {
      logger.error("SSO OIDC callback failed", {
        connectionId: state.connectionId,
        error: (err as Error).message,
      });
      return redirectToLogin(c, { error: "exchange", next });
    }
  });

  // ─── SAML: SP-initiated login (optional convenience; IdP-initiated
  //     flows POST straight to the ACS endpoint below) ─────────────
  app.get("/api/sso/saml/authorize", async (c) => {
    if (await flagDisabled(c)) return c.notFound();

    const connectionId = parseConnectionId(c.req.query("connectionId"));
    const next = safeNext(c.req.query("next"));
    if (!connectionId) return redirectToLogin(c, { error: "config", next });

    try {
      const conn = await getEnabledConnectionById(connectionId);
      if (!conn || conn.type !== "saml") return redirectToLogin(c, { error: "config", next });

      const callbackUrl = `${requestOrigin(c)}/api/sso/saml/acs/${conn.id}`;
      const saml = buildSamlInstance(conn, callbackUrl);
      const relayState = await signSsoState({ connectionId, nonce: generateNonce(), next });
      const url = await saml.getAuthorizeUrlAsync(relayState, undefined, {});
      return c.redirect(url, 302);
    } catch (err) {
      logger.error("SSO SAML authorize failed", { connectionId, error: (err as Error).message });
      return redirectToLogin(c, { error: "config", next });
    }
  });

  // ─── SAML: SP metadata XML ──────────────────────────────────────
  app.get("/api/sso/saml/metadata/:id", async (c) => {
    if (await flagDisabled(c)) return c.notFound();

    const connectionId = parseConnectionId(c.req.param("id"));
    if (!connectionId) return c.notFound();

    try {
      const conn = await getEnabledConnectionById(connectionId);
      if (!conn || conn.type !== "saml") return c.notFound();

      const callbackUrl = `${requestOrigin(c)}/api/sso/saml/acs/${conn.id}`;
      const xml = generateSpMetadata(conn, callbackUrl);
      c.header("Content-Type", "application/samlmetadata+xml");
      return c.body(xml, 200);
    } catch (err) {
      logger.error("SSO SAML metadata failed", { connectionId, error: (err as Error).message });
      return c.notFound();
    }
  });

  // ─── SAML: ACS (validate SAMLResponse → local JWT) ──────────────
  app.post("/api/sso/saml/acs/:id", async (c) => {
    if (await flagDisabled(c)) return c.notFound();

    const connectionId = parseConnectionId(c.req.param("id"));
    if (!connectionId) return c.notFound();

    try {
      const conn = await getEnabledConnectionById(connectionId);
      if (!conn || conn.type !== "saml") return c.notFound();

      const body = await c.req.parseBody();
      const samlResponse = typeof body.SAMLResponse === "string" ? body.SAMLResponse : "";
      if (!samlResponse) {
        logger.warn("SSO SAML ACS: missing SAMLResponse", { connectionId });
        return redirectToLogin(c, { error: "exchange" });
      }

      const callbackUrl = `${requestOrigin(c)}/api/sso/saml/acs/${conn.id}`;
      const profile = await validateSamlResponse(conn, callbackUrl, samlResponse);
      const user = await findOrProvisionSsoUser(profile.email, profile.name);
      const token = await signLocalToken(user.id, user.username);
      logger.info("SSO SAML login", { connectionId: conn.id, userId: user.id });

      // SP-initiated flows round-trip our state JWT as RelayState
      // (IdP-initiated flows have none) — honor its `next` when present.
      let next: string | undefined;
      const relayState = typeof body.RelayState === "string" ? body.RelayState : "";
      if (relayState) {
        const state = await verifySsoState(relayState);
        if (state && state.connectionId === conn.id) next = safeNext(state.next);
      }
      return redirectToLogin(c, { token, next });
    } catch (err) {
      logger.error("SSO SAML ACS failed", { connectionId, error: (err as Error).message });
      return redirectToLogin(c, { error: "exchange" });
    }
  });

  logger.info("SSO routes registered (OIDC + SAML, gated by enterprise_sso)");
}
