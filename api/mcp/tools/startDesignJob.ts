// MCP tool: start_design_job — durable auto-design (offering redesign v2).
// Enqueues the design as a durable job and returns a job id for polling;
// unlike legacy design_pipeline, no live desktop session is required.
// MCP sampling CANNOT be serialized into a worker, so the durable path
// always uses an owned configured provider (spec §5.2). Registered only
// when the v2DesignJobs feature flag is on for this user (server-side gate).

import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import type { McpTool, McpAuthContext } from "../types";
import { getDb } from "../../queries/connection";
import { projects } from "@db/schema";
import { startDesignJob } from "../../services/designJobService";
import { dispatchDesignJob } from "../../workers/designWorker";

const inputSchema = z.object({
  name: z.string().trim().min(1).max(200).optional().describe("Create a NEW project with this name and design into it"),
  projectId: z.number().int().positive().optional().describe("Design into an existing project you own (alternative to name)"),
  task: z.string().trim().min(1).max(5000).describe("The outcome you want the pipeline to achieve"),
  providerId: z.number().int().min(1).optional().describe("Owned LLM provider to design with (default: project/user default)"),
  idempotencyKey: z.string().min(1).max(120).optional().describe("Retry with the same key returns the existing job"),
});

export const startDesignJobTool: McpTool = {
  name: "start_design_job",
  description:
    "Start a DURABLE auto-design job: the platform designs the optimal agent pipeline for your objective on a configured LLM provider, without needing a live session. Returns a job id immediately — poll design_job_status, then use apply_design_job after the user approves applying the successful candidate. Replaces the synchronous design_pipeline for background use.",
  inputSchema,
  requiredScopes: ["mcp:write"],
  featureFlag: "v2DesignJobs",
  annotations: { readOnlyHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = inputSchema.parse(args);
    if (!input.projectId && !input.name) {
      throw new Error("Provide either projectId (existing pipeline) or name (create a new project)");
    }

    let projectId = input.projectId;
    if (!projectId) {
      const db = getDb();
      await db.insert(projects).values({
        userId: ctx.userId,
        name: input.name!,
        description: `Auto-designed for: ${input.task.substring(0, 200)}`,
      });
      const [project] = await db.select().from(projects)
        .where(eq(projects.userId, ctx.userId))
        .orderBy(desc(projects.id))
        .limit(1);
      if (!project) throw new Error("Project creation failed");
      projectId = project.id;
    }

    const { job, reused } = await startDesignJob({
      userId: ctx.userId,
      projectId,
      task: input.task,
      providerId: input.providerId,
      idempotencyKey: input.idempotencyKey,
    });
    void dispatchDesignJob(job.id, ctx.userId).catch(() => { /* outbox reconciler guarantees dispatch */ });

    return {
      jobId: job.id,
      projectId,
      state: job.state,
      reused,
      next: "Poll design_job_status; when state=succeeded and the user approves replacing the steps, call apply_design_job with jobId. Then inspect the steps with get_pipeline. The project is NOT modified until apply.",
    };
  },
};
