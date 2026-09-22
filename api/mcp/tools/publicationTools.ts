// MCP tools: evidence publication (offering redesign v2, spec §7.3, §10.1,
// §10.2). Owner decision D9: a desktop client must be able to run the whole
// seller journey, so these are adapters over evidenceService — the consent
// gate, hash binding, eligibility refusals, the transactional listing update
// and the legacy-isolation guard all live in the service.
//
// The rule a caller cannot get around: nothing is public until the EXACT
// preview bytes have been shown and consented to by hash, and a seller
// publication always names the workflow version it sells.

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { McpTool, McpAuthContext } from "../types";
import { getDb } from "../../queries/connection";
import { marketplaceListings, marketplaceListingV2 } from "@db/schema";
import {
  DEFAULT_CONSENT_VERSION, buildEvidencePreview, getPublicEvidenceForListing,
  listPublicEvidenceForListing, publishCommunityEvidence, publishVersion,
  supersedePublication, withdrawPublication, getEvidenceForViewer, getPurchasedEvidenceForListing,
} from "../../services/evidenceService";

const listingInputSchema = z.object({ listingId: z.number().int().positive() });

const previewInputSchema = z.object({
  benchmarkId: z.number().int().positive().describe("A COMPLETED benchmark you own — completion alone never publishes anything"),
  listingId: z.number().int().positive().optional().describe("Seller evidence: the listing this would be published against"),
  publicationKind: z.enum(["seller", "community"]).default("community").describe("seller = your own listing's required evidence (stricter gate); community = independently measured report"),
  consentVersion: z.string().min(1).max(40).default(DEFAULT_CONSENT_VERSION),
  withholdInputs: z.boolean().optional().describe("Withhold case text and reference material. Allowed for a clearly labelled limited report; it can then NEVER be seller evidence (§7.3)"),
  withheldReason: z.string().min(3).max(500).optional(),
});

/** What the caller must do with a preview: read it, then echo the hash. */
function consentInstructions(previewHash: string, workflowVersionId: number | string) {
  return [
    `Nothing is public yet. Show the user this exact manifest and get an explicit yes.`,
    `Publishing means calling publish_evidence_version with previewHash="${previewHash}" — a different hash is refused, so consent is always about the exact bytes that become public.`,
    `Pass workflowVersionId="${workflowVersionId}": that is the version this evidence actually measured. Naming another one is refused (a new revision cannot inherit old scores).`,
  ].join(" ");
}

export const previewEvidenceTool: McpTool = {
  name: "preview_evidence",
  description:
    "Build the public disclosure manifest for one of your completed benchmarks and hash it, WITHOUT publishing. This is the full §7.3 disclosure: tested version identity, every case (or a labelled withholding), the exact judging template, weights, every judgment including failures, all attempts, observed cost with unknowns as unknown, and the deterministic validators recorded as disabled. Also returns eligibilityIssues — what would stop a seller publication — and secretFindings.",
  inputSchema: previewInputSchema,
  requiredScopes: ["mcp:read"],
  featureFlag: "v2Publication",
  annotations: { readOnlyHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = previewInputSchema.parse(args);
    const preview = await buildEvidencePreview({
      userId: ctx.userId, benchmarkId: input.benchmarkId, publicationKind: input.publicationKind,
      listingId: input.listingId ?? null, consentVersion: input.consentVersion,
      withholdInputs: input.withholdInputs, withheldReason: input.withheldReason,
    });
    return {
      ...preview,
      next: consentInstructions(preview.previewHash, preview.manifest.versionIdentity.workflowVersionId),
    };
  },
};

const publishVersionInputSchema = previewInputSchema.partial({ publicationKind: true }).extend({
  listingId: z.number().int().positive(),
  workflowVersionId: z.number().int().positive().describe("The exact version being sold — must be the version the benchmark tested"),
  previewHash: z.string().length(64).describe("The hash the user approved"),
  expectedListingRevision: z.number().int().nonnegative().optional().describe("Pass listing_publication_state's evidenceSummaryRevision to avoid clobbering a concurrent change"),
});

