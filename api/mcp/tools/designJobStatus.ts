// MCP tools: design_job_status + cancel_design_job — companions to
// start_design_job (offering redesign v2, spec §5.2). Owner-scoped: jobs are
// looked up by (id, actor), so no cross-tenant existence leakage.

import { z } from "zod";
import type { McpTool, McpAuthContext } from "../types";
import { applyDesignJob, cancelDesignJob, getDesignJob } from "../../services/designJobService";

const statusSchema = z.object({ jobId: z.number().int().positive() });

export const designJobStatus: McpTool = {
  name: "design_job_status",
  description:
    "Poll a durable auto-design job. States: queued → running → succeeded/failed/cancelled. On success the candidate is retained as a pipeline version — apply it deliberately with apply_design_job; it is never applied automatically, and a project edited meanwhile yields a retained 'revision_conflict' instead of an overwrite.",
  inputSchema: statusSchema,
  requiredScopes: ["mcp:read"],
  featureFlag: "v2DesignJobs",
  annotations: { readOnlyHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const { jobId } = statusSchema.parse(args);
    const job = await getDesignJob({ userId: ctx.userId, jobId });
    if (!job) throw new Error("Job not found");
    return job;
  },
};

export const applyDesignJobTool: McpTool = {
  name: "apply_design_job",
  description:
    "Apply a successful durable design job to its original pipeline after the user approves replacing the steps. Uses the retained candidate without another LLM call. Returns applied, not_ready or revision_conflict; a changed project is not overwritten. Read the applied pipeline with get_pipeline before running it.",
  inputSchema: statusSchema,
  requiredScopes: ["mcp:write"],
  featureFlag: "v2DesignJobs",
  annotations: { readOnlyHint: false, destructiveHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const { jobId } = statusSchema.parse(args);
    return applyDesignJob({ userId: ctx.userId, jobId });
  },
};

export const cancelDesignJobTool: McpTool = {
  name: "cancel_design_job",
  description:
    "Cancel a queued or running auto-design job. Queued jobs cancel immediately; running jobs stop dispatching new work at the next checkpoint — provider calls already incurred are retained in the attempt record and are not refunded.",
  inputSchema: statusSchema,
  requiredScopes: ["mcp:write"],
  featureFlag: "v2DesignJobs",
  annotations: { readOnlyHint: false, destructiveHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const { jobId } = statusSchema.parse(args);
    const ok = await cancelDesignJob({ userId: ctx.userId, jobId });
    if (!ok) throw new Error("Job not found");
    return { cancelled: true };
  },
};
