/**
 * Redirect-URI rules for the MCP OAuth server, in two places:
 *  - isAllowedRedirectUri: validated at dynamic registration time (RFC 7591).
 *  - redirectUriMatchesRegistration: checked at authorize/confirm time.
 *
 * Registration rules:
 * - https: always allowed.
 * - http: allowed only for loopback hosts (localhost / 127.0.0.1 / [::1]),
 *   in every environment including production. RFC 8252 §7.3 makes loopback
 *   the recommended redirect target for native apps: desktop MCP bridges
 *   (mcp-remote, Claude Desktop) receive the authorization code on a local
 *   ephemeral port, and the code never leaves the device. PKCE (S256) is
 *   still required for the token exchange.
 * - Anything unparsable or non-http(s): rejected.
 */

/** Loopback hosts per RFC 8252 §7.3. `new URL()` keeps the brackets on ::1. */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

export function isAllowedRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackHost(url.hostname);
}

/**
 * Match an authorization-request redirect_uri against a client's registered list.
 *
 * Rules:
 * - Exact string match always succeeds.
 * - http + loopback: the port is ignored, everything else must match. RFC 8252
 *   §7.3 requires this — a native app binds a fresh ephemeral port on every
 *   launch but keeps its registered client_id, so pinning the port from
 *   registration time deadlocks the flow ("redirect_uri does not match
 *   registered URIs") after the first restart of any desktop MCP client.
 * - https: exact match only. There the port is part of the endpoint's identity
 *   and the client cannot re-bind it at will.
 */
export function redirectUriMatchesRegistration(
  incoming: string,
  registered: readonly string[],
): boolean {
  return registered.some((candidate) => sameRedirectUri(candidate, incoming));
}

function sameRedirectUri(registeredUri: string, incomingUri: string): boolean {
  if (registeredUri === incomingUri) return true;
  let registered: URL;
  let incoming: URL;
  try {
    registered = new URL(registeredUri);
    incoming = new URL(incomingUri);
  } catch {
    return false;
  }
  if (
    registered.protocol !== "http:" ||
    incoming.protocol !== "http:" ||
    !isLoopbackHost(registered.hostname) ||
    !isLoopbackHost(incoming.hostname) ||
    registered.hostname !== incoming.hostname
  ) {
    return false;
  }
  return registered.pathname === incoming.pathname && registered.search === incoming.search;
}
