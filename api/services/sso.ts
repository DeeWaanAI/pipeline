// ═══════════════════════════════════════════════════════════════════
//  ENTERPRISE SSO SERVICE (Phase 3) — OIDC + SAML
// ═══════════════════════════════════════════════════════════════════
// Pure server-side helpers behind the `enterprise_sso` feature flag:
//   • findConnectionByDomain / getEnabledConnectionById
//   • OIDC: discovery (cached 1h), authorize URL, code exchange with
//     jose createRemoteJWKSet + jwtVerify (issuer + audience + nonce)
//   • SAML: @node-saml/node-saml instance per connection, SP metadata,
//     ACS response validation (NameID = email)
//   • Stateless CSRF/nonce state JWT (HS256 APP_SECRET, 10-min TTL)
//   • findOrProvisionSsoUser — email match, collision-safe provisioning
//
// Client secrets are stored encrypted (cryptoService AES-256-GCM) and
// decrypted ONLY at code-exchange time.

import * as jose from "jose";
import { randomBytes } from "crypto";
import { SAML } from "@node-saml/node-saml";
import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { ssoConnections, users } from "@db/schema";
import { encrypt, decrypt, getMasterKey } from "./cryptoService";
import { env } from "../lib/env";
import { logger } from "../lib/logger";

export type SsoConnection = typeof ssoConnections.$inferSelect;

const FETCH_TIMEOUT_MS = 10_000;

// ─── Domain normalization + connection lookup ──────────────────────

/**
 * Normalize an email domain (or a full email address) for lookup:
 * lowercase, strip user part before "@", strip surrounding dots/whitespace.
 */
export function normalizeDomain(domainOrEmail: string): string {
  let d = domainOrEmail.trim().toLowerCase();
  const at = d.lastIndexOf("@");
  if (at >= 0) d = d.slice(at + 1);
  return d.replace(/^\.+|\.+$/g, "");
}

/** Enabled SSO connection for an email domain, or null. */
export async function findConnectionByDomain(domainOrEmail: string): Promise<SsoConnection | null> {
  const domain = normalizeDomain(domainOrEmail);
  if (!domain) return null;
  const [row] = await getDb().select().from(ssoConnections)
    .where(eq(ssoConnections.domain, domain)).limit(1);
  if (!row || !row.enabled) return null;
  return row;
}

/** Enabled SSO connection by primary key, or null. */
export async function getEnabledConnectionById(id: number): Promise<SsoConnection | null> {
  const [row] = await getDb().select().from(ssoConnections)
    .where(eq(ssoConnections.id, id)).limit(1);
  if (!row || !row.enabled) return null;
  return row;
}

// ─── OIDC discovery (in-process cache, 1h TTL) ─────────────────────

interface OidcDiscovery {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1 hour
const discoveryCache = new Map<string, { doc: OidcDiscovery; fetchedAt: number }>();
// jose's remote JWKS caches keys internally; keep one instance per jwks_uri
// so consecutive logins don't re-fetch the key set on every exchange.
const jwksCache = new Map<string, ReturnType<typeof jose.createRemoteJWKSet>>();

async function discoverOidc(issuer: string): Promise<OidcDiscovery> {
  const base = issuer.replace(/\/+$/, "");
  const cached = discoveryCache.get(base);
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) return cached.doc;

