import { describe, expect, it } from "vitest";
import { isAllowedRedirectUri, redirectUriMatchesRegistration } from "./redirectUri";

// Regression: dynamic client registration used to reject http://localhost
// redirect URIs in production, which killed mcp-remote / Claude Desktop
// (RFC 8252 native-app loopback flow) with "redirect_uris must be https".
describe("isAllowedRedirectUri", () => {
  it("allows https for any host", () => {
    expect(isAllowedRedirectUri("https://app.example.com/oauth/callback")).toBe(true);
    expect(isAllowedRedirectUri("https://localhost/cb")).toBe(true);
  });

  it("allows http loopback in every environment (native-app pattern, RFC 8252)", () => {
    // the exact shape mcp-remote registers: random ephemeral port on localhost
    expect(isAllowedRedirectUri("http://localhost:43258/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:8080/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://[::1]:9000/cb")).toBe(true);
  });

  it("rejects http for non-loopback hosts", () => {
    expect(isAllowedRedirectUri("http://evil.com/cb")).toBe(false);
    expect(isAllowedRedirectUri("http://192.168.1.5/cb")).toBe(false);
    expect(isAllowedRedirectUri("http://10.0.0.2/cb")).toBe(false);
  });

  it("rejects non-http(s) schemes and garbage", () => {
    expect(isAllowedRedirectUri("ftp://localhost/cb")).toBe(false);
    expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isAllowedRedirectUri("not a url")).toBe(false);
    expect(isAllowedRedirectUri("")).toBe(false);
  });
});

// Regression: Qoder (and any RFC 8252 native app) registers once, then binds a
// NEW ephemeral loopback port on every launch while reusing its client_id. The
// old exact-string comparison rejected those and deadlocked re-authentication
// with "redirect_uri does not match registered URIs".
describe("redirectUriMatchesRegistration", () => {
  it("accepts an exact match", () => {
    expect(
      redirectUriMatchesRegistration("http://127.0.0.1:54504/oauth/callback", [
        "http://127.0.0.1:54504/oauth/callback",
      ]),
    ).toBe(true);
    expect(
      redirectUriMatchesRegistration("https://app.example.com/cb", [
        "https://app.example.com/cb",
      ]),
    ).toBe(true);
  });

  it("ignores the port for http loopback, whatever port the app rebinds to", () => {
    const registered = ["http://127.0.0.1:54504/oauth/callback"];
    expect(redirectUriMatchesRegistration("http://127.0.0.1:51234/oauth/callback", registered)).toBe(true);
    expect(redirectUriMatchesRegistration("http://127.0.0.1/oauth/callback", registered)).toBe(true);
    expect(redirectUriMatchesRegistration("http://localhost:9999/cb", ["http://localhost:1/cb"])).toBe(true);
    expect(redirectUriMatchesRegistration("http://[::1]:700/cb", ["http://[::1]:80/cb"])).toBe(true);
  });

  it("still pins scheme, host, path and query on loopback", () => {
    const registered = ["http://127.0.0.1:54504/oauth/callback"];
    expect(redirectUriMatchesRegistration("http://127.0.0.1:51234/other", registered)).toBe(false);
    expect(redirectUriMatchesRegistration("http://localhost:51234/oauth/callback", registered)).toBe(false);
    expect(redirectUriMatchesRegistration("https://127.0.0.1:51234/oauth/callback", registered)).toBe(false);
    expect(redirectUriMatchesRegistration("http://127.0.0.1:51234/oauth/callback?a=b", registered)).toBe(false);
  });

  it("pins the port for https and for non-loopback http", () => {
    expect(redirectUriMatchesRegistration("https://app.example.com:8443/cb", ["https://app.example.com/cb"])).toBe(false);
    expect(redirectUriMatchesRegistration("http://192.168.1.5:8080/cb", ["http://192.168.1.5/cb"])).toBe(false);
  });

  it("rejects an unregistered client and unparsable input", () => {
    expect(redirectUriMatchesRegistration("http://127.0.0.1:1234/cb", [])).toBe(false);
    expect(redirectUriMatchesRegistration("not a url", ["http://127.0.0.1:1234/cb"])).toBe(false);
    expect(redirectUriMatchesRegistration("", ["http://127.0.0.1:1234/cb"])).toBe(false);
  });
});
