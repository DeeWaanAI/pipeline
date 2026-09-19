import { describe, it, expect } from "vitest";
import { getClientIp } from "./clientIp";

const headers = (entries: Record<string, string>) => new Headers(entries);

describe("getClientIp — trusted proxy (default)", () => {
  it("uses the first x-forwarded-for entry", () => {
    const ip = getClientIp(
      headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }),
      "192.0.2.1",
      { trustedProxy: true },
    );
    expect(ip).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip, then the socket address", () => {
    expect(
      getClientIp(headers({ "x-real-ip": "198.51.100.9" }), "192.0.2.1", { trustedProxy: true }),
    ).toBe("198.51.100.9");
    expect(getClientIp(headers({}), "192.0.2.1", { trustedProxy: true })).toBe("192.0.2.1");
  });

  it("returns 'unknown' when nothing is available", () => {
    expect(getClientIp(headers({}), undefined, { trustedProxy: true })).toBe("unknown");
  });
});

describe("getClientIp — untrusted proxy (TRUSTED_PROXY=false)", () => {
  it("ignores spoofed forwarding headers and uses the socket address", () => {
    const ip = getClientIp(
      headers({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "198.51.100.9" }),
      "192.0.2.1",
      { trustedProxy: false },
    );
    expect(ip).toBe("192.0.2.1");
  });

  it("fails closed to a shared 'unknown' bucket when no socket address exists", () => {
    expect(
      getClientIp(headers({ "x-forwarded-for": "203.0.113.7" }), undefined, { trustedProxy: false }),
    ).toBe("unknown");
  });
});
