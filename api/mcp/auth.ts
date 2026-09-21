// ═══════════════════════════════════════════════════════════════════
//  MCP OAUTH 2.1 AUTHORIZATION SERVER (F0 — Companion MCP Server)
// ═══════════════════════════════════════════════════════════════════
// Public endpoints (no Bearer auth — these ARE the auth):
//   GET  /.well-known/oauth-protected-resource   (RFC 9728)
//   GET  /.well-known/oauth-authorization-server (RFC 8414)
//   POST /oauth/register                         (RFC 7591 DCR)
//   GET  /oauth/authorize                        (auth code + PKCE)
//   POST /oauth/authorize/confirm                (consent decision)
//   POST /oauth/token                            (code exchange / refresh)
//
// Worker A wires this up in boot.ts with a single call:
//   import { registerOAuthRoutes } from "./mcp/auth";
//   registerOAuthRoutes(app);
// The function is fully self-sufficient (own imports, own helpers).

import type { Context, Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { getCookie } from "hono/cookie";
import { createHash, randomBytes } from "crypto";
import { eq, and, isNull } from "drizzle-orm";
import { getDb } from "../queries/connection";
// oauthClients / oauthAuthCodes are created by worker A in db/schema.ts
// (contract: oauth_clients{clientId,clientName,redirectUris:json string[]},
//  oauth_auth_codes{codeHash,clientId,userId,redirectUri,codeChallenge,
//  codeChallengeMethod,scopes:json string[],expiresAt,usedAt}).
import { oauthClients, oauthAuthCodes, users } from "@db/schema";
import { Session } from "@contracts/constants";
import { verifyLocalToken } from "../routers/localAuth";
import { issueAccessToken, issueRefreshToken, rotateRefreshToken } from "../services/tokenService";
import { isAllowedRedirectUri } from "./redirectUri";
import { logger } from "../lib/logger";

// ─── Constants ──────────────────────────────────────────────────────
const MCP_SCOPES = ["mcp:read", "mcp:run", "mcp:write"] as const;
const ACCESS_TTL_SECONDS = 3600; // matches tokenService default
const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes, single-use

// ─── Small helpers ──────────────────────────────────────────────────

type OAuthApp = Hono<{ Bindings: HttpBindings }>;
type Ctx = Context<{ Bindings: HttpBindings }>;

/** Public origin of this server, honoring reverse-proxy headers. Exported
 *  because the 401 challenge must advertise the SAME origin the discovery
 *  documents use — hardcoding `https://` there breaks a local http dev server. */
export function requestOrigin(c: Ctx): string {
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

function parseScopeString(scope: string | undefined | null): string[] {
  return (scope ?? "").split(/\s+/).filter(Boolean);
}

/** Intersect requested scopes with the allowed mcp:* set. Null = invalid request. */
function filterScopes(requested: string[]): string[] | null {
  const effective = requested.length > 0 ? requested : [...MCP_SCOPES];
  if (effective.some((s) => !(MCP_SCOPES as readonly string[]).includes(s))) return null;
  return effective;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** RFC 6749 error response. Never includes secret material. */
function oauthError(
  c: Ctx,
  error: string,
  description: string,
  status: 400 | 401 = 400,
) {
  return c.json({ error, error_description: description }, status);
}

function buildRedirect(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  return url.toString();
}

/**
 * Resolve the current web user from the session cookie (kimi_sid).
 * The cookie carries the same local-auth JWT the tRPC context verifies
 * via the x-local-auth-token header; we replicate that minimal lookup
 * (verify token → userId → user row). Header accepted as fallback so the
 * consent page (which stores the token client-side) can POST confirm.
 */
async function resolveSessionUser(
  c: Ctx,
): Promise<{ id: number } | null> {
  const token = getCookie(c, Session.cookieName) ?? c.req.header("x-local-auth-token");
  if (!token) return null;
  const claim = await verifyLocalToken(token);
  if (!claim?.userId) return null;
  try {
    const [user] = await getDb().select({ id: users.id }).from(users)
      .where(eq(users.id, claim.userId)).limit(1);
    return user ?? null;
  } catch (err) {
    logger.error("OAuth: session user lookup failed", { error: (err as Error).message });
    return null;
  }
}

async function findClient(clientId: string) {
  const [client] = await getDb().select().from(oauthClients)
    .where(eq(oauthClients.clientId, clientId)).limit(1);
  return client ?? null;
}

/** Read urlencoded or JSON body params as strings. */
async function readBodyParams(
  c: Ctx,
): Promise<Record<string, string>> {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const json = (await c.req.json()) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(json).map(([k, v]) => [k, typeof v === "string" ? v : String(v ?? "")]),
      );
    } catch {
      return {};
    }
  }
  const body = await c.req.parseBody();
  return Object.fromEntries(
    Object.entries(body).map(([k, v]) => [k, typeof v === "string" ? v : String(v ?? "")]),
  );
}

// ─── Route registration ─────────────────────────────────────────────

