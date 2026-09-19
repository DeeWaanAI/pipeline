/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * BATCH SERVICE — Research Mode runBatch + batch lifecycle
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { getDb } from "../queries/connection";
import { swarmBatches, swarmRuns, agentResponses } from "@db/schema";
import { eq, and, or, desc, sql } from "drizzle-orm";
import { enqueueSwarmRun } from "../workers/swarmWorker";
import { logger } from "../lib/logger";
import type { SwarmRunParams } from "./swarmService";

export interface RunBatchInput {
  projectId: number;
  userId: number;
  name?: string;
  inputs: string[];
  templateId?: number;
  chain?: {
    targetProjectId: number;
    inputTemplate?: string;
  };
}

export interface BatchStatus {
  batchId: number;
  name: string | null;
  status: string;
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  totalTokensUsed: number;
  createdAt: Date;
  completedAt: Date | null;
  runs: Array<{
    id: number;
    status: string;
    inputPreview: string;
    totalTokensUsed: number | null;
    error: string | null;
  }>;
}

/** Create a batch and enqueue all member runs. */
export async function createBatch(input: RunBatchInput): Promise<{
  batchId: number;
  runIds: number[];
  status: "queued";
}> {
  const db = getDb();
  const { projectId, userId, name, inputs, chain } = input;

  if (inputs.length === 0 || inputs.length > 100) {
    throw new Error("Batch must have 1–100 inputs");
  }

  // Create batch row
  const [batchRow] = await db.insert(swarmBatches).values({
    userId,
    projectId,
    name: name ?? `Batch ${new Date().toISOString()}`,
    totalRuns: inputs.length,
    status: "running",
  });
  const batchId = Number(batchRow.insertId);

  // Insert swarm_runs for each input
  const runIds: number[] = [];
  for (const prompt of inputs) {
    const runParams: SwarmRunParams = {
      source: "execute",
      prompt,
      batchId,
      stateless: true,
      ...(chain
        ? {
            chain: {
              targetProjectId: chain.targetProjectId,
              inputTemplate: chain.inputTemplate ?? "{{finalResponse}}",
              depth: 0,
              lineage: [],
            },
          }
        : {}),
    };

    const [runRow] = await db.insert(swarmRuns).values({
      projectId,
      userId,
      userPrompt: prompt,
      status: "pending",
      batchId,
      runParams,
    });
    const runId = Number(runRow.insertId);
    runIds.push(runId);

    // Enqueue (idempotencyKey prevents double-enqueue on retry)
    await enqueueSwarmRun(runId, userId);
  }

  logger.info(`[batchService] Created batch ${batchId} with ${runIds.length} runs`);
  return { batchId, runIds, status: "queued" };
}

/** Atomically update batch progress when a member reaches terminal state. */
export async function incrementBatchProgress(
  batchId: number,
  delta: {
    completed?: number;
    failed?: number;
    tokens?: number;
  },
): Promise<void> {
  const db = getDb();

  await db
    .update(swarmBatches)
    .set({
      completedRuns: sql`${swarmBatches.completedRuns} + ${delta.completed ?? 0}`,
      failedRuns: sql`${swarmBatches.failedRuns} + ${delta.failed ?? 0}`,
      totalTokensUsed: sql`${swarmBatches.totalTokensUsed} + ${delta.tokens ?? 0}`,
    })
    .where(eq(swarmBatches.id, batchId));

  // Check for completion
  const [batch] = await db
    .select()
    .from(swarmBatches)
    .where(eq(swarmBatches.id, batchId))
    .limit(1);

  if (batch && batch.completedRuns + batch.failedRuns >= batch.totalRuns) {
    const finalStatus = batch.failedRuns > 0 ? "completed_with_failures" : "completed";
    await db
      .update(swarmBatches)
      .set({ status: finalStatus, completedAt: new Date() })
      .where(eq(swarmBatches.id, batchId));
    logger.info(`[batchService] Batch ${batchId} ${finalStatus}`);
  }
}

/** Get batch status with per-run summaries. */
export async function getBatchStatus(batchId: number, userId: number): Promise<BatchStatus | null> {
  const db = getDb();

  const [batch] = await db
    .select()
    .from(swarmBatches)
    .where(and(eq(swarmBatches.id, batchId), eq(swarmBatches.userId, userId)))
    .limit(1);

  if (!batch) return null;

  const runs = await db
    .select({
      id: swarmRuns.id,
      status: swarmRuns.status,
      userPrompt: swarmRuns.userPrompt,
      totalTokensUsed: swarmRuns.totalTokensUsed,
      error: swarmRuns.error,
    })
    .from(swarmRuns)
    .where(eq(swarmRuns.batchId, batchId))
    .orderBy(desc(swarmRuns.id));

  return {
    batchId: batch.id,
    name: batch.name,
    status: batch.status,
    totalRuns: batch.totalRuns,
    completedRuns: batch.completedRuns,
    failedRuns: batch.failedRuns,
    totalTokensUsed: batch.totalTokensUsed,
    createdAt: batch.createdAt,
    completedAt: batch.completedAt,
    runs: runs.map((r) => ({
      id: r.id,
      status: r.status,
      inputPreview: r.userPrompt.substring(0, 100),
      totalTokensUsed: r.totalTokensUsed,
      error: r.error ? r.error.substring(0, 200) : null,
    })),
  };
}

