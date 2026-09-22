// ═══════════════════════════════════════════════════════════════════
//  ENTITLEMENTS — the single "can user X do Y" brain (F0.6)
// ═══════════════════════════════════════════════════════════════════
// Resolution order — there is exactly one arm now:
//   1. Explicit `entitlements` table rows (unexpired). This is where a
//      marketplace purchase (`pipeline:run:<listingId>`, see
//      api/services/entitlementSync.ts) and any manual/admin grant live.
//
// There used to be three more arms below: an active/trialing subscription
// mapped through PLAN_CAPABILITIES, `users.tier` mapped through
// TIER_CAPABILITIES, and an unexpired voucher redemption mapped through the
// redeemed tier. All three were removed with the tier ladder and the plan
// ladder (owner decision 2026-09-22): DeeWaanAI sells ONE flat monthly
// per-account subscription with a 7-day trial from signup and BYO keys, so no
// capability is bought by tier — IF/WHILE pipelines and auto-design are open
// to every signed-in account, and LLM spend is always the user's own.
//
// Additive only: `users.tier`, `vouchers.tier` and `voucher_redemptions.tier`
// stay in the database and voucher redemption keeps writing them (unread
// legacy data); `entitlements.subject_type`/`execution_grants.subject_type`
// still accept the stored value "team". No migration touches any of them.

import { getDb } from "../queries/connection";
import { entitlements } from "@db/schema";
import { eq, and, or, gt, isNull } from "drizzle-orm";
import { logger } from "../lib/logger";

export type EntitlementSource = "tier" | "subscription" | "voucher" | "purchase" | "manual";

/** Subjects an entitlement row can be filed against. The `subject_type`
 *  column still stores "team" for historical rows; nothing reads those. */
export type SubjectType = "user";

/**
 * Can this user exercise a capability? Only an explicit, unexpired
 * `entitlements` row counts — everything else is open by default.
 */
export async function can(userId: number, capability: string): Promise<boolean> {
  const db = getDb();
  const now = new Date();

  const rows = await db.select({ capability: entitlements.capability })
    .from(entitlements)
    .where(and(
      eq(entitlements.subjectType, "user"),
      eq(entitlements.subjectId, userId),
      eq(entitlements.capability, capability),
      or(isNull(entitlements.expiresAt), gt(entitlements.expiresAt, now)),
    ))
    .limit(1);
  return rows.length > 0;
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
 * Resolve the capability set for a user — today that is exactly their
 * unexpired explicit entitlement rows, i.e. "what you own": the marketplace
 * pipelines you have bought (plus any manual grant). No plan, tier or
 * voucher feeds this any more.
 *
 * UI consumers (billing.myCapabilities) use this so adding a product stays
 * data, not code.
 */
export async function resolveCapabilities(userId: number): Promise<{ capabilities: string[] }> {
  const caps = new Set<string>();
  const active = await getActiveEntitlements("user", userId);
  for (const e of active) caps.add(e.capability);
  return { capabilities: [...caps].sort() };
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
