// MCP tools: Marketplace — publish, track, and buy pipelines.
// Reuses existing backend logic where possible.

import { z } from "zod";
import { eq, and, ne, desc, sql } from "drizzle-orm";
import type { McpTool, McpAuthContext } from "../types";
import { getDb } from "../../queries/connection";
import {
  projects,
  pipelineTemplates,
  marketplaceListings,
  encryptedPrompts,
  reviewAssignments,
  listingReviews,
  testPrompts,
  marketplacePurchases,
  users,
} from "@db/schema";
import { encryptPipelineSteps } from "../../lib/marketplaceCrypto";
import { assertOriginalCreatorMayList } from "../../services/workflowLineage";
import { deliverPurchasedCopy, deliverPurchasedCopyInputSchema } from "../../services/pipelineDelivery";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { appRouter } from "../../router";

// ─── Certification policy ──────────────────────────────────────────
// Override via env vars for beta (e.g., 1/1 for self-certification)
const MIN_UNIQUE_REVIEWERS = env.marketplaceMinReviewers;

// ═══════════════════════════════════════════════════════════════════
// 1. publish_to_marketplace
// ═══════════════════════════════════════════════════════════════════

const PublishSchema = z.object({
  projectId: z.number().int().positive(),
  title: z.string().min(3).max(200),
  description: z.string().max(2000).optional(),
  category: z.enum(["translation", "writing", "code", "analysis", "creative", "other"]).default("other"),
  price: z.number().min(0).max(9999),
  isSubscription: z.boolean().optional(),
  subscriptionPrice: z.number().min(0).optional(),
});

export const publishToMarketplace: McpTool = {
  name: "publish_to_marketplace",
  description:
    "Create a marketplace listing from a pipeline project. Sets price and description. The listing starts as a draft — call submit_for_review when ready.",
  inputSchema: PublishSchema,
  requiredScopes: ["mcp:write"],
  annotations: { readOnlyHint: false, destructiveHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = PublishSchema.parse(args);
    const db = getDb();

    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, input.projectId), eq(projects.userId, ctx.userId)))
      .limit(1);

    if (!project) throw new Error("Project not found or not owned by you");
    if (!project.pipelineTemplateId) {
      throw new Error("Project has no saved pipeline template. Save it as a template in Project Settings first.");
    }

    const [template] = await db
      .select()
      .from(pipelineTemplates)
      .where(and(eq(pipelineTemplates.id, project.pipelineTemplateId), eq(pipelineTemplates.userId, ctx.userId)))
      .limit(1);

    if (!template) throw new Error("Template not found or not owned by you");

    // ONLY THE ORIGINAL CREATOR MAY PUBLISH (owner decision 2026-09-22). The
    // tier capability check that used to stand here was deleted with the tier
    // ladder, which left this boundary with NO publish gate at all —
    // desktop-pass finding 25. The replacement is lineage, not a plan: the
    // project/template carries, as DATA, the account that originally created
    // the work it derives from, and only that account may sell it. A `full`
    // share recipient, an importer or a cloner is refused here even though they
    // own the row in front of them.
    await assertOriginalCreatorMayList({
      userId: ctx.userId, projectId: project.id, templateId: template.id,
    });

    const [listingResult] = await db.insert(marketplaceListings).values({
      creatorId: ctx.userId,
      templateId: template.id,
      title: input.title,
      description: input.description ?? template.description,
      category: input.category,
      price: String(input.price),
      isSubscription: input.isSubscription ?? false,
      subscriptionPrice: input.subscriptionPrice ? String(input.subscriptionPrice) : null,
      status: "draft",
    });

    const listingId = Number(listingResult.insertId);

    // Encrypt and save pipeline prompts
    const encrypted = encryptPipelineSteps(template.steps, listingId);
    for (const ep of encrypted) {
      await db.insert(encryptedPrompts).values({
        listingId,
        agentIndex: ep.agentIndex,
        encryptedPrompt: ep.encryptedPrompt,
        iv: ep.iv,
      });
    }

    return {
      listingId,
      status: "draft",
      message: `Listing "${input.title}" created as draft. Test your pipeline with run_pipeline, then call submit_for_review to start certification.`,
      next: `Track with get_listing_status (listingId: ${listingId})`,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════
// 2. submit_for_review
// ═══════════════════════════════════════════════════════════════════

const SubmitSchema = z.object({
  listingId: z.number().int().positive(),
});

export const submitForReview: McpTool = {
  name: "submit_for_review",
  description:
    "Submit a marketplace listing for certification. Runs the trust flow: deterministic security scan → background test-data generation (uses your configured LLM provider) → platform AI triage (non-gating feedback) → 'certifying' (visible, not buyable) → blind human review decides buyability.",
  inputSchema: SubmitSchema,
  requiredScopes: ["mcp:write"],
  annotations: { readOnlyHint: false, destructiveHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = SubmitSchema.parse(args);
    const db = getDb();

    // Delegate to the REAL tRPC trust flow (marketplace.submitForReview) via
    // a server-side caller — chat and web must run identical certification
    // (chat-first rule). This replaced a legacy inline path that demanded 3
    // user providers, set pending_review, and skipped the security scan,
    // test generation, AI triage, and the blind pool entirely.
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, ctx.userId))
      .limit(1);
    if (!user) throw new Error("User not found");

    const caller = appRouter.createCaller({
      req: new Request("http://internal/mcp"),
      resHeaders: new Headers(),
      user,
      requestId: `mcp-${crypto.randomUUID()}`,
    });

    try {
      const result = await caller.marketplace.submitForReview({ id: input.listingId });
      logger.info("MCP submit_for_review", { listingId: input.listingId, status: result.status });
      return {
        listingId: input.listingId,
        status: result.status,
        promptsCount: result.promptsCount,
        message: result.status === "rejected"
          ? result.message
          : "Submission started: security scan passed, test data is generating in the background. When it completes, the platform AI triage runs (non-gating) and the listing enters 'certifying' — visible, but not buyable until blind human review certifies it.",
        next: `get_listing_status(listingId: ${input.listingId})`,
      };
    } catch (err) {
      const msg = (err as Error).message;
      // Surface the creator-provider prerequisite (test generation needs ONE
      // provider — the old 3-provider AI-review rule is retired).
      if (msg.includes("at least one LLM provider")) {
        return {
          error: "NO_LLM_PROVIDER",
          message: "Test-data generation needs one configured LLM provider. Call suggest_llm_providers for free options, then add_provider — right here in chat.",
        };
      }
      throw err;
    }
  },
};

