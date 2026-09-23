// tRPC surface for pipeline sharing between two individual accounts, and for
// the lineage rule that keeps marketplace publishing with the original creator
// (owner decisions, 2026-09-22).
//
// Chat-first rule: these procedures are thin adapters over
// `api/services/pipelineSharing.ts` / `api/services/workflowLineage.ts` — the
// same services the MCP workbench tools call, so the web app, the workbench and
// any client cannot have three different answers about who may see, run, edit
// or sell a pipeline. There is no TEAM procedure here and none will be added:
// teams were deleted from this codebase, and a share is one row naming one
// other account.

import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import {
  cloneSharedPipeline, cloneSharedPipelineInputSchema,
  getSharedRunView, getSharedWorkflow, getSharedWorkflowInputSchema,
  listShares, listSharesInputSchema,
  resolveAccess,
  revokeShare, revokeShareInputSchema,
  runSharedPipelineInputSchema, sharePipeline, sharePipelineInputSchema,
  startSharedRun, updateSharedWorkflow, updateSharedWorkflowInputSchema,
} from "../services/pipelineSharing";
import { resolveProjectLineage, resolveVersionLineage } from "../services/workflowLineage";

export const pipelineShareRouter = createRouter({
  share: authedQuery.input(sharePipelineInputSchema).mutation(({ input, ctx }) => sharePipeline(ctx.user.id, input)),
  revoke: authedQuery.input(revokeShareInputSchema).mutation(({ input, ctx }) => revokeShare(ctx.user.id, input)),
  list: authedQuery.input(listSharesInputSchema).query(({ input, ctx }) => listShares(ctx.user.id, input)),

  // What THIS account may do with one pipeline, in the caller's own terms —
  // read by the workbench before it offers an edit or a run button. An account
  // with no grant and no ownership gets `access: null`, which is the same
  // answer as "no such pipeline", so nothing can be probed for existence.
  access: authedQuery
    .input(z.object({ projectId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const access = await resolveAccess(ctx.user.id, input.projectId);
      if (!access) return { access: null };
      const lineage = await resolveProjectLineage(access.project.id);
      return {
        access: {
          projectId: access.project.id,
          projectName: access.project.name,
          ownerId: access.project.ownerId,
          isOwner: access.isOwner,
          mode: access.mode,
          canReadDefinition: access.canReadDefinition,
          canModify: access.canModify,
          canRun: access.canRun,
          originCreatorId: lineage?.originCreatorId ?? access.project.ownerId,
          // The one sentence a recipient needs: being able to run or even edit
          // a pipeline says nothing about the right to sell it.
          mayPublish: (lineage?.originCreatorId ?? access.project.ownerId) === ctx.user.id,
        },
      };
    }),

  workflow: authedQuery.input(getSharedWorkflowInputSchema).query(({ input, ctx }) => getSharedWorkflow(ctx.user.id, input)),
  setWorkflow: authedQuery.input(updateSharedWorkflowInputSchema).mutation(({ input, ctx }) => updateSharedWorkflow(ctx.user.id, input)),
  run: authedQuery.input(runSharedPipelineInputSchema).mutation(({ input, ctx }) => startSharedRun({ granteeId: ctx.user.id, ...input })),
  runStatus: authedQuery
    .input(z.object({ swarmRunId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const view = await getSharedRunView({ userId: ctx.user.id, swarmRunId: input.swarmRunId });
      if (!view) throw new Error("not_found_or_not_authorized: this run is not a shared-pipeline run visible to your account");
      return view;
    }),
  clone: authedQuery.input(cloneSharedPipelineInputSchema).mutation(({ input, ctx }) => cloneSharedPipeline(ctx.user.id, input)),

  // Lineage, readable: whose work a project or a version actually is. This is
  // deliberately a separate, plainly-labelled read rather than something the
  // UI infers — the difference between "you own this" and "you may sell this"
  // is the whole point of the rule.
  //
  // It answers about an ACCOUNT, so it is not a free read: gated on the same
  // access the `access` procedure gates on, and on owning the version, so no
  // account can walk ids to discover who created a pipeline it was never given.
  lineage: authedQuery
    .input(z.object({
      projectId: z.number().int().positive().optional(),
      workflowVersionId: z.number().int().positive().optional(),
    }).refine((v) => (v.projectId ? 1 : 0) + (v.workflowVersionId ? 1 : 0) === 1, {
      message: "Provide exactly one of projectId or workflowVersionId",
    }))
    .query(async ({ input, ctx }) => {
      if (input.workflowVersionId) {
        const lineage = await resolveVersionLineage(input.workflowVersionId);
        if (!lineage || lineage.ownerId !== ctx.user.id) throw new Error("not_found_or_not_authorized");
        return { kind: "version" as const, lineage };
      }
      const access = await resolveAccess(ctx.user.id, input.projectId as number);
      if (!access) return { access: null, lineage: null };
      const lineage = await resolveProjectLineage(access.project.id);
      if (!lineage) throw new Error("not_found_or_not_authorized");
      return { kind: "project" as const, lineage };
    }),
});
