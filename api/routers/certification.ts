// ═══════════════════════════════════════════════════════════════════
//  CERTIFICATION ROUTER — public certification report data (Phase 1)
// ═══════════════════════════════════════════════════════════════════
// Powers the public, SEO-critical certification report page
// (/certification/:id) and the embeddable badge endpoint
// (api/certification-badge-route.ts). Only certified listings
// (approved/published) are exposed — drafts, in-review and rejected
// listings answer NOT_FOUND so internal states never leak publicly.

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getReadDb } from "../queries/connection";
import { marketplaceListings, listingReviews } from "@db/schema";
import { eq, and, ne, inArray, sql } from "drizzle-orm";

const CERTIFIED_STATUSES = ["approved", "published"] as const;

// Public, non-personalized certification JSON — safe for shared/CDN caches.
// Keeps fresh at the edge (s-maxage=3600) while browsers revalidate sooner.
const PUBLIC_CACHE_CONTROL = "public, max-age=300, s-maxage=3600";

const DIMENSIONS = [
  "accuracy",
  "completeness",
  "clarity",
  "tokenEfficiency",
  "speed",
  "consistency",
] as const;

export const certificationRouter = createRouter({
  // Public certification report for one listing.
  report: publicQuery
    .input(z.object({ listingId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const db = getReadDb();
      const [listing] = await db
        .select()
        .from(marketplaceListings)
        .where(and(
          eq(marketplaceListings.id, input.listingId),
          inArray(marketplaceListings.status, [...CERTIFIED_STATUSES]),
        ))
        .limit(1);

      if (!listing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Certification report not found" });
      }

      // Aggregate per-dimension averages across all human reviews,
      // excluding any from the designer (they never count — Phase 1 rule).
      const [agg] = await db
        .select({
          reviews: sql<number>`COUNT(*)`,
          reviewers: sql<number>`COUNT(DISTINCT ${listingReviews.reviewerId})`,
          accuracy: sql<number>`ROUND(AVG(${listingReviews.accuracy}), 2)`,
          completeness: sql<number>`ROUND(AVG(${listingReviews.completeness}), 2)`,
          clarity: sql<number>`ROUND(AVG(${listingReviews.clarity}), 2)`,
          tokenEfficiency: sql<number>`ROUND(AVG(${listingReviews.tokenEfficiency}), 2)`,
          speed: sql<number>`ROUND(AVG(${listingReviews.speed}), 2)`,
          consistency: sql<number>`ROUND(AVG(${listingReviews.consistency}), 2)`,
        })
        .from(listingReviews)
        .where(and(
          eq(listingReviews.listingId, input.listingId),
          ne(listingReviews.reviewerId, listing.creatorId),
        ));

      const dimensions: Record<string, number> = {};
      for (const d of DIMENSIONS) {
        dimensions[d] = Number(agg?.[d] ?? 0);
      }

      ctx.resHeaders.set("Cache-Control", PUBLIC_CACHE_CONTROL);
      return {
        listingId: listing.id,
        title: listing.title,
        description: listing.description,
        category: listing.category,
        status: listing.status,
        grade: listing.grade !== null ? Number(listing.grade) : null,
        kappaScore: listing.kappaScore !== null ? Number(listing.kappaScore) : null,
        reviewCount: Number(agg?.reviews ?? 0),
        uniqueReviewers: Number(agg?.reviewers ?? 0),
        dimensions,
        price: Number(listing.price),
        certifiedAt: listing.updatedAt,
      };
    }),

  // Compact badge payload (the SVG itself is served by the Hono route).
  badge: publicQuery
    .input(z.object({ listingId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const db = getReadDb();
      const [listing] = await db
        .select({ id: marketplaceListings.id, grade: marketplaceListings.grade, status: marketplaceListings.status })
        .from(marketplaceListings)
        .where(and(
          eq(marketplaceListings.id, input.listingId),
          inArray(marketplaceListings.status, [...CERTIFIED_STATUSES]),
        ))
        .limit(1);

      if (!listing || listing.grade === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Badge not available" });
      }
      ctx.resHeaders.set("Cache-Control", PUBLIC_CACHE_CONTROL);
      return { listingId: listing.id, grade: Number(listing.grade) };
    }),
});
