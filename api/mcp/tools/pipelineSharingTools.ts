// MCP tools: pipeline sharing between two individual accounts (owner decisions,
// 2026-09-22). D9 makes the workbench the primary interface, so a user must be
// able to lend one pipeline to one named account, take it back, and — if they
// were given a pipeline — read what they are entitled to and run it, all from
// chat. Every one of these is an adapter over `api/services/pipelineSharing.ts`
// and `api/services/workflowLineage.ts`: the grant row, the redaction and the
// publish gate cannot be negotiated past from this layer.
//
// Two rules a caller cannot get round from here:
//  * a `run_only` grant returns step IDENTITY only, and the recipient's runs of
//    it are redacted at the write (no prompt text exists to leak);
//  * no share, at any privilege, grants the right to publish. That is lineage.

import type { McpTool } from "../types";
import {
  cloneSharedPipelineInputSchema, cloneSharedPipeline,
  getSharedRunView, getSharedWorkflow, getSharedWorkflowInputSchema,
  listShares, listSharesInputSchema,
  revokeShare, revokeShareInputSchema,
  runSharedPipelineInputSchema, sharePipeline, sharePipelineInputSchema,
  sharedRunStatusInputSchema, startSharedRun, updateSharedWorkflow, updateSharedWorkflowInputSchema,
} from "../../services/pipelineSharing";

export const sharePipelineTool: McpTool = {
  name: "share_pipeline",
  description:
    "Grant ONE named other account access to ONE pipeline you own. mode='run_only' (default) lets them run it and keep the answer while their reads return step names and states only — never the step prompts, system prompts or workflow definition. mode='full' also lets them read the definition; pass canModify only with 'full' to let them edit it. A share is a loan between two accounts, never a transfer: you stay the owner, and publishing stays reserved to the original creator. Sharing the same pipeline with the same account again updates that grant.",
  inputSchema: sharePipelineInputSchema,
  requiredScopes: ["mcp:write"],
  annotations: { readOnlyHint: false },
  handler: async (args, ctx) => {
    const input = sharePipelineInputSchema.parse(args);
    const share = await sharePipeline(ctx.userId, input);
    return {
      ...share,
      meaning: share.mode === "run_only"
        ? `Account ${share.granteeId} may run '${share.projectName}' and keep the result; the prompts and the definition stay yours.`
        : `Account ${share.granteeId} may read the definition of '${share.projectName}'${share.canModify ? " and edit it" : " but not change it"}. You remain the owner and the only account that can publish it.`,
      next: "Revoke at any time with revoke_pipeline_share (the grant is re-read at dispatch, so a queued run stops before its first provider call).",
    };
  },
};

export const listPipelineSharesTool: McpTool = {
  name: "list_pipeline_shares",
  description:
    "List the pipeline shares involving your account: what you have lent out (including revoked grants, which are kept as the record that access existed) and what is currently lent to you. An incoming row names the ORIGINAL creator of the work, so you can see plainly that a shared pipeline is a loan: running and improving it is yours, publishing it is not.",
  inputSchema: listSharesInputSchema,
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true },
  handler: async (args, ctx) => {
    const input = listSharesInputSchema.parse(args);
    return listShares(ctx.userId, { projectId: input.projectId });
  },
};

export const revokePipelineShareTool: McpTool = {
  name: "revoke_pipeline_share",
  description:
    "Take a share back. Owner-only and idempotent — re-revoking changes nothing and refuses nothing. The grant row is flipped to 'revoked' rather than deleted, and because access is re-read at dispatch a run that was already queued stops before it makes any provider call. Runs the recipient already completed stay theirs.",
  inputSchema: revokeShareInputSchema,
  requiredScopes: ["mcp:write"],
  annotations: { readOnlyHint: false, destructiveHint: true },
  handler: async (args, ctx) => {
    const input = revokeShareInputSchema.parse(args);
    return revokeShare(ctx.userId, input);
  },
};