// ═══════════════════════════════════════════════════════════════════
// 3. get_listing_status
// ═══════════════════════════════════════════════════════════════════

const StatusSchema = z.object({
  listingId: z.number().int().positive(),
});

export const getListingStatus: McpTool = {
  name: "get_listing_status",
  description: "Track a marketplace listing's certification progress: status, review completion percentage, grade, and publish state.",
  inputSchema: StatusSchema,
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = StatusSchema.parse(args);
    const db = getDb();

    const [listing] = await db
      .select()
      .from(marketplaceListings)
      .where(eq(marketplaceListings.id, input.listingId))
      .limit(1);

    if (!listing) throw new Error("Listing not found");

    // Only creator or assigned reviewers can view status
    if (listing.creatorId !== ctx.userId) {
      const [assignment] = await db
        .select()
        .from(reviewAssignments)
        .where(and(
          eq(reviewAssignments.listingId, input.listingId),
          eq(reviewAssignments.reviewerId, ctx.userId),
        ))
        .limit(1);
      if (!assignment) throw new Error("Not authorized to view this listing's status");
    }

    // Review progress
    const totalAssignments = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(reviewAssignments)
      .where(eq(reviewAssignments.listingId, input.listingId));

    const completedReviews = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(listingReviews)
      .where(eq(listingReviews.listingId, input.listingId));

    const uniqueReviewers = await db
      .select({ reviewerId: listingReviews.reviewerId })
      .from(listingReviews)
      .where(and(
        eq(listingReviews.listingId, input.listingId),
        ne(listingReviews.reviewerId, listing.creatorId),
      ))
      .groupBy(listingReviews.reviewerId);

    const totalNeeded = MIN_UNIQUE_REVIEWERS * 3; // 5 reviewers × 3 reviews each
    const done = completedReviews[0]?.count ?? 0;
    const pct = totalNeeded > 0 ? Math.min(100, Math.round((done / totalNeeded) * 100)) : 0;

    return {
      listingId: input.listingId,
      title: listing.title,
      status: listing.status,
      grade: listing.grade,
      aiReview: listing.aiGrade ? {
        grade: listing.aiGrade,
        kappaScore: listing.aiKappaScore,
        feedback: listing.aiFeedback,
        reviewedAt: listing.aiReviewedAt,
      } : null,
      reviewProgress: {
        completed: done,
        needed: totalNeeded,
        percentage: pct,
        uniqueReviewers: uniqueReviewers.length,
      },
      canPublish: listing.status === "approved" || listing.status === "published",
      published: listing.status === "published",
      // A draft with zero reviews used to be reported as "Review in progress:
      // 0% complete", which is a stage that has not begun, not one that stalled
      // (D9 finding 15) — the next turn was enrolling reviewers nobody needed.
      next: listing.status === "published" ? "Nothing further: it is live."
        : listing.status === "rejected" ? "Address the AI feedback above, then submit_for_review again."
        : listing.status === "approved" ? "Publish it when you are ready."
        : done === 0 ? `No review has started (status '${listing.status}').`
        : `${uniqueReviewers.length}/${MIN_UNIQUE_REVIEWERS} reviewers and ${done}/${totalNeeded} reviews exist — more reviewer throughput is what is missing, not a new submission.`,
      message: listing.status === "published"
        ? listing.aiGrade
          ? `AI-verified and published. Grade: ${listing.aiGrade}. Human reviews: ${pct}% complete.`
          : "Published and earning."
        : listing.status === "rejected"
          ? `AI review rejected this listing. Grade: ${listing.aiGrade}. Feedback: ${listing.aiFeedback?.substring(0, 200)}...`
          : listing.status === "approved"
            ? "Certified and ready to publish."
            : done === 0
              ? `Not yet in review: status '${listing.status}', 0 of ${totalNeeded} reviews, ${uniqueReviewers.length} reviewers. Nothing is waiting on anyone.`
              : pct < 100
                ? `Review in progress: ${pct}% complete (${done}/${totalNeeded} reviews).`
                : "Review complete — awaiting final grade calculation.",
    };
  },
};

