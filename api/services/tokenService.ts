// ═══════════════════════════════════════════════════════════════════
//  TOKEN SERVICE — OAuth 2.1-style scoped tokens (F0.8)
// ═══════════════════════════════════════════════════════════════════
// Access tokens: HS256 JWTs (jose), key derived from APP_SECRET.
// Refresh tokens: opaque random strings, stored SHA-256 hashed with
// rotation (rotate = revoke old, issue new pair).

import { createHash, randomBytes } from "crypto";
import { SignJWT, jwtVerify } from "jose";
import { getDb } from "../queries/connection";
import { oauthRefreshTokens } from "@db/schema";
import { eq, and, isNull, gt } from "drizzle-orm";
import { env } from "../lib/env";
import { logger } from "../lib/logger";

export const TOKEN_SCOPES = ["mcp:read", "mcp:run", "mcp:write", "team:read", "team:write"] as const;
type TokenScope = (typeof TOKEN_SCOPES)[number];

const ISSUER = "deewaanai";
const DEFAULT_ACCESS_TTL_SECONDS = 3600; // 1h
const REFRESH_TTL_SECONDS = 30 * 24 * 3600; // 30d

function accessKey(): Uint8Array {
  // Derive a stable 256-bit key from the app secret
  return createHash("sha256").update(env.appSecret).digest();
}

export interface AccessTokenClaims {
  userId: number;
  scopes: string[];
  clientId: string;
}

export async function issueAccessToken(opts: {
  userId: number;
  scopes: string[];
  clientId: string;
  ttlSeconds?: number;
}): Promise<string> {
  const ttl = opts.ttlSeconds ?? DEFAULT_ACCESS_TTL_SECONDS;
  return new SignJWT({ scope: opts.scopes.join(" "), client_id: opts.clientId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(opts.userId))
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(accessKey());
}

/** Verify an access token. Returns null on any failure (never throws). */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, accessKey(), {
      issuer: ISSUER,
    });
    const userId = parseInt(String(payload.sub ?? ""), 10);
    if (!userId || Number.isNaN(userId)) return null;
    const scopes = String(payload.scope ?? "").split(" ").filter(Boolean);
    const clientId = String(payload.client_id ?? "");
    if (!clientId) return null;
    return { userId, scopes, clientId };
  } catch (err) {
    logger.debug("verifyAccessToken failed", { error: (err as Error).message });
    return null;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Issue an opaque refresh token, stored SHA-256 hashed. Returns the raw token (shown once). */
export async function issueRefreshToken(
  userId: number,
  clientId: string,
  scopes: string[],
): Promise<string> {
  const db = getDb();
  const token = randomBytes(48).toString("base64url");
  const expiresAt = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000);
  await db.insert(oauthRefreshTokens).values({
    userId,
    clientId,
    tokenHash: hashToken(token),
    scopes,
    expiresAt,
  });
  return token;
}

/**
 * Rotate a refresh token: revoke the old one and issue a new
 * access+refresh pair. Returns null when the old token is unknown,
 * revoked, or expired.
 */
export async function rotateRefreshToken(oldToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  userId: number;
  clientId: string;
} | null> {
  const db = getDb();
  const oldHash = hashToken(oldToken);
  const [row] = await db.select()
    .from(oauthRefreshTokens)
    .where(and(
      eq(oauthRefreshTokens.tokenHash, oldHash),
      isNull(oauthRefreshTokens.revokedAt),
      gt(oauthRefreshTokens.expiresAt, new Date()),
    ))
    .limit(1);
  if (!row) return null;

  // Revoke old, issue new pair
  await db.update(oauthRefreshTokens)
    .set({ revokedAt: new Date() })
    .where(eq(oauthRefreshTokens.id, row.id));

  const scopes = row.scopes ?? [];
  const [accessToken, refreshToken] = await Promise.all([
    issueAccessToken({ userId: row.userId, scopes, clientId: row.clientId }),
    issueRefreshToken(row.userId, row.clientId, scopes),
  ]);

  logger.info("Refresh token rotated", { userId: row.userId, clientId: row.clientId });
  return { accessToken, refreshToken, scopes, userId: row.userId, clientId: row.clientId };
}
