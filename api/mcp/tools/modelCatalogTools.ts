// MCP tools: model release awareness for sellers (offering redesign v2,
// spec §12.1; acceptance A19). Reading and dismissing suggestions only. The
// write side — the catalog and release events — is admin/internal by spec, so
// there is deliberately no MCP tool that records a model or fans out notices:
// "no public caller can trigger mass notifications or runs".

import { z } from "zod";
import type { McpTool, McpAuthContext } from "../types";
import {
  listRetestSuggestions, modelFreshnessForListing, respondToSuggestion,
} from "../../services/modelCatalogService";

const listInputSchema = z.object({ includeDismissed: z.boolean().optional() });

export const retestSuggestionsTool: McpTool = {
  name: "model_retest_suggestions",
  description:
    "Your model-freshness suggestions: an admin-reviewed new or successor model that overlaps a workflow version you published evidence for. Each one is information only — nothing has been re-run, nothing has been spent, your published scores and their test dates are untouched, and no retest is scheduled by age. Dismissal is respected; snooze defers until the date you choose.",
  inputSchema: listInputSchema,
  requiredScopes: ["mcp:read"],
  featureFlag: "v2Publication",
  annotations: { readOnlyHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = listInputSchema.parse(args);
    return listRetestSuggestions(ctx.userId, input);
  },
};

const respondInputSchema = z.object({
  suggestionId: z.number().int().positive(),
  action: z.enum(["dismiss", "snooze", "plan_retest"]),
  until: z.coerce.date().optional().describe("Only for snooze"),
});

export const respondRetestSuggestionTool: McpTool = {
  name: "respond_retest_suggestion",
  description:
    "Dismiss a suggestion, snooze it until a date, or mark that you intend to retest. 'plan_retest' records intent and starts NOTHING — you still create the benchmark, quote it and approve the spend yourself, because a suggestion must never become a billable run on its own (§12.1).",
  inputSchema: respondInputSchema,
  requiredScopes: ["mcp:write"],
  featureFlag: "v2Publication",
  annotations: { readOnlyHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = respondInputSchema.parse(args);
    return respondToSuggestion(ctx.userId, input.suggestionId, input.action, { until: input.until });
  },
};

const freshnessInputSchema = z.object({ listingId: z.number().int().positive() });

export const listingModelFreshnessTool: McpTool = {
  name: "listing_model_freshness",
  description:
    "For a listing's current published evidence: which provider/model/version it was tested on and when, whether each is catalogued, whether the provider deprecated it, and the reviewed successor if one exists (explicit lineage, never a name match). Buyer-facing context, not a verdict.",
  inputSchema: freshnessInputSchema,
  requiredScopes: ["mcp:read"],
  featureFlag: "v2Publication",
  annotations: { readOnlyHint: true },
  handler: async (args: unknown) => {
    const { listingId } = freshnessInputSchema.parse(args);
    return modelFreshnessForListing(listingId);
  },
};

export const MODEL_CATALOG_TOOLS: McpTool[] = [
  retestSuggestionsTool,
  respondRetestSuggestionTool,
  listingModelFreshnessTool,
];