// ═══════════════════════════════════════════════════════════════════
// 4. my_marketplace_listings
// ═══════════════════════════════════════════════════════════════════

export const myMarketplaceListings: McpTool = {
  name: "my_marketplace_listings",
  description: "List all marketplace listings you created with their current status.",
  inputSchema: z.object({}),
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true },
  handler: async (_args: unknown, ctx: McpAuthContext) => {
    const db = getDb();
    const listings = await db
      .select({
        id: marketplaceListings.id,
        title: marketplaceListings.title,
        status: marketplaceListings.status,
        price: marketplaceListings.price,
        grade: marketplaceListings.grade,
        salesCount: marketplaceListings.salesCount,
        reviewCount: marketplaceListings.reviewCount,
        createdAt: marketplaceListings.createdAt,
      })
      .from(marketplaceListings)
      .where(eq(marketplaceListings.creatorId, ctx.userId))
      .orderBy(desc(marketplaceListings.createdAt));

    return {
      count: listings.length,
      listings: listings.map((l) => ({
        id: l.id,
        title: l.title,
        status: l.status,
        price: l.price,
        grade: l.grade,
        sales: l.salesCount,
        reviews: l.reviewCount,
      })),
    };
  },
};

// ═══════════════════════════════════════════════════════════════════
// 5. my_purchases
// ═══════════════════════════════════════════════════════════════════

export const myPurchases: McpTool = {
  name: "my_purchases",
  description: "List marketplace pipelines you purchased and can run.",
  inputSchema: z.object({}),
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true },
  handler: async (_args: unknown, ctx: McpAuthContext) => {
    const db = getDb();
    const rows = await db
      .select({
        id: marketplacePurchases.id,
        listingId: marketplacePurchases.listingId,
        amountPaid: marketplacePurchases.amountPaid,
        status: marketplacePurchases.status,
        createdAt: marketplacePurchases.createdAt,
        listingTitle: marketplaceListings.title,
      })
      .from(marketplacePurchases)
      .innerJoin(marketplaceListings, eq(marketplaceListings.id, marketplacePurchases.listingId))
      .where(eq(marketplacePurchases.buyerId, ctx.userId))
      .orderBy(desc(marketplacePurchases.createdAt));

    return {
      count: rows.length,
      purchases: rows.map((r) => ({
        purchaseId: r.id,
        listingId: r.listingId,
        title: r.listingTitle,
        price: r.amountPaid,
        status: r.status,
        purchasedAt: r.createdAt,
      })),
    };
  },
};

// ═══════════════════════════════════════════════════════════════════
// 6. deliver_purchased_copy — the Class A handover (v3, 2026-10-13)
// ═══════════════════════════════════════════════════════════════════

export const deliverPurchasedCopyTool: McpTool = {
  name: "deliver_purchased_copy",
  description:
    "Take delivery of a marketplace listing you have bought. The certified workflow version is written into YOUR project as editable steps, plus a template and a first immutable version, attributed to the account that originally created the work. The seller's provider and agent bindings are deliberately not carried over, so the copy runs and bills on your own keys. Refused without a live purchase or grant for the version delivered, and refused if the published version no longer matches the hash recorded against it — a copy that drifted is not the thing the listing's evidence describes. Read `meaning` and `deliveredDefinitionHash` out to the user: the published evidence describes that exact hash, and editing the copy quietly stops it describing yours.",
  inputSchema: deliverPurchasedCopyInputSchema,
  requiredScopes: ["mcp:write"],
  annotations: { readOnlyHint: false },
  handler: async (args, ctx) => {
    const input = deliverPurchasedCopyInputSchema.parse(args);
    return deliverPurchasedCopy(ctx.userId, input);
  },
};
