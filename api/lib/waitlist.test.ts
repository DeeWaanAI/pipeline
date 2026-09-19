import { describe, it, expect } from "vitest";
import {
  normalizeEmail,
  isValidEmail,
  generateReferralCode,
  positionFromRank,
  isWaitlistRole,
} from "./waitlist";

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Alice@Example.COM ")).toBe("alice@example.com");
  });
});

describe("isValidEmail", () => {
  it("accepts normal addresses", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("first.last+tag@sub.domain.com")).toBe(true);
  });
  it("rejects junk", () => {
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("@b.com")).toBe(false);
    expect(isValidEmail("a b@c.com")).toBe(false);
    expect(isValidEmail("")).toBe(false);
  });
  it("rejects over-length addresses", () => {
    expect(isValidEmail(`${"a".repeat(320)}@b.com`)).toBe(false);
  });
});

describe("generateReferralCode", () => {
  it("produces URL-safe 8-char codes", () => {
    const code = generateReferralCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]{8}$/);
  });
  it("is unique across many draws", () => {
    const codes = new Set(Array.from({ length: 1000 }, () => generateReferralCode()));
    expect(codes.size).toBe(1000);
  });
});

describe("positionFromRank", () => {
  it("is 1-based and never below 1", () => {
    expect(positionFromRank(1)).toBe(1);
    expect(positionFromRank(42)).toBe(42);
    expect(positionFromRank(0)).toBe(1);
  });
});

describe("isWaitlistRole", () => {
  it("accepts the three contract roles", () => {
    expect(isWaitlistRole("creator")).toBe(true);
    expect(isWaitlistRole("user")).toBe(true);
    expect(isWaitlistRole("both")).toBe(true);
  });
  it("rejects anything else", () => {
    expect(isWaitlistRole("admin")).toBe(false);
    expect(isWaitlistRole(42)).toBe(false);
    expect(isWaitlistRole(null)).toBe(false);
  });
});
