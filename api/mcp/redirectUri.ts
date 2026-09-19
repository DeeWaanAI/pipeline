/**
 * Validate an OAuth client's redirect_uri at dynamic registration time.
 *
 * Rules:
 * - https: always allowed.
 * - http: allowed only for loopback hosts (localhost / 127.0.0.1 / [::1]),
 *   in every environment including production. RFC 8252 §7.3 makes loopback
 *   the recommended redirect target for native apps: desktop MCP bridges
 *   (mcp-remote, Claude Desktop) receive the authorization code on a local
 *   ephemeral port, and the code never leaves the device. PKCE (S256) is
 *   still required for the token exchange.
 * - Anything unparsable or non-http(s): rejected.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  return url.protocol === "http:" && loopback;
}
