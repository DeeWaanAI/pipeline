// MCP tool: run_status — status, per-step progress, usage totals and the
// final response of a pipeline run. Access is checked against the run's
// project (owner or team member) before any data is returned.

import { z } from "zod";
import { eq, asc } from "drizzle-orm";
import type { McpTool, McpAuthContext } from "../types";
import { getDb } from "../../queries/connection";
import { swarmRuns, agentRuns, agentResponses } from "@db/schema";
import { canAccessProject, truncate } from "./_shared";

const inputSchema = z.object({
  runId: z.number().int().positive(),
});

const MAX_STEPS = 100;
const MAX_RESPONSE_CHARS = 16000;

export const runStatus: McpTool = {
  name: "run_status",
  description:
    "Get the status of a pipeline run: current step, per-step agent progress with token/latency usage, totals, and the final response once completed.",
  inputSchema,
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const { runId } = inputSchema.parse(args);

    const db = getDb();
    const [run] = await db.select().from(swarmRuns)
      .where(eq(swarmRuns.id, runId)).limit(1);
    if (!run) throw new Error("Run not found");

    // Access check via the run's project BEFORE returning any run data.
    const allowed = run.userId === ctx.userId || await canAccessProject(ctx.userId, run.projectId);
    if (!allowed) throw new Error("Run not found");

    const stepRows = await db
      .select({
        step: agentRuns.pipelineStep,
        agentName: agentRuns.agentName,
        agentRole: agentRuns.agentRole,
        status: agentRuns.status,
        tokensUsed: agentRuns.tokensUsed,
        latencyMs: agentRuns.latencyMs,
      })
      .from(agentRuns)
      .where(eq(agentRuns.swarmRunId, runId))
      .orderBy(asc(agentRuns.pipelineStep), asc(agentRuns.id))
      .limit(MAX_STEPS);

    let finalResponse: string | undefined;
    if (run.status === "completed" && run.finalResponseId) {
      const [resp] = await db.select({ content: agentResponses.content })
        .from(agentResponses)
        .where(eq(agentResponses.id, run.finalResponseId))
        .limit(1);
      if (resp) finalResponse = truncate(resp.content, MAX_RESPONSE_CHARS);
    }

    return {
      runId,
      status: run.status,
      currentStep: run.currentStep,
      totalTokensUsed: run.totalTokensUsed ?? 0,
      totalLatencyMs: run.totalLatencyMs ?? 0,
      steps: stepRows.map((s) => ({
        step: s.step,
        agentName: s.agentName,
        agentRole: s.agentRole,
        status: s.status,
        tokensUsed: s.tokensUsed ?? 0,
        latencyMs: s.latencyMs ?? 0,
      })),
      ...(finalResponse !== undefined ? { finalResponse } : {}),
      // swarm_runs has no error column; surface a status-derived hint only.
      ...(run.status === "failed" ? { error: run.error ?? "Pipeline run failed" } : {}),
    };
  },
};
