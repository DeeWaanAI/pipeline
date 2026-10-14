// ═══════════════════════════════════════════════════════════════════
//  EXECUTION RIGHT — who may receive a listing's certified version (v3)
// ═══════════════════════════════════════════════════════════════════
// The v3 product sells a listing as a COPY: the buyer's own editable pipeline,
// run on the buyer's own keys. What this module decides is the one question both
// halves of that promise share — does this account hold a live right to this
// listing's certified version? — and it answers it from DATA, never from a blob
// the caller supplies: a purchase row or an execution grant row, matched to the
// version being handed over.
//
// It used to live inside the protected-execution service, which the v3 cut
// deleted (Class B is gone: nothing runs the seller's graph on anyone's server).
// The resolver survived because delivery and the buyer-facing evidence view both
// need exactly this check and nothing else from that file: no egress policy, no
// swarm dispatch, no feature flag.
//
// Two rules that must not drift:
//  1. A refund, a revocation or a lapse closes this door. The checks below read
//     current row state on every call, so "you bought it" is re-established per
//     request rather than cached into a token.
//  2. The version handed over is the version the RECEIPT names. A purchase that
//     predates version receipting (migration 029) names none, and then the
//     listing's current version is what the buyer gets — reported as
//     `legacy_current` so the caller can say so out loud instead of implying a
//     bound delivery that never existed.

import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import {
  executionGrants,
  marketplaceListingV2,
  marketplaceListings,
  marketplacePurchases,
} from "@db/schema";
import type { ExecutionPurpose } from "../../contracts/offeringV2";
import { getDb } from "../queries/connection";

export class ExecutionRightError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ExecutionRightError";
    this.code = code;
  }
}

export interface ExecutionRight {
  listing: typeof marketplaceListings.$inferSelect;
  soldVersionId: number;
  sellerId: number;
  grant: typeof executionGrants.$inferSelect | null;
  purchase: typeof marketplacePurchases.$inferSelect | null;
  versionBinding: "purchase_receipt" | "grant" | "legacy_current";
}

export async function resolveProtectedExecutionRight(opts: {
  buyerId: number;
  listingId: number;
  purpose: ExecutionPurpose;
  workflowVersionId?: number;
}): Promise<ExecutionRight> {
  const db = getDb();
  const [listing] = await db.select().from(marketplaceListings)
    .where(eq(marketplaceListings.id, opts.listingId)).limit(1);
  if (!listing) throw new ExecutionRightError("not_found_or_not_authorized", "listing is not available");
  if (opts.purpose !== "buyer_execution" && opts.purpose !== "trial") {
    throw new ExecutionRightError("purpose_not_permitted", `'${opts.purpose}' is not a buyer execution purpose`);
  }
  if (listing.status !== "published" && (listing.status !== "unpublished" || opts.purpose === "trial")) {
    throw new ExecutionRightError("listing_not_published", "this listing is not currently available to run");
  }
  const [v2] = await db.select().from(marketplaceListingV2)
    .where(eq(marketplaceListingV2.listingId, listing.id)).limit(1);
  if (v2?.publicationMode !== "v2" || !v2.currentWorkflowVersionId) {
    throw new ExecutionRightError("not_a_v2_listing", "delivery requires a listing published with a v2 workflow version and evidence");
  }
  const now = new Date();
  const grants = await db.select().from(executionGrants)
    .where(and(
      eq(executionGrants.subjectType, "user"),
      eq(executionGrants.subjectId, opts.buyerId),
      eq(executionGrants.listingId, listing.id),
      eq(executionGrants.state, "active"),
      or(isNull(executionGrants.expiresAt), gt(executionGrants.expiresAt, now)),
    )).orderBy(desc(executionGrants.grantedAt), desc(executionGrants.id));
  const [purchase] = await db.select().from(marketplacePurchases)
    .where(and(
      eq(marketplacePurchases.buyerId, opts.buyerId),
      eq(marketplacePurchases.listingId, listing.id),
      eq(marketplacePurchases.status, "active"),
      or(eq(marketplacePurchases.isSubscription, false), isNull(marketplacePurchases.isSubscription), gt(marketplacePurchases.subscriptionEnd, now)),
    )).orderBy(desc(marketplacePurchases.id)).limit(1);

  const soldVersionId = opts.workflowVersionId ?? purchase?.workflowVersionId
    ?? grants.find((g) => g.workflowVersionId)?.workflowVersionId ?? v2.currentWorkflowVersionId;
  const grant = grants.find((g) => (g.workflowVersionId ?? v2.currentWorkflowVersionId) === soldVersionId);
  // Unversioned legacy receipts retain their existing current-version semantics.
  const purchaseMatches = purchase && (purchase.workflowVersionId ?? v2.currentWorkflowVersionId) === soldVersionId;
  if (!grant && !purchaseMatches) {
    throw new ExecutionRightError("not_entitled", "no active execution right for this workflow version");
  }
  return {
    listing, soldVersionId, sellerId: listing.creatorId,
    grant: grant ?? null, purchase: purchaseMatches ? purchase : null,
    versionBinding: purchaseMatches && purchase.workflowVersionId ? "purchase_receipt" : grant?.workflowVersionId ? "grant" : "legacy_current",
  };
}