/** List batches for a user (most recent first). */
export async function listBatches(userId: number, limit = 20): Promise<
  Array<typeof swarmBatches.$inferSelect>
> {
  const db = getDb();
  return db
    .select()
    .from(swarmBatches)
    .where(eq(swarmBatches.userId, userId))
    .orderBy(desc(swarmBatches.createdAt))
    .limit(limit);
}

/** Cancel a batch and all non-terminal members. */
export async function cancelBatch(batchId: number, userId: number): Promise<void> {
  const db = getDb();

  const [batch] = await db
    .select()
    .from(swarmBatches)
    .where(and(eq(swarmBatches.id, batchId), eq(swarmBatches.userId, userId)))
    .limit(1);

  if (!batch) throw new Error("Batch not found");

  await db
    .update(swarmBatches)
    .set({ status: "cancelled" })
    .where(eq(swarmBatches.id, batchId));

  // Cancel all non-terminal runs
  await db
    .update(swarmRuns)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(swarmRuns.batchId, batchId),
        or(eq(swarmRuns.status, "pending"), eq(swarmRuns.status, "running")),
      ),
    );

  logger.info(`[batchService] Cancelled batch ${batchId}`);
}


/** Resume a paused batch by re-enqueuing all non-terminal members. */
export async function resumeBatch(batchId: number, userId: number): Promise<void> {
  const db = getDb();

  const [batch] = await db
    .select()
    .from(swarmBatches)
    .where(and(eq(swarmBatches.id, batchId), eq(swarmBatches.userId, userId)))
    .limit(1);

  if (!batch) throw new Error("Batch not found");
  if (batch.status !== "paused_credit" && batch.status !== "paused_outage") {
    throw new Error(`Batch cannot be resumed (status: ${batch.status})`);
  }

  await db
    .update(swarmBatches)
    .set({ status: "running" })
    .where(eq(swarmBatches.id, batchId));

  // Re-enqueue all non-terminal members
  const members = await db
    .select()
    .from(swarmRuns)
    .where(
      and(
        eq(swarmRuns.batchId, batchId),
        or(eq(swarmRuns.status, "pending"), eq(swarmRuns.status, "running")),
      ),
    );

  for (const run of members) {
    try {
      await enqueueSwarmRun(run.id, run.userId, { bypassDedup: true });
    } catch (err) {
      logger.error("[batchService] Failed to re-enqueue run", { runId: run.id, error: (err as Error).message });
    }
  }

  logger.info(`[batchService] Resumed batch ${batchId}, re-enqueued ${members.length} runs`);
}

/** Export batch results as CSV string. */
export async function exportBatchResults(batchId: number, userId: number): Promise<string> {
  const db = getDb();

  const [batch] = await db
    .select()
    .from(swarmBatches)
    .where(and(eq(swarmBatches.id, batchId), eq(swarmBatches.userId, userId)))
    .limit(1);

  if (!batch) throw new Error("Batch not found");

  const runs = await db
    .select({
      id: swarmRuns.id,
      userPrompt: swarmRuns.userPrompt,
      status: swarmRuns.status,
      totalTokensUsed: swarmRuns.totalTokensUsed,
      totalLatencyMs: swarmRuns.totalLatencyMs,
      finalResponseId: swarmRuns.finalResponseId,
      error: swarmRuns.error,
    })
    .from(swarmRuns)
    .where(eq(swarmRuns.batchId, batchId))
    .orderBy(swarmRuns.id);

  const esc = (s: string) => `"${(s ?? "").replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
  const rows: string[] = [];
  rows.push(["run_id","input_preview","status","final_response","error","total_tokens_used","total_latency_ms"].join(","));

  for (const run of runs) {
    let finalResponse = "";
    if (run.finalResponseId) {
      const [resp] = await db
        .select({ content: agentResponses.content })
        .from(agentResponses)
        .where(eq(agentResponses.id, run.finalResponseId))
        .limit(1);
      finalResponse = resp?.content ?? "";
    }
    const inputPreview = (run.userPrompt ?? "").substring(0, 200);
    rows.push([run.id, esc(inputPreview), run.status, esc(finalResponse), esc(run.error ?? ""), run.totalTokensUsed ?? 0, run.totalLatencyMs ?? 0].join(","));
  }

  return rows.join("\n");
}
