// ═══════════════════════════════════════════════════════════════════
//  CERTIFICATION BADGE — embeddable SVG (Phase 1)
// ═══════════════════════════════════════════════════════════════════
//   GET /api/certification/:id/badge.svg
// CDN-cacheable (Cache-Control + ETag), revalidated implicitly when the
// grade changes (ETag carries the grade). Certified listings only —
// anything else 404s like the report endpoint.

import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { eq, and, inArray } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { marketplaceListings } from "@db/schema";

function gradeColor(grade: number): string {
  if (grade >= 4.5) return "#16a34a"; // green-600
  if (grade >= 4.0) return "#65a30d"; // lime-600
  if (grade >= 3.5) return "#ca8a04"; // yellow-600
  return "#dc2626"; // red-600
}

function badgeSvg(listingId: number, grade: number): string {
  const label = "AI Swarm Certified";
  const value = `${grade.toFixed(2)} / 5`;
  const color = gradeColor(grade);
  // width: rough monospace estimate, keeps the SVG self-contained
  const labelW = 128;
  const valueW = 62;
  const totalW = labelW + valueW;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20" role="img" aria-label="${label}: ${value}">
  <title>${label}: ${value}</title>
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${totalW}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelW}" height="20" fill="#171717"/>
    <rect x="${labelW}" width="${valueW}" height="20" fill="${color}"/>
    <rect width="${totalW}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelW / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${labelW / 2}" y="14">${label}</text>
    <text x="${labelW + valueW / 2}" y="15" fill="#010101" fill-opacity=".3">${value}</text>
    <text x="${labelW + valueW / 2}" y="14">${value}</text>
  </g>
</svg>`;
}

export function registerCertificationBadgeRoute(app: Hono<{ Bindings: HttpBindings }>) {
  app.get("/api/certification/:id/badge.svg", async (c) => {
    const listingId = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(listingId)) return c.body("Not Found", 404);

    const [listing] = await getDb()
      .select({ grade: marketplaceListings.grade, updatedAt: marketplaceListings.updatedAt })
      .from(marketplaceListings)
      .where(and(
        eq(marketplaceListings.id, listingId),
        inArray(marketplaceListings.status, ["approved", "published"]),
      ))
      .limit(1);

    if (!listing || listing.grade === null) return c.body("Not Found", 404);

    const grade = Number(listing.grade);
    c.header("Content-Type", "image/svg+xml");
    c.header("Cache-Control", "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800");
    c.header("ETag", `W/"badge-${listingId}-${grade.toFixed(2)}"`);
    return c.body(badgeSvg(listingId, grade));
  });
}
