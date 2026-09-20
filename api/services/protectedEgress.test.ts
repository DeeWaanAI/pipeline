// Unit tests for the trusted-egress policy (offering redesign v2, spec §8.2;
// acceptance A13). Pure functions only — no DB, no network. The point of these
// cases is that a BUYER-CONTROLLED destination cannot qualify as a trusted
// executor, including the shapes that slip past a substring check.

import { describe, expect, it } from "vitest";
import {
  blockedHostReason, normalizeEndpointUrl, resolvedAdapterKind,
} from "./protectedEgress";

describe("protected egress endpoint policy (§8.2 / A13)", () => {
  it("accepts a plain https first-party endpoint and canonicalizes it", () => {
    expect(normalizeEndpointUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
    // Case and the default port carry no meaning, so both fold to the same key.
    expect(normalizeEndpointUrl("HTTPS://API.OpenAI.com:443/v1")).toBe("https://api.openai.com/v1");
  });

  it("refuses anything that is not https", () => {
    expect(() => normalizeEndpointUrl("http://api.openai.com/v1")).toThrow(/insecure_transport/);
  });

  it("refuses a destination smuggled into the URL itself", () => {
    // userinfo: the classic "looks like the approved host" trick
    expect(() => normalizeEndpointUrl("https://api.openai.com@evil.example/v1")).toThrow(/embedded_credentials/);
    // a query could carry a target for a permissive proxy
    expect(() => normalizeEndpointUrl("https://api.openai.com/v1?next=http://evil.example")).toThrow(/query_or_fragment/);
    expect(() => normalizeEndpointUrl("https://api.openai.com/v1#http://evil.example")).toThrow(/query_or_fragment/);
    // not even a URL
    expect(() => normalizeEndpointUrl("api.openai.com")).toThrow(/url_unparseable/);
    expect(() => normalizeEndpointUrl("file:///etc/passwd")).toThrow(/insecure_transport/);
  });

  it("refuses private, loopback, link-local, metadata and CGNAT destinations", () => {
    const blocked = [
      "https://127.0.0.1:8443/v1",
      "https://localhost/v1",
      "https://0.0.0.0/v1",
      "https://10.4.5.6/v1",
      "https://172.16.0.9/v1",
      "https://192.168.1.1/v1",
      "https://169.254.169.254/latest/meta-data",   // cloud metadata
      "https://100.64.0.1/v1",                       // CGNAT
      "https://[::1]/v1",
      "https://[fd00::12]/v1",
      "https://db.internal/v1",
      "https://printer.local/v1",
      "https://metadata.google.internal/v1",
    ];
    for (const url of blocked) expect(() => normalizeEndpointUrl(url)).toThrow(/blocked_destination|insecure_transport/);
  });

  it("catches the numeric host forms that a string prefix test would miss", () => {
    expect(blockedHostReason("127.1.2.3")).toBe("private or loopback IPv4");
    expect(blockedHostReason("8.8.8.8")).toBeNull();                     // public, fine
    expect(blockedHostReason("300.1.1.1")).toBe("malformed IPv4 literal");
    expect(blockedHostReason("169.254.1.1")).toBe("link-local IPv4 (cloud metadata)");
  });

  it("never guesses an adapter: identity is part of the approval", () => {
    expect(resolvedAdapterKind("anthropic")).toBe("anthropic");
    // every other slug routes through the openai-compatible adapter, so an
    // approval row naming "anthropic" cannot authorize them
    expect(resolvedAdapterKind("openai")).toBe("openai_compatible");
    expect(resolvedAdapterKind("some-aggregator")).toBe("openai_compatible");
  });
});
