// Pure waitlist helpers — extracted for unit testing (Wave W, Pioneer 100).
import { randomBytes } from "crypto";

/** Normalize an email for storage/dedupe: trim + lowercase. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Pragmatic email validity (not full RFC 5322 — rejects obvious junk). */
export function isValidEmail(email: string): boolean {
  if (email.length > 320) return false;
  return /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email);
}

/** URL-safe referral code, e.g. "pioneer-9f3k2x". Collision-safe via UNIQUE
 *  key + retry at the insert site. */
export function generateReferralCode(): string {
  return randomBytes(6).toString("base64url"); // 8 chars
}

/** Queue position of an entry: its 1-based rank by insertion order. */
export function positionFromRank(countUpToAndIncluding: number): number {
  return Math.max(1, countUpToAndIncluding);
}

export const WAITLIST_ROLES = ["creator", "user", "both"] as const;
export type WaitlistRole = (typeof WAITLIST_ROLES)[number];

export function isWaitlistRole(role: unknown): role is WaitlistRole {
  return typeof role === "string" && (WAITLIST_ROLES as readonly string[]).includes(role);
}
