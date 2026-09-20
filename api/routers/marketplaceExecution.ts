// tRPC router: protected marketplace execution (offering redesign v2, spec
// §8.1–§8.3, §10.1 `marketplaceExecution.start/get`). Thin procedures over
// marketplaceExecutionService — entitlement resolution, the trusted-endpoint
// policy, the authorized snapshot loader and the buyer-visible projection all
// live in the service, so no surface can reach a weaker path.
//
// Cancellation is already covered by `swarm.cancelRun`, which is owner-scoped
// on the run row: a protected run belongs to the BUYER, so the existing
// procedure is the right one and is not duplicated here.

import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import {
  getProtectedRunView, resolveProtectedExecutionRight, startProtectedRun,
} from "../services/marketplaceExecutionService";
import { listPublicEvidenceForListing } from "../services/evidenceService";

const startInput = z.object({
  listingId: z.number().int().positive(),
  input: z.string().min(1).max(200000),
  providerId: z.number().int().positive().describe("A provider YOU own and have enabled — you pay for your own calls (§8.2)"),
  purpose: z.enum(["buyer_execution", "trial"]).default("buyer_execution"),
  idempotencyKey: z.string().min(1).max(120).optional(),
});

export const marketplaceExecutionRouter = createRouter({
  start: authedQuery.input(startInput).mutation(async ({ input, ctx }) =>
    startProtectedRun({
      buyerId: ctx.user.id, listingId: input.listingId, input: input.input,
      providerId: input.providerId, purpose: input.purpose, idempotencyKey: input.idempotencyKey,
    }),
  ),

  /** Buyer view: final output plus per-step metadata. Never the workflow
   *  definition, the seller's prompts, or intermediate step content (§8.1). */
  get: authedQuery.input(z.object({ swarmRunId: z.number().int().positive() })).query(async ({ input, ctx }) =>
    getProtectedRunView({ buyerId: ctx.user.id, swarmRunId: input.swarmRunId }),
  ),

  /** What the buyer is entitled to run, and under which protection class —
   *  without exposing anything about the seller's workflow internals. */
  right: authedQuery.input(z.object({ listingId: z.number().int().positive() })).query(async ({ input, ctx }) => {
    const right = await resolveProtectedExecutionRight({ buyerId: ctx.user.id, listingId: input.listingId, purpose: "buyer_execution" });
    const evidence = await listPublicEvidenceForListing(right.listing.id, { kind: "seller" });
    return {
      listingId: right.listing.id,
      title: right.listing.title,
      entitled: true,
      viaGrant: !!right.grant,
      grantExpiresAt: right.grant?.expiresAt ?? null,
      soldWorkflowVersionId: right.soldVersionId,
      currentEvidenceHash: evidence[0]?.manifestHash ?? null,
      testedAt: evidence[0]?.testedAt ?? null,
    };
  }),
});
