import { describe, expect, it } from "vitest";
import { isAllowedRedirectUri } from "./redirectUri";

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
