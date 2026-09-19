// MCP tool: list_pipelines — union of the caller's runnable pipelines:
// (a) owned projects + their pipeline step counts,
// (b) saved pipeline templates,
// (c) marketplace listings purchased via purchase entitlements.

import { z } from "zod";
import { eq, and, inArray, desc, sql } from "drizzle-orm";
import type { McpTool, McpAuthContext } from "../types";
import { getDb } from "../../queries/connection";
import { projects, pipelineSteps, pipelineTemplates, marketplaceListings, entitlements } from "@db/schema";
import { truncate } from "./_shared";

const inputSchema = z.object({});

const MAX_PER_KIND = 50;

interface PipelineItem {
  kind: "project" | "template" | "marketplace";
  id: number;
  name: string;
  description: string;
  stepCount?: number;
}

export const listPipelines: McpTool = {
  name: "list_pipelines",
  description:
    "List pipelines available to the caller: their projects (with pipeline step counts), saved pipeline templates, and purchased marketplace pipelines. Compact output suitable for choosing a target for run_pipeline.",
  inputSchema,
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true },
  handler: async (_args: unknown, ctx: McpAuthContext) => {
    const db = getDb();
    const items: PipelineItem[] = [];

    // (a) Owned projects + step counts
    const projectRows = await db
      .select({ id: projects.id, name: projects.name, description: projects.description })
      .from(projects)
      .where(and(eq(projects.userId, ctx.userId), eq(projects.isArchived, false)))
      .orderBy(desc(projects.updatedAt))
      .limit(MAX_PER_KIND);

    const stepCounts = new Map<number, number>();
    if (projectRows.length > 0) {
      const ids = projectRows.map((p) => p.id);
      const counts = await db
        .select({ projectId: pipelineSteps.projectId, n: sql<number>`count(*)` })
        .from(pipelineSteps)
        .where(inArray(pipelineSteps.projectId, ids))
        .groupBy(pipelineSteps.projectId);
      for (const c of counts) stepCounts.set(c.projectId, Number(c.n));
    }
    for (const p of projectRows) {
      items.push({
        kind: "project", id: p.id, name: p.name,
        description: truncate(p.description, 200),
        stepCount: stepCounts.get(p.id) ?? 0,
      });
    }

    // (b) Saved pipeline templates
    const templateRows = await db
      .select({ id: pipelineTemplates.id, name: pipelineTemplates.name, description: pipelineTemplates.description, steps: pipelineTemplates.steps })
      .from(pipelineTemplates)
      .where(eq(pipelineTemplates.userId, ctx.userId))
      .orderBy(desc(pipelineTemplates.createdAt))
      .limit(MAX_PER_KIND);
    for (const t of templateRows) {
      items.push({
        kind: "template", id: t.id, name: t.name,
        description: truncate(t.description, 200),
        stepCount: Array.isArray(t.steps) ? t.steps.length : 0,
      });
    }

    // (c) Purchased marketplace listings — purchase entitlements carry the
    // listing id in the capability string: `pipeline:run:<listingId>`
    // (granted by services/entitlementSync on Stripe fulfillment).
    const purchaseRows = await db
      .select({ capability: entitlements.capability })
      .from(entitlements)
      .where(and(
        eq(entitlements.subjectType, "user"),
        eq(entitlements.subjectId, ctx.userId),
        eq(entitlements.source, "purchase"),
      ));
    const listingIds = purchaseRows
      .map((r) => Number(r.capability.replace(/^pipeline:run:/, "")))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (listingIds.length > 0) {
      const listings = await db
        .select({ id: marketplaceListings.id, title: marketplaceListings.title, description: marketplaceListings.description })
        .from(marketplaceListings)
        .where(inArray(marketplaceListings.id, [...new Set(listingIds)].slice(0, MAX_PER_KIND)));
      for (const l of listings) {
        items.push({
          kind: "marketplace", id: l.id, name: l.title,
          description: truncate(l.description, 200),
        });
      }
    }

    return { count: items.length, pipelines: items };
  },
};
