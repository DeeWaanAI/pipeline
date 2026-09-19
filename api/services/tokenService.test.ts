// Pure-function tests for access-token issue/verify (api/services/tokenService.ts).
// Covers: HS256 JWT round-trip (jose only — no DB paths exercised),
// claim integrity, and rejection of garbage/tampered/expired tokens.
// Refresh-token issue/rotate requires a database and is NOT tested here.

import { describe, it, expect } from "vitest";
import { issueAccessToken, verifyAccessToken, TOKEN_SCOPES } from "./tokenService";

describe("issueAccessToken / verifyAccessToken", () => {
  it("round-trips claims (userId, scopes, clientId)", async () => {
    const token = await issueAccessToken({
      userId: 42,
      scopes: ["mcp:read", "mcp:run"],
      clientId: "claude-desktop",
    });
    const claims = await verifyAccessToken(token);
    expect(claims).toEqual({
      userId: 42,
      scopes: ["mcp:read", "mcp:run"],
      clientId: "claude-desktop",
    });
  });

  it("returns null for a garbage token (never throws)", async () => {
    expect(await verifyAccessToken("not-a-jwt")).toBeNull();
    expect(await verifyAccessToken("")).toBeNull();
  });

  it("returns null when the payload is tampered", async () => {
    const token = await issueAccessToken({
      userId: 42,
      scopes: ["mcp:read"],
      clientId: "claude-desktop",
    });
    const [header, payload, signature] = token.split(".");
    // Forge an "admin-ish" payload; the signature no longer matches.
    const forged = Buffer.from(
      JSON.stringify({ sub: "1", scope: "mcp:write", client_id: "evil" }),
    ).toString("base64url");
    expect(await verifyAccessToken(`${header}.${forged}.${signature}`)).toBeNull();
  });

  it("returns null for an expired token", async () => {
    const token = await issueAccessToken({
      userId: 42,
      scopes: ["mcp:read"],
      clientId: "claude-desktop",
      ttlSeconds: -60, // already expired
    });
    expect(await verifyAccessToken(token)).toBeNull();
  });

  it("returns null when client_id is missing from claims", async () => {
    const token = await issueAccessToken({ userId: 42, scopes: ["mcp:read"], clientId: "" });
    expect(await verifyAccessToken(token)).toBeNull();
  });
});

describe("TOKEN_SCOPES", () => {
  it("declares the MCP and team scope vocabulary", () => {
    expect([...TOKEN_SCOPES]).toEqual([
      "mcp:read",
      "mcp:run",
      "mcp:write",
      "team:read",
      "team:write",
    ]);
  });
});