export const publishEvidenceVersionTool: McpTool = {
  name: "publish_evidence_version",
  description:
    "The SOLE seller publication boundary: links immutable public evidence to the exact workflow version being sold, in one transaction, and makes the listing published (v2 listings never enter the legacy `certifying` state). Refused unless the preview hash matches byte-for-byte, the evidence is eligible (completed plan, platform-recorded execution, full disclosure), no credential appears in it, and the version you name is the version that was tested. A stale expectedListingRevision fails instead of overwriting.",
  inputSchema: publishVersionInputSchema,
  requiredScopes: ["mcp:write"],
  featureFlag: "v2Publication",
  annotations: { readOnlyHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = publishVersionInputSchema.parse(args);
    const result = await publishVersion({
      userId: ctx.userId, listingId: input.listingId, workflowVersionId: input.workflowVersionId,
      benchmarkId: input.benchmarkId, previewHash: input.previewHash, consentVersion: input.consentVersion,
      expectedListingRevision: input.expectedListingRevision,
    });
    return {
      ...result,
      meaning: result.reused
        ? "Already published with exactly this content — no new row, nothing changed."
        : `Publication ${result.publicationId} is now the listing's current evidence (revision ${result.evidenceSummaryRevision}); it was previously '${result.previousListingStatus}'. testedAt is the benchmark's own finish time and never moves.`,
    };
  },
};

const communityInputSchema = publishVersionInputSchema.omit({ workflowVersionId: true, expectedListingRevision: true, listingId: true }).extend({
  listingId: z.number().int().positive().optional(),
  previewHash: z.string().length(64),
});

export const publishCommunityEvidenceTool: McpTool = {
  name: "publish_community_evidence",
  description:
    "Publish your own measured evidence as a community report. It may reference a listing but NEVER becomes that listing's required seller evidence — community and seller proof stay distinguishable, and user-reported data is never presented as platform-recorded. Same consent-by-hash rule as seller publication.",
  inputSchema: communityInputSchema,
  requiredScopes: ["mcp:write"],
  featureFlag: "v2Publication",
  annotations: { readOnlyHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = communityInputSchema.parse(args);
    const result = await publishCommunityEvidence({
      userId: ctx.userId, benchmarkId: input.benchmarkId, listingId: input.listingId ?? null,
      previewHash: input.previewHash, consentVersion: input.consentVersion,
      withholdInputs: input.withholdInputs, withheldReason: input.withheldReason,
    });
    return {
      ...result,
      isPublic: true,
      listingReferenced: input.listingId ?? null,
      meaning: result.reused
        ? `Community report ${result.publicationId} was already published with exactly this content — no new row was created.`
        : `Community report ${result.publicationId} is now public${input.listingId ? ` and references listing ${input.listingId}` : ""}. Read it back with get_public_evidence using publicationId ${result.publicationId} or this manifestHash; withdraw it with withdraw_evidence. It is labelled community — it is NOT that listing's required seller evidence and does not change the listing's status.`
          + " A `null` in this reply means 'not applicable', which is different from 0.",
    };
  },
};

const withdrawInputSchema = z.object({
  publicationId: z.number().int().positive(),
  reason: z.string().min(3).max(2000).describe("Recorded verbatim in the audit trail"),
});

export const withdrawEvidenceTool: McpTool = {
  name: "withdraw_evidence",
  description:
    "Withdraw a publication you authored. Historical run data, attempts and financial records are untouched, and the row stays as `withdrawn` so a superseded manifest is still addressable. If the withdrawn manifest was a listing's current evidence, the SAME transaction unpublishes the listing — a v2 listing is never left buyable with no evidence.",
  inputSchema: withdrawInputSchema,
  requiredScopes: ["mcp:write"],
  featureFlag: "v2Publication",
  annotations: { readOnlyHint: false, destructiveHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = withdrawInputSchema.parse(args);
    return withdrawPublication({ userId: ctx.userId, publicationId: input.publicationId, reason: input.reason });
  },
};

const supersedeInputSchema = publishVersionInputSchema.extend({
  supersededPublicationId: z.number().int().positive(),
});

export const supersedeEvidenceTool: McpTool = {
  name: "supersede_evidence",
  description:
    "Replace a seller publication with a new measurement. Creates a NEW immutable row that links to the one it replaces (its own id and hash) and withdraws the old one; `testedAt` is copied from the new benchmark's own finish time, never re-dated to look fresher.",
  inputSchema: supersedeInputSchema,
  requiredScopes: ["mcp:write"],
  featureFlag: "v2Publication",
  annotations: { readOnlyHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = supersedeInputSchema.parse(args);
    const published = await supersedePublication({
      userId: ctx.userId, supersededPublicationId: input.supersededPublicationId,
      benchmarkId: input.benchmarkId, listingId: input.listingId,
      workflowVersionId: input.workflowVersionId, previewHash: input.previewHash,
      consentVersion: input.consentVersion, expectedListingRevision: input.expectedListingRevision,
    });
    return { ...published, meaning: `Publication ${input.supersededPublicationId} is withdrawn; ${published.publicationId} is now current and records what it replaced.` };
  },
};

