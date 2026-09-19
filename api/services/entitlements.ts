// ═══════════════════════════════════════════════════════════════════
//  ENTITLEMENTS — the single "can user X do Y" brain (F0.6)
// ═══════════════════════════════════════════════════════════════════
// Resolution order:
//   1. Explicit `entitlements` table rows (unexpired)
//   2. Active/trialing `subscriptions` row → plan capability set
//   3. User's `tier` via TIER_CAPABILITIES
//   4. Unexpired voucher redemption (voucher_redemptions)
//
// Additive only: existing tier checks elsewhere are untouched. Consumers
// (tRPC middleware, MCP layer, UI) should prefer this service for new code.

import { getDb } from "../queries/connection";
import { entitlements, subscriptions, users, voucherRedemptions } from "@db/schema";
import { eq, and, or, gt, isNull } from "drizzle-orm";
import { PLAN_CAPABILITIES } from "../config/plans";
import { logger } from "../lib/logger";

export type EntitlementSource = "tier" | "subscription" | "voucher" | "purchase" | "manual";
export type SubjectType = "user" | "team";

// ─── Tier capability sets ───────────────────────────────────────────
// standard: fixed pipeline, 1 LLM
// pro_designer: + custom pipelines, 3 LLMs, marketplace publishing
// pro_auto: + auto-design
export const TIER_CAPABILITIES: Record<string, ReadonlySet<string>> = {
  standard: new Set(["pipeline:fixed", "llm:1"]),
  pro_designer: new Set(["pipeline:fixed", "llm:1", "pipeline:custom", "llm:3", "marketplace:publish"]),
  pro_auto: new Set(["pipeline:fixed", "llm:1", "pipeline:custom", "llm:3", "marketplace:publish", "pipeline:autodesign"]),
};

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

export interface EntitlementContext {
  teamId?: number;
}

/**
 * Can this user exercise a capability? Checks explicit grants first, then
 * subscription plan, then tier, then voucher redemptions.
 */
export async function can(userId: number, capability: string, ctx?: EntitlementContext): Promise<boolean> {
  const db = getDb();
  const now = new Date();

  // (1) Explicit entitlement rows (user-scoped, unexpired)
  const rows = await db.select({ capability: entitlements.capability })
    .from(entitlements)
    .where(and(
      eq(entitlements.subjectType, "user"),
      eq(entitlements.subjectId, userId),
      eq(entitlements.capability, capability),
      or(isNull(entitlements.expiresAt), gt(entitlements.expiresAt, now)),
    ))
    .limit(1);
  if (rows.length > 0) return true;

  // Team-scoped entitlement rows (when a team context is provided)
  if (ctx?.teamId) {
    const teamRows = await db.select({ capability: entitlements.capability })
      .from(entitlements)
      .where(and(
        eq(entitlements.subjectType, "team"),
        eq(entitlements.subjectId, ctx.teamId),
        eq(entitlements.capability, capability),
        or(isNull(entitlements.expiresAt), gt(entitlements.expiresAt, now)),
      ))
      .limit(1);
    if (teamRows.length > 0) return true;
  }

  // (2) Active/trialing subscription → plan capability set
  const [sub] = await db.select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);
  if (sub && ACTIVE_SUBSCRIPTION_STATUSES.has(sub.status)) {
    const planCaps = PLAN_CAPABILITIES[sub.plan];
    if (planCaps?.has(capability)) return true;
  }

  // (3) Tier capabilities
  const [user] = await db.select({ tier: users.tier })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const tierCaps = user ? TIER_CAPABILITIES[user.tier] : undefined;
  if (tierCaps?.has(capability)) return true;

  // (4) Unexpired voucher redemption → redeemed tier's capabilities
  const [redemption] = await db.select({ tier: voucherRedemptions.tier })
    .from(voucherRedemptions)
    .where(and(
      eq(voucherRedemptions.userId, userId),
      or(isNull(voucherRedemptions.expiresAt), gt(voucherRedemptions.expiresAt, now)),
    ))
    .limit(1);
  if (redemption) {
    const voucherCaps = TIER_CAPABILITIES[redemption.tier];
    if (voucherCaps?.has(capability)) return true;
  }

  return false;
}

