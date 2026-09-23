// tRPC router: model freshness — admin-reviewed catalog + release events, and
// the seller's own retest suggestions (offering redesign v2, spec §12.1).
//
// §12.1 makes the write side admin-only ("Admin/internal service only; no
// public caller can trigger mass notifications or runs"), so `recordModel` and
// `recordReleaseEvent` are adminQuery and the service re-asserts the role
// itself. The seller side can only ever read, dismiss, snooze or record intent.

import { z } from "zod";
import { createRouter, adminQuery, authedQuery } from "../middleware";
import {
  listRetestSuggestions, markModelDeprecated, modelFreshnessForListing,
  recordCatalogModel, recordReleaseEvent, respondToSuggestion,
} from "../services/modelCatalogService";

export const modelCatalogRouter = createRouter({
  recordModel: adminQuery.input(z.object({
    provider: z.string().min(1).max(80),
    modelId: z.string().min(1).max(120),
    family: z.string().max(80).optional(),
    // D12: the model's DEVELOPER, never the hosting account. Reviewer-filled,
    // because the evidence panel refuses to name a vendor it cannot attribute.
    vendor: z.string().min(1).max(80).optional().nullable()
      .describe("Who developed the model (deepseek, meta, zhipu), not who served it"),
    successorOfModelId: z.string().max(120).optional().describe("Must already be in the catalog — a successor is reviewed lineage, never a name match"),
    sourceUrl: z.string().max(512).optional(),
    availableAt: z.coerce.date().optional(),
    deprecatedAt: z.coerce.date().optional(),
  })).mutation(async ({ input, ctx }) => recordCatalogModel(ctx.user.id, input)),

  recordReleaseEvent: adminQuery.input(z.object({
    modelCatalogId: z.number().int().positive(),
    eventKey: z.string().min(1).max(160).describe("The source's own identity — replaying it must not notify anyone twice"),
    relevanceRule: z.enum(["same_model", "same_family", "successor_of"]).default("same_model"),
  })).mutation(async ({ input, ctx }) => recordReleaseEvent(ctx.user.id, input)),

  markDeprecated: adminQuery.input(z.object({
    catalogId: z.number().int().positive(),
    deprecatedAt: z.coerce.date(),
  })).mutation(async ({ input, ctx }) => markModelDeprecated(ctx.user.id, input.catalogId, input.deprecatedAt)),

  // ── Seller side ───────────────────────────────────────────────────
  suggestions: authedQuery.input(z.object({ includeDismissed: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => listRetestSuggestions(ctx.user.id, input ?? {})),

  respond: authedQuery.input(z.object({
    suggestionId: z.number().int().positive(),
    action: z.enum(["dismiss", "snooze", "plan_retest"]),
    until: z.coerce.date().optional(),
  })).mutation(async ({ input, ctx }) => respondToSuggestion(ctx.user.id, input.suggestionId, input.action, { until: input.until })),

  // ── Public freshness read for a listing (what a buyer sees) ───────
  listingFreshness: authedQuery.input(z.object({ listingId: z.number().int().positive() }))
    .query(async ({ input }) => modelFreshnessForListing(input.listingId)),
});