  const res = await fetch(`${base}/.well-known/openid-configuration`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OIDC discovery failed (HTTP ${res.status})`);
  const doc = (await res.json()) as OidcDiscovery;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error("OIDC discovery document is missing required endpoints");
  }
  discoveryCache.set(base, { doc, fetchedAt: Date.now() });
  return doc;
}

function getRemoteJwks(jwksUri: string) {
  let jwks = jwksCache.get(jwksUri);
  if (!jwks) {
    jwks = jose.createRemoteJWKSet(new URL(jwksUri));
    jwksCache.set(jwksUri, jwks);
  }
  return jwks;
}

/** Build the IdP authorization URL for an OIDC connection. */
export async function buildOidcAuthorizeUrl(
  conn: SsoConnection,
  redirectUri: string,
  state: string,
  nonce: string,
): Promise<string> {
  if (!conn.oidcIssuer || !conn.oidcClientId) {
    throw new Error("OIDC connection is not fully configured");
  }
  const doc = await discoverOidc(conn.oidcIssuer);
  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", conn.oidcClientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", conn.oidcScopes || "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  return url.toString();
}

export interface OidcClaims {
  email: string;
  name?: string;
  nonce?: string;
}

/**
 * Exchange an authorization code for tokens and verify the ID token.
 * The encrypted client secret is decrypted only here, in memory, for the
 * duration of the token request.
 */
export async function exchangeOidcCode(
  conn: SsoConnection,
  code: string,
  redirectUri: string,
): Promise<OidcClaims> {
  if (!conn.oidcIssuer || !conn.oidcClientId || !conn.oidcClientSecretEnc) {
    throw new Error("OIDC connection is not fully configured");
  }
  const doc = await discoverOidc(conn.oidcIssuer);
  const clientSecret = decrypt(conn.oidcClientSecretEnc, getMasterKey());

  const tokenRes = await fetch(doc.token_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: conn.oidcClientId,
      client_secret: clientSecret,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!tokenRes.ok) throw new Error(`OIDC token exchange failed (HTTP ${tokenRes.status})`);
  const tokenJson = (await tokenRes.json()) as { id_token?: string; error?: string };
  if (tokenJson.error || !tokenJson.id_token) {
    throw new Error(`OIDC token response missing id_token${tokenJson.error ? ` (${tokenJson.error})` : ""}`);
  }

  const { payload } = await jose.jwtVerify(tokenJson.id_token, getRemoteJwks(doc.jwks_uri), {
    issuer: conn.oidcIssuer,
    audience: conn.oidcClientId,
  });

  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email || !email.includes("@")) {
    throw new Error("OIDC id_token has no usable email claim");
  }
  return {
    email,
    name: typeof payload.name === "string" ? payload.name : undefined,
    nonce: typeof payload.nonce === "string" ? payload.nonce : undefined,
  };
}

// ─── Stateless CSRF/nonce state JWT (HS256, APP_SECRET, 10 min) ────

const STATE_SECRET = () => new TextEncoder().encode(env.appSecret);

export interface SsoStatePayload {
  connectionId: number;
  nonce: string;
  next?: string;
}

export function generateNonce(): string {
  return randomBytes(16).toString("base64url");
}

export async function signSsoState(payload: SsoStatePayload): Promise<string> {
  return new jose.SignJWT({ ...payload, type: "sso-state" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .setJti(randomBytes(16).toString("base64url"))
    .sign(STATE_SECRET());
}

export async function verifySsoState(token: string): Promise<SsoStatePayload | null> {
  try {
    const { payload } = await jose.jwtVerify(token, STATE_SECRET(), { clockTolerance: 60 });
    if (
      payload.type !== "sso-state" ||
      typeof payload.connectionId !== "number" ||
      typeof payload.nonce !== "string"
    ) {
      return null;
    }
    return {
      connectionId: payload.connectionId,
      nonce: payload.nonce,
      next: typeof payload.next === "string" ? payload.next : undefined,
    };
  } catch {
    return null;
  }
}

// ─── SAML (@node-saml/node-saml, one instance per connection) ──────

/** Wrap a bare base64 cert in PEM armor when the admin pasted it raw. */
function normalizePem(cert: string): string {
  const trimmed = cert.trim();
  if (trimmed.includes("BEGIN CERTIFICATE")) return trimmed;
  const b64 = trimmed.replace(/\s+/g, "");
  const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----`;
}

/**
 * Build a SAML instance for a connection. `callbackUrl` must be the absolute
 * ACS URL for THIS request origin (scheme/host honored from proxy headers).
 *
 * Signature posture: wantAuthnResponseSigned=false + wantAssertionsSigned=false
 * means the library accepts a valid signature on EITHER the response OR the
 * assertion (at least one must verify against idpCert) — the most compatible
 * secure posture across IdPs (Okta signs assertions, Azure AD signs both, ...).
 */
export function buildSamlInstance(conn: SsoConnection, callbackUrl: string): SAML {
  if (!conn.samlEntryPoint || !conn.samlIssuer || !conn.samlCert) {
    throw new Error("SAML connection is not fully configured");
  }
  return new SAML({
    entryPoint: conn.samlEntryPoint,
    issuer: conn.samlIssuer, // SP entity ID
    idpCert: normalizePem(conn.samlCert),
    callbackUrl,
    wantAuthnResponseSigned: false,
    wantAssertionsSigned: false,
  });
}

/** SP metadata XML for admins to hand to their IdP. */
export function generateSpMetadata(conn: SsoConnection, callbackUrl: string): string {
  return buildSamlInstance(conn, callbackUrl).generateServiceProviderMetadata(null);
}

export interface SamlProfile {
  email: string;
  name?: string;
}

/** Validate a POSTed SAMLResponse; NameID is the user's email by contract. */
export async function validateSamlResponse(
  conn: SsoConnection,
  callbackUrl: string,
  samlResponse: string,
): Promise<SamlProfile> {
  const saml = buildSamlInstance(conn, callbackUrl);
  const { profile } = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse });
  if (!profile) throw new Error("SAML response contained no authenticated profile");

  // Contract: NameID = email. Fall back to common email attributes for IdPs
  // that send an opaque NameID plus an email claim.
  const attrEmail =
    (typeof profile.email === "string" && profile.email) ||
    (typeof profile.mail === "string" && profile.mail) ||
    (typeof profile["urn:oid:0.9.2342.19200300.100.1.3"] === "string" &&
      (profile["urn:oid:0.9.2342.19200300.100.1.3"] as string)) ||
    "";
  const email = (profile.nameID && profile.nameID.includes("@") ? profile.nameID : attrEmail)
    .trim()
    .toLowerCase();
  if (!email || !email.includes("@")) {
    throw new Error("SAML profile has no usable email (NameID is not an email)");
  }
  const displayName =
    (typeof profile.displayName === "string" && profile.displayName) ||
    (typeof profile.cn === "string" && profile.cn) ||
    undefined;
  return { email, name: displayName };
}

