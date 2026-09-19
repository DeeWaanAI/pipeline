// MCP tool: search_marketplace — search published marketplace pipeline
// listings by keyword and category, ordered by review grade.

import { z } from "zod";
import { eq, and, or, like, desc } from "drizzle-orm";
import type { McpTool, McpAuthContext } from "../types";
import { getDb } from "../../queries/connection";
import { marketplaceListings } from "@db/schema";
import { truncate } from "./_shared";

const inputSchema = z.object({
  query: z.string().max(200).optional(),
  category: z.enum(["translation", "writing", "code", "analysis", "creative", "other"]).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

/** Escape MySQL LIKE wildcards so user input can't broaden the match. */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

export const searchMarketplace: McpTool = {
  name: "search_marketplace",
  description:
    "Search published marketplace pipeline listings by keyword (title/description) and category. Returns compact listings ordered by review grade, best first.",
  inputSchema,
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true },
  handler: async (args: unknown, _ctx: McpAuthContext) => {
    const input = inputSchema.parse(args);
    const limit = input.limit ?? 10;

    const conditions = [eq(marketplaceListings.status, "published")];
    if (input.category) conditions.push(eq(marketplaceListings.category, input.category));
    if (input.query && input.query.trim().length > 0) {
      const pattern = `%${escapeLike(input.query.trim())}%`;
      conditions.push(or(
        like(marketplaceListings.title, pattern),
        like(marketplaceListings.description, pattern),
      )!);
    }

    const db = getDb();
    const rows = await db
      .select({
        id: marketplaceListings.id,
        title: marketplaceListings.title,
        category: marketplaceListings.category,
        price: marketplaceListings.price,
        isSubscription: marketplaceListings.isSubscription,
        grade: marketplaceListings.grade,
        kappaScore: marketplaceListings.kappaScore,
        description: marketplaceListings.description,
      })
      .from(marketplaceListings)
      .where(and(...conditions))
      .orderBy(desc(marketplaceListings.grade))
      .limit(limit);

    return {
      count: rows.length,
      listings: rows.map((r) => ({
        id: r.id,
        title: r.title,
        category: r.category,
        price: r.price,
        isSubscription: r.isSubscription ?? false,
        grade: r.grade,
        kappaScore: r.kappaScore,
        description: truncate(r.description, 300),
      })),
    };
  },
};
