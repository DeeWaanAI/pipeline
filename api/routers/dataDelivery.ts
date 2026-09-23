// tRPC surface for D14 — deliver work data to the client's folder, then sweep
// the server copy.
//
// Two procedures, because that is exactly what the decision leaves for the
// server: the user's chat client writes the folder, so there is no upload, no
// job and no streaming endpoint here. All the logic — scope resolution,
// per-row ownership, the protected/shared-run refusals, the signed receipt, the
// never-swept census — lives in `api/services/dataDelivery.ts`, which the web
// app, a future MCP tool and any other client will therefore never disagree
// with. This file only binds an authenticated user id to those calls.
//
// House rules honoured here (see api/routers/pipelineShare.ts and
// api/routers/benchmark.ts for the pattern):
//  * `authedQuery` and nothing more — no tier, no plan, no entitlement check:
//    D14's promise is to every account, and the ladder was deleted. There is no
//    group, team or org concept anywhere in this surface.
//  * A refusal says "not visible to this account", never "forbidden": an id
//    belonging to someone else must not be distinguishable from one that does
//    not exist.
//  * `deliver` is a QUERY (it writes nothing, so a client may retry it freely);
//    `sweep` is a MUTATION, because it is the one call that removes data and it
//    demands both a receipt and the confirmation phrase.

import { createRouter, authedQuery } from "../middleware";
import {
  deliverWorkData, deliverWorkDataInputSchema, previewDeliveryScope,
  sweepDeliveredData, sweepDeliveredDataInputSchema,
} from "../services/dataDelivery";

export const dataDeliveryRouter = createRouter({
  /** Hand over ONE complete bundle of this account's own work data, with its
   *  sha256 and the receipt a later sweep must present. */
  deliver: authedQuery
    .input(deliverWorkDataInputSchema)
    .query(({ input, ctx }) => deliverWorkData(ctx.user.id, input)),

  /** What a scope WOULD contain, without handing anything over: counts, the
   *  hash, and the runs it refuses to carry. A client can use it to size the
   *  folder before the user commits to the write. */
  preview: authedQuery
    .input(deliverWorkDataInputSchema)
    .query(({ input, ctx }) => previewDeliveryScope(ctx.user.id, input)),

  /** Clear the server copy of exactly what `deliver` delivered. Requires that
   *  receipt plus the confirmation phrase, and refuses if the server copy moved
   *  since delivery — so what is deleted is always what the user now holds. */
  sweep: authedQuery
    .input(sweepDeliveredDataInputSchema)
    .mutation(({ input, ctx }) => sweepDeliveredData(ctx.user.id, input)),
});