// ─── User provisioning ─────────────────────────────────────────────

/**
 * Match an existing user by email, or provision a new one:
 * role "user", collision-safe username from the email local part, NULL
 * passwordHash (SSO users can never use local password login — and an
 * existing user's passwordHash is never overwritten). lastSignInAt bumped.
 */
export async function findOrProvisionSsoUser(
  email: string,
  displayName?: string,
): Promise<{ id: number; username: string }> {
  const db = getDb();
  const normalizedEmail = email.trim().toLowerCase();
  const findByEmail = () =>
    db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1);

  const [existing] = await findByEmail();
  if (existing) {
    await db.update(users).set({ lastSignInAt: new Date() }).where(eq(users.id, existing.id));
    return { id: existing.id, username: existing.username ?? `user${existing.id}` };
  }

  const localPart =
    normalizedEmail.split("@")[0]?.replace(/[^a-z0-9_.-]/g, "").slice(0, 40) || "user";

  for (let attempt = 0; attempt < 5; attempt++) {
    const username = attempt === 0 ? localPart : `${localPart}-${randomBytes(3).toString("hex")}`;
    try {
      await db.insert(users).values({
        email: normalizedEmail,
        username,
        name: displayName || localPart,
        role: "user",
        // passwordHash intentionally omitted (NULL): SSO-only account.
      });
      const [created] = await findByEmail();
      if (created) {
        logger.info("SSO user provisioned", { userId: created.id, email: normalizedEmail });
        return { id: created.id, username: created.username ?? username };
      }
    } catch (err) {
      // Lost a race with a concurrent SSO login for the same email — reuse it.
      const [raced] = await findByEmail();
      if (raced) {
        await db.update(users).set({ lastSignInAt: new Date() }).where(eq(users.id, raced.id));
        return { id: raced.id, username: raced.username ?? `user${raced.id}` };
      }
      // Otherwise most likely a username collision — retry with a suffix.
      logger.warn("SSO provisioning insert failed, retrying with new username", {
        email: normalizedEmail,
        error: (err as Error).message,
      });
    }
  }
  throw new Error("SSO user provisioning failed");
}

// ─── Admin helpers (client-secret encryption at rest) ──────────────

export function encryptClientSecret(plain: string): string {
  return encrypt(plain, getMasterKey()).encrypted;
}

/** Masked display value for secret fields in admin list responses. */
export function maskSecret(enc: string | null): string | null {
  return enc ? "********" : null;
}
