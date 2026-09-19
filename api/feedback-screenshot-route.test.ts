// Pure-function tests for the screenshot GET-route access decision
// (spec 0.9c): signed-URL path unchanged; the x-local-auth-token header
// path is admin-only — non-admin → "forbidden" (403), missing/invalid
// token → "unauthorized" (401).
// No DB/network: decideScreenshotReadAccess is a pure function; the route
// resolves the inputs (signature check, token verify, role fetch) itself.

import { describe, it, expect } from "vitest";
import { decideScreenshotReadAccess } from "./feedback-screenshot-route";

describe("decideScreenshotReadAccess (spec 0.9c)", () => {
  it("allows a valid file-scoped signed URL with no token at all", () => {
    expect(
      decideScreenshotReadAccess({
        signedUrlValid: true,
        tokenPresent: false,
        tokenValid: false,
        isAdmin: false,
      }),
    ).toBe("allow");
  });

  it("allows a valid signed URL for a NON-admin user (owner pre-signed URL)", () => {
    // Owners are ordinary users; their listing procedures hand them
    // server-pre-signed URLs. The admin restriction must not block them.
    expect(
      decideScreenshotReadAccess({
        signedUrlValid: true,
        tokenPresent: true,
        tokenValid: true,
        isAdmin: false,
      }),
    ).toBe("allow");
  });

  it("allows an admin token without a signed URL", () => {
    expect(
      decideScreenshotReadAccess({
        signedUrlValid: false,
        tokenPresent: true,
        tokenValid: true,
        isAdmin: true,
      }),
    ).toBe("allow");
  });

  it("forbids (403) a valid non-admin token without a signed URL", () => {
    expect(
      decideScreenshotReadAccess({
        signedUrlValid: false,
        tokenPresent: true,
        tokenValid: true,
        isAdmin: false,
      }),
    ).toBe("forbidden");
  });

  it("rejects (401) an invalid/expired token", () => {
    expect(
      decideScreenshotReadAccess({
        signedUrlValid: false,
        tokenPresent: true,
        tokenValid: false,
        isAdmin: false,
      }),
    ).toBe("unauthorized");
  });

  it("rejects (401) when no credentials are presented at all", () => {
    expect(
      decideScreenshotReadAccess({
        signedUrlValid: false,
        tokenPresent: false,
        tokenValid: false,
        isAdmin: false,
      }),
    ).toBe("unauthorized");
  });

  it("signed URL wins over an invalid token (img loads never send headers)", () => {
    expect(
      decideScreenshotReadAccess({
        signedUrlValid: true,
        tokenPresent: true,
        tokenValid: false,
        isAdmin: false,
      }),
    ).toBe("allow");
  });
});