export const getSharedPipelineTool: McpTool = {
  name: "get_shared_pipeline",
  description:
    "Read a pipeline that was shared with you, at exactly the level your grant allows. A 'full' share returns the real steps including every system prompt. A 'run_only' share returns step ORDER, NAMES, ROLES AND ENABLED FLAGS ONLY and states what was withheld — no prompts, no models, no provider references. An account with no grant gets 'not found', never 'forbidden'.",
  inputSchema: getSharedWorkflowInputSchema,
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true },
  handler: async (args, ctx) => {
    const input = getSharedWorkflowInputSchema.parse(args);
    return getSharedWorkflow(ctx.userId, input);
  },
};

export const updateSharedPipelineTool: McpTool = {
  name: "update_shared_pipeline",
  description:
    "Edit the steps of a pipeline someone shared with you, and only while their grant says canModify. Refused for a run_only grant and for a read-only full grant. The write lands on the OWNER's project (that is what editing a shared object means) — ownership does not move, and the project's recorded original creator is left exactly as it was, so improving borrowed work can never turn it into work you may sell.",
  inputSchema: updateSharedWorkflowInputSchema,
  requiredScopes: ["mcp:write"],
  annotations: { readOnlyHint: false },
  handler: async (args, ctx) => {
    const input = updateSharedWorkflowInputSchema.parse(args);
    return updateSharedWorkflow(ctx.userId, input);
  },
};

export const runSharedPipelineTool: McpTool = {
  name: "run_shared_pipeline",
  description:
    "Run a pipeline that was shared with you. The definition never lands in your own records: an immutable snapshot owned by the account that shared it executes inside a container project of yours, on YOUR provider (you pay for your own calls, and the owner's stored provider is never the route). Under a run_only grant the run is redacted at the write, so no prompt text is ever stored for it; under a full grant you can also read the run normally.",
  inputSchema: runSharedPipelineInputSchema,
  requiredScopes: ["mcp:run"],
  annotations: { readOnlyHint: false },
  handler: async (args, ctx) => {
    const input = runSharedPipelineInputSchema.parse(args);
    return startSharedRun({ granteeId: ctx.userId, ...input });
  },
};

export const sharedRunStatusTool: McpTool = {
  name: "shared_run_status",
  description:
    "Your view of a run of a shared pipeline: status, per-step progress METADATA (step number, name, role, state, tokens, latency), totals, the final output when it completed, and the failure category. Step prompt and context columns are not part of this projection, and on a run_only share the provider's own error text is withheld because it can quote the owner's workflow.",
  requiredScopes: ["mcp:read"],
  inputSchema: sharedRunStatusInputSchema,
  annotations: { readOnlyHint: true },
  handler: async (args, ctx) => {
    const input = sharedRunStatusInputSchema.parse(args);
    const view = await getSharedRunView({ userId: ctx.userId, swarmRunId: input.swarmRunId });
    if (!view) throw new Error("not_found_or_not_authorized: this run is not a shared-pipeline run visible to your account");
    return view;
  },
};

export const cloneSharedPipelineTool: McpTool = {
  name: "clone_shared_pipeline",
  description:
    "Copy a pipeline shared with you in 'full' mode into your own project, with a template and a first immutable version. Your copy runs and reads like yours, and it stays ATTRIBUTED: the new project and version record the account that originally created the work, and publishing remains refused for anyone but that account. Refused for a run_only grant, because you cannot copy what you were never allowed to read.",
  inputSchema: cloneSharedPipelineInputSchema,
  requiredScopes: ["mcp:write"],
  annotations: { readOnlyHint: false },
  handler: async (args, ctx) => {
    const input = cloneSharedPipelineInputSchema.parse(args);
    return cloneSharedPipeline(ctx.userId, input);
  },
};

export const PIPELINE_SHARING_TOOLS: McpTool[] = [
  sharePipelineTool,
  listPipelineSharesTool,
  revokePipelineShareTool,
  getSharedPipelineTool,
  updateSharedPipelineTool,
  runSharedPipelineTool,
  sharedRunStatusTool,
  cloneSharedPipelineTool,
];
