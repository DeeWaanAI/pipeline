// MCP tool: enroll_reviewer — join the reviewer pool to certify marketplace pipelines.
// Reviewers earn points for each completed review, redeemable for subscription days.

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import type { McpTool, McpAuthContext } from "../types";
import { getDb } from "../../queries/connection";
import { reviewerProfiles, reviewAssignments, marketplaceListings } from "@db/schema";
import { env } from "../../lib/env";

const inputSchema = z.object({});

export const enrollReviewer: McpTool = {
  name: "enroll_reviewer",
  description:
    "Join the marketplace reviewer pool. Reviewers evaluate pipeline test outputs and earn points redeemable for subscription days. Once enrolled, you will be auto-assigned to pending marketplace listings.",
  inputSchema,
  requiredScopes: ["mcp:write"],
  annotations: { readOnlyHint: false, destructiveHint: false },
  handler: async (_args: unknown, ctx: McpAuthContext) => {
    const db = getDb();

    const [existing] = await db
      .select()
      .from(reviewerProfiles)
      .where(eq(reviewerProfiles.userId, ctx.userId));

    if (existing) {
      return {
        enrolled: true,
        message: "You are already enrolled as a reviewer.",
        trustScore: existing.trustScore,
        reviewsCompleted: existing.reviewsCompleted,
        pointsEarned: existing.pointsEarned,
        pointsBalance: existing.pointsBalance,
      };
    }

    await db.insert(reviewerProfiles).values({
      userId: ctx.userId,
      trustScore: 100,
      reviewsCompleted: 0,
      reviewsFlagged: 0,
      arbiterRulingsAgainst: 0,
      pointsEarned: 0,
      pointsBalance: 0,
      subscriptionDays: 0,
      isActive: true,
      status: "active",
    });

    // Auto-assign to all pending_review listings
    const pendingListings = await db
      .select({ id: marketplaceListings.id, creatorId: marketplaceListings.creatorId })
      .from(marketplaceListings)
      .where(eq(marketplaceListings.status, "pending_review"));

    let assignmentsCreated = 0;
    for (const listing of pendingListings) {
      // In beta (MIN_REVIEWERS=1), allow self-review so creators can test the flow.
      // In production (MIN_REVIEWERS>=2), designers cannot review their own pipelines.
      if (env.marketplaceMinReviewers > 1 && listing.creatorId === ctx.userId) continue;

      const [dup] = await db
        .select()
        .from(reviewAssignments)
        .where(and(
          eq(reviewAssignments.listingId, listing.id),
          eq(reviewAssignments.reviewerId, ctx.userId),
        ))
        .limit(1);

      if (!dup) {
        await db.insert(reviewAssignments).values({
          listingId: listing.id,
          reviewerId: ctx.userId,
          status: "pending",
          dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });
        assignmentsCreated++;
      }
    }

    return {
      enrolled: true,
      message: `Enrolled as reviewer! ${assignmentsCreated} assignment(s) ready for review.`,
      assignmentsCreated,
      trustScore: 100,
      nextSteps: assignmentsCreated > 0
        ? "Use my_marketplace_listings to see your assignments, then submit reviews via the platform."
        : "No pending listings right now. Check back later or submit your own pipeline for review.",
    };
  },
};