export const listingPublicationStateTool: McpTool = {
  name: "listing_publication_state",
  description:
    "Where one of your listings stands under the v2 rules: a `stage` that separates 'nothing published yet' from 'recorded as legacy and not managed here' from 'v2 evidence is current', which workflow version is sold, which publication is current, and the evidenceSummaryRevision to pass as expectedListingRevision. `null` means there is no v2 record for it at all, which is not the same as revision 0. Owner-scoped: another user's listing is reported as not found.",
  inputSchema: listingInputSchema,
  requiredScopes: ["mcp:read"],
  featureFlag: "v2Publication",
  annotations: { readOnlyHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const { listingId } = listingInputSchema.parse(args);
    const db = getDb();
    const [listing] = await db.select({
      id: marketplaceListings.id, status: marketplaceListings.status, title: marketplaceListings.title,
    }).from(marketplaceListings)
      .where(and(eq(marketplaceListings.id, listingId), eq(marketplaceListings.creatorId, ctx.userId)))
      .limit(1);
    if (!listing) throw new Error("not_found_or_not_authorized");
    const [v2] = await db.select().from(marketplaceListingV2)
      .where(eq(marketplaceListingV2.listingId, listing.id)).limit(1);
    const stage = !v2
      ? "no_v2_record" as const
      : v2.currentEvidencePublicationId
        ? "v2_evidence_current" as const
        : v2.publicationMode === "v2"
          ? "awaiting_first_publication" as const
          : "legacy_recorded" as const;
    return {
      listingId: listing.id,
      title: listing.title,
      listingStatus: listing.status,
      publicationMode: v2?.publicationMode ?? "legacy",
      stage,
      currentWorkflowVersionId: v2?.currentWorkflowVersionId ?? null,
      currentEvidencePublicationId: v2?.currentEvidencePublicationId ?? null,
      evidenceSummaryRevision: v2?.evidenceSummaryRevision ?? null,
      meaning: {
        no_v2_record: "This listing predates the v2 publication rules (legacy). It is bought and reviewed the old way; nothing here manages its evidence, and `evidenceSummaryRevision: null` means there is no v2 row at all — not revision 0.",
        legacy_recorded: "The listing is v2-capable but still in the legacy mode: nothing has been published through the v2 boundary yet. preview_evidence then publish_evidence_version is what moves it forward — being here is not an error to fix.",
        awaiting_first_publication: "v2 mode is set and no evidence is linked yet. Publish the seller evidence with publish_evidence_version; a v2 listing is never left buyable without it.",
        v2_evidence_current: `Publication ${v2?.currentEvidencePublicationId ?? "?"} is this listing's current evidence, measured on workflow version ${v2?.currentWorkflowVersionId ?? "?"}.`,
      }[stage],
    };
  },
};

const publicEvidenceInputSchema = z.object({
  listingId: z.number().int().positive().optional(),
  publicationId: z.number().int().positive().optional().describe("Read a specific publication, including a standalone community report"),
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  includeCommunity: z.boolean().optional().describe("Also list community reports when addressing a listing"),
}).refine((v) => [v.listingId, v.publicationId, v.manifestHash].filter((x) => x !== undefined).length === 1, {
  message: "Provide exactly one of listingId, publicationId or manifestHash",
});

export const getPublicEvidenceTool: McpTool = {
  name: "get_public_evidence",
  description:
    "Read evidence by listingId, publicationId or manifestHash, including standalone community reports. Listing reads include separately labeled purchased evidence. Withdrawn reports remain available only to their author or an entitled buyer of that version. Returns validated disclosure manifests, never private workflow prompts or credentials. Not feature-gated: existing evidence stays readable.",
  inputSchema: publicEvidenceInputSchema,
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = publicEvidenceInputSchema.parse(args);
    if (!input.listingId) {
      const publication = await getEvidenceForViewer({ userId: ctx.userId, publicationId: input.publicationId, manifestHash: input.manifestHash });
      if (!publication) throw new Error("not_found_or_not_authorized");
      return publication;
    }
    const manifest = await getPublicEvidenceForListing(input.listingId);
    const purchasedEvidence = await getPurchasedEvidenceForListing({ userId: ctx.userId, listingId: input.listingId });
    return {
      manifest,
      purchasedEvidence,
      community: input.includeCommunity ? await listPublicEvidenceForListing(input.listingId, { kind: "community" }) : undefined,
      readingHint: manifest || purchasedEvidence
        ? "Public listing evidence and purchased-version evidence are labeled separately. Scores apply only to that version and test conditions, not a quality certification. Delisting does not erase an existing buyer's evidence."
        : "No public or purchased-version evidence is available to this account for this listing. That is not a negative quality finding.",
    };
  },
};

export const PUBLICATION_TOOLS: McpTool[] = [
  previewEvidenceTool,
  publishEvidenceVersionTool,
  publishCommunityEvidenceTool,
  supersedeEvidenceTool,
  withdrawEvidenceTool,
  listingPublicationStateTool,
  getPublicEvidenceTool,
];
