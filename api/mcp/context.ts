// ═══════════════════════════════════════════════════════════════════
//  MCP AUTH CONTEXT — Bearer token → McpAuthContext
// ═══════════════════════════════════════════════════════════════════
// Extracts and verifies the OAuth access token (services/tokenService)
// for every /mcp* request. Returns null on any failure so the caller
// can answer with a uniform 401 + WWW-Authenticate challenge.

import type { Context } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { verifyAccessToken } from "../services/tokenService";
import { logger } from "../lib/logger";
import { resolveLocale } from "../lib/messages";
import type { McpAuthContext } from "./types";

type McpContext = Context<{ Bindings: HttpBindings }>;

export async function authenticate(c: McpContext): Promise<McpAuthContext | null> {
  const header = c.req.header("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    logger.debug("MCP auth: missing or malformed Authorization header");
    return null;
  }

  const claims = await verifyAccessToken(match[1]);
  if (!claims) {
    logger.debug("MCP auth: token verification failed");
    return null;
  }

  // requestId is set by the global middleware in boot.ts for every request.
  const requestId = c.get("requestId") ?? crypto.randomUUID();

  return {
    userId: claims.userId,
    scopes: new Set(claims.scopes),
    clientId: claims.clientId,
    requestId,
    locale: resolveLocale(c.req.raw.headers),
  };
}
