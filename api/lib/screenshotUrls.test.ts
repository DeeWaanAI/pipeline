// Pure-function tests for signed screenshot URLs (auditor follow-up:
// short-lived, file-scoped signatures instead of session-JWT query params).
// No DB/network: signing is HMAC over "<filename>.<exp>".

import { describe, it, expect } from "vitest";
import {
  signScreenshotUrl,
  verifyScreenshotSignature,
  SCREENSHOT_URL_TTL_MS,
} from "./screenshotUrls";

const NOW = 1_800_000_000_000;

function parseSigned(url: string): { filename: string; exp: string; sig: string } {
  const m = url.match(/^\/feedback-screenshots\/([^?]+)\?exp=(\d+)&sig=([0-9a-f]{64})$/);
  if (!m) throw new Error(`not a signed url: ${url}`);
  return { filename: m[1], exp: m[2], sig: m[3] };
}

describe("signScreenshotUrl / verifyScreenshotSignature", () => {
  it("round-trips: a signed URL verifies within its TTL", () => {
    const url = signScreenshotUrl("/feedback-screenshots/abc123.png", NOW);
    const { filename, exp, sig } = parseSigned(url);
    expect(filename).toBe("abc123.png");
    expect(Number(exp)).toBe(NOW + SCREENSHOT_URL_TTL_MS);
    expect(verifyScreenshotSignature(filename, exp, sig, NOW)).toBe(true);
  });

  it("rejects an expired signature", () => {
    const url = signScreenshotUrl("/feedback-screenshots/abc123.png", NOW);
    const { filename, exp, sig } = parseSigned(url);
    const afterExpiry = NOW + SCREENSHOT_URL_TTL_MS + 1;
    expect(verifyScreenshotSignature(filename, exp, sig, afterExpiry)).toBe(false);
  });

  it("is file-scoped: the signature does not authorize a different file", () => {
    const url = signScreenshotUrl("/feedback-screenshots/abc123.png", NOW);
    const { exp, sig } = parseSigned(url);
    expect(verifyScreenshotSignature("other456.png", exp, sig, NOW)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const url = signScreenshotUrl("/feedback-screenshots/abc123.png", NOW);
    const { filename, exp, sig } = parseSigned(url);
    const flipped = (sig.at(-1) === "0" ? "1" : "0");
    expect(verifyScreenshotSignature(filename, exp, sig.slice(0, -1) + flipped, NOW)).toBe(false);
  });

  it("rejects malformed exp/sig without throwing", () => {
    expect(verifyScreenshotSignature("a.png", "not-a-number", "deadbeef", NOW)).toBe(false);
    expect(verifyScreenshotSignature("a.png", String(NOW + 1000), "zz", NOW)).toBe(false);
    expect(verifyScreenshotSignature("a.png", undefined, undefined, NOW)).toBe(false);
  });

  it("passes non-screenshot URLs through unchanged", () => {
    expect(signScreenshotUrl("https://example.com/page", NOW)).toBe("https://example.com/page");
  });

  it("strips directory traversal before signing", () => {
    const url = signScreenshotUrl("/feedback-screenshots/../../etc/passwd", NOW);
    const { filename, exp, sig } = parseSigned(url);
    expect(filename).toBe("passwd");
    expect(verifyScreenshotSignature("passwd", exp, sig, NOW)).toBe(true);
  });
});