export function registerOAuthRoutes(app: OAuthApp) {
  // ─── RFC 9728: Protected Resource Metadata ──────────────────────
  app.get("/.well-known/oauth-protected-resource", (c) => {
    const origin = requestOrigin(c);
    return c.json({
      resource: origin,
      authorization_servers: [origin],
      scopes_supported: [...MCP_SCOPES],
      bearer_methods_supported: ["header"],
    });
  });

  // ─── RFC 8414: Authorization Server Metadata ────────────────────
  app.get("/.well-known/oauth-authorization-server", (c) => {
    const origin = requestOrigin(c);
    return c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [...MCP_SCOPES],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  // ─── RFC 7591: Dynamic Client Registration ──────────────────────
  app.post("/oauth/register", async (c) => {
    let body: { client_name?: unknown; redirect_uris?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return oauthError(c, "invalid_request", "Body must be valid JSON");
    }

    const clientName = typeof body.client_name === "string" ? body.client_name.trim() : "";
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u): u is string => typeof u === "string")
      : [];

    if (!clientName) {
      return oauthError(c, "invalid_request", "client_name is required");
    }
    if (redirectUris.length === 0) {
      return oauthError(c, "invalid_request", "redirect_uris must be a non-empty array");
    }
    const invalid = redirectUris.find((u) => !isAllowedRedirectUri(u));
    if (invalid) {
      logger.warn("OAuth register: rejected redirect_uri", { clientName });
      return oauthError(
        c,
        "invalid_request",
        "redirect_uris must be https (http://localhost/127.0.0.1 allowed for native-app loopback)",
      );
    }

    const clientId = randomBytes(24).toString("base64url");
    try {
      await getDb().insert(oauthClients).values({
        clientId,
        clientName,
        redirectUris,
      });
    } catch (err) {
      logger.error("OAuth register: insert failed", { clientName, error: (err as Error).message });
      return oauthError(c, "invalid_request", "Client registration failed");
    }

    logger.info("OAuth client registered", { clientId, clientName });
    return c.json(
      {
        client_id: clientId,
        client_name: clientName,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
      },
      201,
    );
  });

  // ─── Authorization endpoint (GET) ───────────────────────────────
  app.get("/oauth/authorize", async (c) => {
    const q = c.req.query();
    const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, scope, state } = q;

    const fail400 = (desc: string) => {
      logger.warn("OAuth authorize: rejected", { client_id, desc });
      return oauthError(c, "invalid_request", desc);
    };

    if (response_type !== "code") return fail400("response_type must be 'code'");
    if (!client_id) return fail400("client_id is required");

    const client = await findClient(client_id);
    if (!client) return fail400("Unknown client_id");

    const registered = (client.redirectUris as string[] | null) ?? [];
    if (!redirect_uri || !registered.includes(redirect_uri)) {
      // Must NOT redirect to an unvalidated URI — hard 400.
      return fail400("redirect_uri does not match registered URIs");
    }

    // PKCE: S256 only (OAuth 2.1). Reject plain / missing.
    if (!code_challenge || code_challenge_method !== "S256") {
      logger.warn("OAuth authorize: PKCE rejected", { client_id, method: code_challenge_method });
      return oauthError(c, "invalid_request", "PKCE with code_challenge_method=S256 is required");
    }

    const scopes = filterScopes(parseScopeString(scope));
    if (!scopes) {
      logger.warn("OAuth authorize: invalid scope", { client_id, scope });
      return oauthError(c, "invalid_scope", `Allowed scopes: ${MCP_SCOPES.join(" ")}`);
    }

    // No server-side session check at this step: the app authenticates API
    // calls via the x-local-auth-token header (localStorage JWT), which a
    // top-level browser navigation cannot send — and no auth cookie is ever
    // set, so gating here made the consent screen unreachable. The consent
    // page is session-aware (it renders a login state that routes through
    // /login?next=<this consent URL>); the confirm POST below stays guarded
    // by resolveSessionUser.
    // The page POSTs the decision to /oauth/authorize/confirm.
    const consent = new URL("/oauth/consent", requestOrigin(c));
    consent.searchParams.set("client_id", client_id);
    consent.searchParams.set("client_name", client.clientName ?? client_id);
    consent.searchParams.set("scope", scopes.join(" "));
    consent.searchParams.set("redirect_uri", redirect_uri);
    consent.searchParams.set("code_challenge", code_challenge);
    if (state !== undefined) consent.searchParams.set("state", state);
    return c.redirect(consent.toString(), 302);
  });

  // ─── Consent confirmation (POST, JSON, session required) ────────
  app.post("/oauth/authorize/confirm", async (c) => {
    const user = await resolveSessionUser(c);
    if (!user) {
      return oauthError(c, "invalid_request", "Authentication required", 401);
    }

    const p = await readBodyParams(c);
    const { client_id, redirect_uri, code_challenge, scope, state, decision } = p;

    const client = client_id ? await findClient(client_id) : null;
    if (!client) return oauthError(c, "invalid_request", "Unknown client_id");

    const registered = (client.redirectUris as string[] | null) ?? [];
    if (!redirect_uri || !registered.includes(redirect_uri)) {
      return oauthError(c, "invalid_request", "redirect_uri does not match registered URIs");
    }

    if (decision !== "allow") {
      logger.info("OAuth consent denied", { client_id, userId: user.id });
      return c.json({
        redirect: buildRedirect(redirect_uri, { error: "access_denied", state }),
      });
    }

    if (!code_challenge) {
      return oauthError(c, "invalid_request", "code_challenge is required");
    }
    const scopes = filterScopes(parseScopeString(scope));
    if (!scopes) {
      return oauthError(c, "invalid_scope", `Allowed scopes: ${MCP_SCOPES.join(" ")}`);
    }

    const code = randomBytes(32).toString("base64url");
    try {
      await getDb().insert(oauthAuthCodes).values({
        codeHash: sha256Hex(code),
        clientId: client_id,
        userId: user.id,
        redirectUri: redirect_uri,
        codeChallenge: code_challenge,
        codeChallengeMethod: "S256",
        scopes,
        expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
      });
    } catch (err) {
      logger.error("OAuth confirm: code insert failed", { client_id, error: (err as Error).message });
      return oauthError(c, "invalid_request", "Could not issue authorization code");
    }

    logger.info("OAuth code issued", { client_id, userId: user.id, scopes });
    return c.json({
      redirect: buildRedirect(redirect_uri, { code, state }),
    });
  });

  // ─── Token endpoint (POST) ──────────────────────────────────────
  app.post("/oauth/token", async (c) => {
    const p = await readBodyParams(c);
    const { grant_type, client_id } = p;

    const sendTokens = (
      accessToken: string,
      refreshToken: string,
      scopes: string[],
    ) => {
      c.header("Cache-Control", "no-store");
      c.header("Pragma", "no-cache");
      return c.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: ACCESS_TTL_SECONDS,
        refresh_token: refreshToken,
        scope: scopes.join(" "),
      });
    };

    if (grant_type === "authorization_code") {
      const { code, redirect_uri, code_verifier } = p;
      if (!code || !client_id || !redirect_uri || !code_verifier) {
        logger.warn("OAuth token: missing params", { client_id });
        return oauthError(c, "invalid_request", "code, client_id, redirect_uri and code_verifier are required");
      }

      const db = getDb();
      const [row] = await db.select().from(oauthAuthCodes)
        .where(eq(oauthAuthCodes.codeHash, sha256Hex(code))).limit(1);

      const reject = (desc: string) => {
        logger.warn("OAuth token: invalid_grant", { client_id, desc });
        return oauthError(c, "invalid_grant", desc);
      };

      if (!row) return reject("Unknown authorization code");
      if (row.usedAt) return reject("Authorization code already used");
      if (new Date(row.expiresAt).getTime() <= Date.now()) return reject("Authorization code expired");
      if (row.clientId !== client_id) return reject("client_id mismatch");
      if (row.redirectUri !== redirect_uri) return reject("redirect_uri mismatch");
      if (row.codeChallengeMethod !== "S256" || pkceS256(code_verifier) !== row.codeChallenge) {
        return reject("PKCE verification failed");
      }

      // Single-use: mark used atomically; bail if a concurrent exchange won.
      const updateRes = await db.update(oauthAuthCodes)
        .set({ usedAt: new Date() })
        .where(and(eq(oauthAuthCodes.codeHash, row.codeHash), isNull(oauthAuthCodes.usedAt)));
      const affected = Array.isArray(updateRes)
        ? (updateRes[0] as { affectedRows?: number })?.affectedRows
        : (updateRes as { affectedRows?: number })?.affectedRows;
      if (!affected) return reject("Authorization code already used");

      // requested scope ∩ user-consented scope (default: consented set)
      const granted = (row.scopes as string[] | null) ?? [];
      const requested = parseScopeString(p.scope);
      const scopes = requested.length > 0
        ? requested.filter((s) => granted.includes(s))
        : granted;
      if (requested.length > 0 && scopes.length === 0) {
        logger.warn("OAuth token: scope outside granted set", { client_id });
        return oauthError(c, "invalid_scope", "Requested scope exceeds granted scope");
      }

      const [accessToken, refreshToken] = await Promise.all([
        issueAccessToken({ userId: row.userId, scopes, clientId: client_id }),
        issueRefreshToken(row.userId, client_id, scopes),
      ]);
      logger.info("OAuth tokens issued", { client_id, userId: row.userId, scopes });
      return sendTokens(accessToken, refreshToken, scopes);
    }

    if (grant_type === "refresh_token") {
      const { refresh_token } = p;
      if (!refresh_token) {
        return oauthError(c, "invalid_request", "refresh_token is required");
      }
      const rotated = await rotateRefreshToken(refresh_token);
      if (!rotated) {
        logger.warn("OAuth token: refresh rejected", { client_id });
        return oauthError(c, "invalid_grant", "Invalid, expired or revoked refresh_token");
      }
      return sendTokens(rotated.accessToken, rotated.refreshToken, rotated.scopes);
    }

    logger.warn("OAuth token: unsupported grant", { client_id, grant_type });
    return oauthError(c, "unsupported_grant_type", "Supported: authorization_code, refresh_token");
  });
}
