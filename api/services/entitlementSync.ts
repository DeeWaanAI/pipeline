// ═══════════════════════════════════════════════════════════════════
//  ENTITLEMENT SYNC — purchase/refund → entitlements writes (Phase 1)
// ═══════════════════════════════════════════════════════════════════
// The single write-path between marketplace purchases and the
// entitlements brain (F0.6). Called only from the Stripe webhook
// (billingService) — never from the purchase mutation itself, so a
// purchase exists only after Stripe confirms payment.
//
// Capability contract: `pipeline:run:<listingId>` — this is what
// list_pipelines unions into the buyer's tool list ("buy once, run in
// your app"). The existing deposit/refund-ledger/Kappa logic is
// untouched: this service only adds the purchase ledger row, the sales
// counter, and the entitlement grant/revoke.

import { getDb } from "../queries/connection";
import { evidencePublications, marketplaceListingV2, marketplacePurchases, marketplaceListings } from "@db/schema";
import { eq, and, sql } from "drizzle-orm";
import * as entitlementService from "./entitlements";
import { logger } from "../lib/logger";

const PLATFORM_FEE_RATE = 0.30;

/** Capability string granted to a buyer for one listing. */
export function purchaseCapability(listingId: number): string {
  return `pipeline:run:${listingId}`;
}

/**
 * Fulfill a paid marketplace purchase. Idempotent per Stripe session:
 * a duplicate delivery of checkout.session.completed is a no-op.
 */
export async function fulfillMarketplacePurchase(opts: {
  userId: number;
  listingId: number;
  amountPaid: number; // major units (e.g. dollars)
  stripeSessionId: string;
  stripePaymentIntentId: string | null;
}): Promise<{ purchaseId: number; duplicate?: boolean }> {
  const db = getDb();

  // Defense-in-depth buyability re-check (Batch: marketplace trust).
  // The checkout-creation mutation already rejects non-"published" listings,
  // but a listing can leave "published" between checkout creation and payment
  // (rejected by reviewers, delisted). Fail closed: refuse to write the
  // purchase. Throwing makes the webhook return 500 → Stripe retries and the
  // alert surfaces in logs; the payment itself then needs a manual refund.
  const [listing] = await db
    .select({ status: marketplaceListings.status })
    .from(marketplaceListings)
    .where(eq(marketplaceListings.id, opts.listingId))
    .limit(1);
  if (!listing || listing.status !== "published") {
    logger.error("Refusing to fulfill purchase of non-buyable listing", {
      userId: opts.userId,
      listingId: opts.listingId,
      listingStatus: listing?.status ?? "missing",
      stripeSessionId: opts.stripeSessionId,
    });
    throw new Error(`Listing ${opts.listingId} is not buyable (status: ${listing?.status ?? "missing"})`);
  }

  // Idempotency: same Stripe session, or buyer already owns the listing.
  const [existing] = await db
    .select({ id: marketplacePurchases.id })
    .from(marketplacePurchases)
    .where(and(
      eq(marketplacePurchases.buyerId, opts.userId),
      eq(marketplacePurchases.listingId, opts.listingId),
      eq(marketplacePurchases.status, "active"),
    ))
    .limit(1);
  if (existing) {
    logger.info("Purchase already fulfilled — skipping", {
      userId: opts.userId,
      listingId: opts.listingId,
      stripeSessionId: opts.stripeSessionId,
    });
    return { purchaseId: existing.id, duplicate: true };
  }

  const [v2] = await db.select().from(marketplaceListingV2)
    .where(eq(marketplaceListingV2.listingId, opts.listingId)).limit(1);
  if (v2?.publicationMode === "v2") {
    const [evidence] = v2.currentEvidencePublicationId
      ? await db.select().from(evidencePublications).where(and(
        eq(evidencePublications.id, v2.currentEvidencePublicationId),
        eq(evidencePublications.listingId, opts.listingId),
        eq(evidencePublications.state, "published"),
      )).limit(1) : [];
    if (!v2.currentWorkflowVersionId || !evidence || evidence.listingWorkflowVersionId !== v2.currentWorkflowVersionId) {
      throw new Error("Listing has no matching published version and evidence");
    }
  }
  const platformFee = opts.amountPaid * PLATFORM_FEE_RATE;
  const creatorEarnings = opts.amountPaid - platformFee;

  const insertResult = await db.insert(marketplacePurchases).values({
    buyerId: opts.userId,
    workflowVersionId: v2?.publicationMode === "v2" ? v2.currentWorkflowVersionId : null,
    evidencePublicationId: v2?.publicationMode === "v2" ? v2.currentEvidencePublicationId : null,
    listingId: opts.listingId,
    amountPaid: opts.amountPaid.toFixed(2),
    platformFee: platformFee.toFixed(2),
    creatorEarnings: creatorEarnings.toFixed(2),
    isSubscription: false,
    status: "active",
    stripeSessionId: opts.stripeSessionId,
    stripePaymentIntentId: opts.stripePaymentIntentId,
  });
  const purchaseId = Number((insertResult[0] as { insertId?: number }).insertId ?? 0);

  await db
    .update(marketplaceListings)
    .set({ salesCount: sql`${marketplaceListings.salesCount} + 1` })
    .where(eq(marketplaceListings.id, opts.listingId));

  // Grant the "run this pipeline" entitlement — no expiry (one-time buy).
  // Skip if a grant for this session already exists (defensive).
  const grants = await entitlementService.getActiveEntitlements("user", opts.userId);
  const capability = purchaseCapability(opts.listingId);
  if (!grants.some((g) => g.capability === capability && g.sourceRef === opts.stripeSessionId)) {
    await entitlementService.grant({
      subjectType: "user",
      subjectId: opts.userId,
      capability,
      source: "purchase",
      sourceRef: opts.stripeSessionId,
    });
  }

  logger.info("Marketplace purchase fulfilled", {
    purchaseId,
    userId: opts.userId,
    listingId: opts.listingId,
    amountPaid: opts.amountPaid,
  });
  return { purchaseId };
}

/**
 * Revoke a purchase after a Stripe refund. Matches by payment intent
 * (the stable identifier present on charge.refunded events).
 */
export async function revokeMarketplacePurchase(opts: {
  stripePaymentIntentId: string;
}): Promise<{ revoked: boolean }> {
  const db = getDb();
  const [purchase] = await db
    .select()
    .from(marketplacePurchases)
    .where(and(
      eq(marketplacePurchases.stripePaymentIntentId, opts.stripePaymentIntentId),
      eq(marketplacePurchases.status, "active"),
    ))
    .limit(1);

  if (!purchase) {
    logger.warn("Refund for unknown or already-revoked purchase", {
      stripePaymentIntentId: opts.stripePaymentIntentId,
    });
    return { revoked: false };
  }

  await db
    .update(marketplacePurchases)
    .set({ status: "refunded" })
    .where(eq(marketplacePurchases.id, purchase.id));

  await db
    .update(marketplaceListings)
    .set({ salesCount: sql`GREATEST(${marketplaceListings.salesCount} - 1, 0)` })
    .where(eq(marketplaceListings.id, purchase.listingId));

  const removed = await entitlementService.revoke({
    subjectType: "user",
    subjectId: purchase.buyerId,
    capability: purchaseCapability(purchase.listingId),
    source: "purchase",
    sourceRef: purchase.stripeSessionId ?? undefined,
  });

  logger.info("Marketplace purchase refunded + entitlement revoked", {
    purchaseId: purchase.id,
    userId: purchase.buyerId,
    listingId: purchase.listingId,
    entitlementsRemoved: removed,
  });
  return { revoked: true };
}
