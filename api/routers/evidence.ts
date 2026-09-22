// tRPC routers: evidence preview + community publication (offering redesign v2,
// spec §10.1). Thin procedures over evidenceService — the consent gate, hash
// binding, eligibility rules and the transactional listing update all live in
// the shared service, so a client cannot reach a weaker path.
//
// `marketplace.publishVersion` (the seller boundary) lives in the marketplace
// router because that is where buyers and sellers look for it; everything here
// is the author-side view of the same state machine.

import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import {
  DEFAULT_CONSENT_VERSION, PUBLICATION_POLICY_VERSION, buildEvidencePreview,
  publishCommunityEvidence, supersedePublication, withdrawPublication,
} from "../services/evidenceService";
import {
  previewExternalInputSchema, reportExternalInputSchema, getExternalInputSchema, listExternalInputSchema,
  previewExternal, reportExternal, getExternal, listExternal, withdrawExternalInputSchema, withdrawExternal,
} from "../services/externalEvidenceService";

const previewInput = z.object({
  benchmarkId: z.number().int().positive(),
  listingId: z.number().int().positive().optional(),
  publicationKind: z.enum(["seller", "community"]).default("community"),
  consentVersion: z.string().min(1).max(40).default(DEFAULT_CONSENT_VERSION),
  withholdInputs: z.boolean().optional(),
  withheldReason: z.string().min(3).max(500).optional(),
});

export const evidenceRouter = createRouter({
  // Nothing is published here: this is the exact document that WOULD become
  // public, plus the hash the caller must echo back to consent to it (§10.1).
  preview: authedQuery.input(previewInput).query(async ({ input, ctx }) =>
    buildEvidencePreview({
      userId: ctx.user.id, benchmarkId: input.benchmarkId, publicationKind: input.publicationKind,
      listingId: input.listingId ?? null, consentVersion: input.consentVersion,
      withholdInputs: input.withholdInputs, withheldReason: input.withheldReason,
    }),
  ),
});

export const communityEvidenceRouter = createRouter({
  previewExternal: authedQuery.input(previewExternalInputSchema).query(({ input, ctx }) =>
    previewExternal(ctx.user.id, input),
  ),
  reportExternal: authedQuery.input(reportExternalInputSchema).mutation(({ input, ctx }) =>
    reportExternal(ctx.user.id, input),
  ),
  getExternal: authedQuery.input(getExternalInputSchema).query(({ input }) => getExternal(input)),
  listExternal: authedQuery.input(listExternalInputSchema).query(({ input }) => listExternal(input)),
  withdrawExternal: authedQuery.input(withdrawExternalInputSchema).mutation(({ input, ctx }) =>
    withdrawExternal(ctx.user.id, input),
  ),

  publish: authedQuery.input(previewInput.extend({
    previewHash: z.string().length(64),
  })).mutation(async ({ input, ctx }) =>
    publishCommunityEvidence({
      userId: ctx.user.id, benchmarkId: input.benchmarkId, listingId: input.listingId ?? null,
      previewHash: input.previewHash, consentVersion: input.consentVersion,
      withholdInputs: input.withholdInputs, withheldReason: input.withheldReason,
    }),
  ),

  withdraw: authedQuery.input(z.object({
    publicationId: z.number().int().positive(),
    reason: z.string().min(3).max(2000),
  })).mutation(async ({ input, ctx }) =>
    withdrawPublication({ userId: ctx.user.id, publicationId: input.publicationId, reason: input.reason }),
  ),

  // A replacement is a NEW immutable row; the seller path goes through
  // `marketplace.publishVersion`, which also moves the listing pointer.
  supersede: authedQuery.input(z.object({
    supersededPublicationId: z.number().int().positive(),
    benchmarkId: z.number().int().positive(),
    listingId: z.number().int().positive(),
    workflowVersionId: z.number().int().positive(),
    previewHash: z.string().length(64),
    consentVersion: z.string().min(1).max(40).default(DEFAULT_CONSENT_VERSION),
    expectedListingRevision: z.number().int().nonnegative().optional(),
  })).mutation(async ({ input, ctx }) =>
    supersedePublication({
      userId: ctx.user.id, supersededPublicationId: input.supersededPublicationId,
      benchmarkId: input.benchmarkId, listingId: input.listingId,
      workflowVersionId: input.workflowVersionId, previewHash: input.previewHash,
      consentVersion: input.consentVersion, expectedListingRevision: input.expectedListingRevision,
    }),
  ),

  policy: authedQuery.input(z.object({})).query(async () => ({
    publicationPolicyVersion: PUBLICATION_POLICY_VERSION,
    defaultConsentVersion: DEFAULT_CONSENT_VERSION,
  })),
});