/** Grant a capability to a subject. */
export async function grant(opts: {
  subjectType: SubjectType;
  subjectId: number;
  capability: string;
  source: EntitlementSource;
  sourceRef?: string;
  expiresAt?: Date | null;
}): Promise<void> {
  const db = getDb();
  await db.insert(entitlements).values({
    subjectType: opts.subjectType,
    subjectId: opts.subjectId,
    capability: opts.capability,
    source: opts.source,
    sourceRef: opts.sourceRef ?? null,
    expiresAt: opts.expiresAt ?? null,
  });
  logger.info("Entitlement granted", {
    subjectType: opts.subjectType,
    subjectId: opts.subjectId,
    capability: opts.capability,
    source: opts.source,
    sourceRef: opts.sourceRef,
  });
}

/** Revoke matching entitlement rows. Returns the number removed. */
export async function revoke(opts: {
  subjectType: SubjectType;
  subjectId: number;
  capability?: string;
  source?: EntitlementSource;
  sourceRef?: string;
}): Promise<number> {
  const db = getDb();
  const conditions = [
    eq(entitlements.subjectType, opts.subjectType),
    eq(entitlements.subjectId, opts.subjectId),
  ];
  if (opts.capability) conditions.push(eq(entitlements.capability, opts.capability));
  if (opts.source) conditions.push(eq(entitlements.source, opts.source));
  if (opts.sourceRef) conditions.push(eq(entitlements.sourceRef, opts.sourceRef));

  const result = await db.delete(entitlements).where(and(...conditions));
  const count = result[0].affectedRows;
  logger.info("Entitlement revoked", { ...opts, count });
  return count;
}

/**
 * Resolve the FULL capability set for a user — the same union `can()`
 * checks (explicit entitlements + active subscription plan + tier +
 * unexpired voucher redemption), materialized as a sorted list together
 * with the user's raw tier (kept for display/label purposes only).
 *
 * UI consumers (billing.myCapabilities → useCapabilities) use this so
 * adding a plan or product becomes data, not code.
 */
export async function resolveCapabilities(userId: number): Promise<{ capabilities: string[]; tier: string }> {
  const db = getDb();
  const now = new Date();
  const caps = new Set<string>();

  // (1) Explicit entitlement rows (user-scoped, unexpired)
  const active = await getActiveEntitlements("user", userId);
  for (const e of active) caps.add(e.capability);

  // (2) Active/trialing subscription → plan capability set
  const [sub] = await db.select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);
  if (sub && ACTIVE_SUBSCRIPTION_STATUSES.has(sub.status)) {
    const planCaps = PLAN_CAPABILITIES[sub.plan];
    if (planCaps) for (const c of planCaps) caps.add(c);
  }

  // (3) Tier capabilities
  const [user] = await db.select({ tier: users.tier })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const tier = user?.tier ?? "standard";
  const tierCaps = TIER_CAPABILITIES[tier];
  if (tierCaps) for (const c of tierCaps) caps.add(c);

  // (4) Unexpired voucher redemption → redeemed tier's capabilities
  const [redemption] = await db.select({ tier: voucherRedemptions.tier })
    .from(voucherRedemptions)
    .where(and(
      eq(voucherRedemptions.userId, userId),
      or(isNull(voucherRedemptions.expiresAt), gt(voucherRedemptions.expiresAt, now)),
    ))
    .limit(1);
  if (redemption) {
    const voucherCaps = TIER_CAPABILITIES[redemption.tier];
    if (voucherCaps) for (const c of voucherCaps) caps.add(c);
  }

  return { capabilities: [...caps].sort(), tier };
}

export interface ActiveEntitlement {
  capability: string;
  source: EntitlementSource;
  sourceRef: string | null;
  expiresAt: Date | null;
}

/** List a subject's currently-active explicit entitlements. */
export async function getActiveEntitlements(
  subjectType: SubjectType,
  subjectId: number,
): Promise<ActiveEntitlement[]> {
  const db = getDb();
  const now = new Date();
  const rows = await db.select()
    .from(entitlements)
    .where(and(
      eq(entitlements.subjectType, subjectType),
      eq(entitlements.subjectId, subjectId),
      or(isNull(entitlements.expiresAt), gt(entitlements.expiresAt, now)),
    ));
  return rows.map((r) => ({
    capability: r.capability,
    source: r.source,
    sourceRef: r.sourceRef,
    expiresAt: r.expiresAt,
  }));
}
