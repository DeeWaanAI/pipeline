// Legacy/v2 publication isolation (offering redesign v2, spec §10.1, §10.2).
//
// `marketplace.publishVersion` is the SOLE boundary that may publish a listing
// whose `publicationMode` is `v2`. The legacy certification pipeline (submit →
// generating → certifying → blind review → published/rejected) writes
// `marketplaceListings.status` from ~18 places across two routers, so the rule
// cannot live at the call sites — a guard that must be remembered is a guard
// that gets forgotten. Every legacy status write goes through
// `setLegacyListingStatus`, which refuses once a listing is v2-owned.
//
// Why a lock and not just a read: a seller can flip a listing to v2 mode while
// a background review aggregation is mid-flight. Both this module and
// `publishVersion` lock the LISTING row first, so the mode check and the write
// are one atomic step instead of a read-then-overwrite race.

import { eq } from "drizzle-orm";
import { marketplaceListings, marketplaceListingV2 } from "@db/schema";
import { getDb } from "../queries/connection";
import { logger } from "../lib/logger";
import { lockForUpdate } from "../queries/connection";

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type ListingPublicationMode = "legacy" | "v2";

/** `legacy` when the listing has no v2 row yet — the sidecar only exists once
 *  the v2 boundary has touched it. */
export async function getPublicationMode(
  executor: Db | Tx,
  listingId: number,
): Promise<ListingPublicationMode> {
  const [row] = await executor
    .select({ mode: marketplaceListingV2.publicationMode })
    .from(marketplaceListingV2)
    .where(eq(marketplaceListingV2.listingId, listingId))
    .limit(1);
  return row?.mode === "v2" ? "v2" : "legacy";
}

export class V2PublicationLockedError extends Error {
  readonly code = "v2_publication_locked";
  constructor(listingId: number, attempted: string) {
    super(
      `v2_publication_locked: listing ${listingId} is published under the v2 evidence rules; ` +
        `the legacy certification flow cannot change it (${attempted}). Use marketplace.publishVersion.`,
    );
    this.name = "V2PublicationLockedError";
  }
}

/** Throw if a legacy flow may not touch this listing. Non-transactional: use
 *  for early, friendly refusals (e.g. before deleting a listing). */
export async function assertLegacyFlowAllowed(listingId: number, attempted: string): Promise<void> {
  if ((await getPublicationMode(getDb(), listingId)) === "v2") throw new V2PublicationLockedError(listingId, attempted);
}

/**
 * The ONLY way legacy code may set a listing's workflow status once v2 exists.
 * Refuses (and writes nothing) for v2 listings. `ownerId` preserves the
 * creator-scoped WHERE some legacy writes rely on — moving the check inside the
 * locked transaction instead of before it.
 */
export async function setLegacyListingStatus(
  listingId: number,
  patch: Partial<Pick<typeof marketplaceListings.$inferInsert, "status" | "grade" | "reviewCount" | "kappaScore" | "certifiedAt" | "aiGrade" | "aiFeedback" | "aiReviewedAt">>,
  opts?: { ownerId?: number },
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx: Tx) => {
    // Lock the listing row before reading the mode: `publishVersion` writes
    // this same row inside its transaction, so whoever arrives second waits.
    const [listing] = await lockForUpdate(tx
      .select({ id: marketplaceListings.id, creatorId: marketplaceListings.creatorId })
      .from(marketplaceListings)
      .where(eq(marketplaceListings.id, listingId)))
      .limit(1);
    if (!listing) return; // the listing is gone — a background flow has nothing to update
    if (opts?.ownerId !== undefined && listing.creatorId !== opts.ownerId) {
      throw new Error("not_found_or_not_authorized");
    }
    if (await getPublicationMode(tx, listingId) === "v2") {
      // Asymmetric on purpose. Going TO `unpublished` is a seller taking their
      // own listing out of the market — safe under v2 rules and required for
      // delisting. Every other status is a claim about the listing's standing
      // (certified, rejected, buyable), and under v2 only the evidence boundary
      // may make that claim.
      if (patch.status === "unpublished") {
        await tx.update(marketplaceListings).set(patch).where(eq(marketplaceListings.id, listingId));
        return;
      }
      logger.warn("legacy certification write refused on a v2 listing", {
        listingId, attempted: String(patch.status ?? "unknown"),
      });
      throw new V2PublicationLockedError(listingId, String(patch.status ?? "status change"));
    }
    await tx.update(marketplaceListings).set(patch).where(eq(marketplaceListings.id, listingId));
  });
}
