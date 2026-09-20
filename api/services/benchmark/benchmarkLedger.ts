// Append-only provider-call ledger (offering redesign spec §6.1/§9).
// Design rule: retries NEVER overwrite prior attempts; uncertain outcomes
// remain visible; cost completeness is explicit (`unknown` ≠ 0).

import { and, eq, sql } from "drizzle-orm";
import { callAttempts } from "@db/schema";
import { getDb } from "../../queries/connection";
import type { ExecutionPurpose } from "../../../contracts/offeringV2";
import { estimateCostUsd } from "./benchmarkTypes";

export interface RecordAttemptInput {
  operationKind: "generation" | "judgment" | "design" | "narrative" | "preparation";
  operationId: number;
  benchmarkId: number;
  purpose: ExecutionPurpose;
  actorId: number;
  payerId: number;
  providerRefId: number | null;
  requestedModel: string;
  returnedModel?: string | null;
  providerRequestId?: string | null;
  outcome: "success" | "failed" | "uncertain";
  promptTokens?: number | null;
  completionTokens?: number | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  latencyMs?: number | null;
  errorMessage?: string | null;
}

export async function recordCallAttempt(input: RecordAttemptInput): Promise<number> {
  const db = getDb();
  const [maxRow] = await db
    .select({ m: sql<number>`COALESCE(MAX(${callAttempts.attemptIndex}), 0)` })
    .from(callAttempts)
    .where(and(eq(callAttempts.operationKind, input.operationKind), eq(callAttempts.operationId, input.operationId)));
  const cost = estimateCostUsd(input.promptTokens ?? 0, input.completionTokens ?? 0, input.returnedModel || input.requestedModel);
  const [res] = await db.insert(callAttempts).values({
    operationKind: input.operationKind,
    operationId: input.operationId,
    benchmarkId: input.benchmarkId,
    purpose: input.purpose,
    actorId: input.actorId,
    payerId: input.payerId,
    providerRefId: input.providerRefId,
    requestedModel: input.requestedModel,
    returnedModel: input.returnedModel ?? null,
    providerRequestId: input.providerRequestId ?? null,
    attemptIndex: Number(maxRow?.m ?? 0) + 1,
    outcome: input.outcome,
    promptTokens: input.promptTokens ?? null,
    completionTokens: input.completionTokens ?? null,
    priceVectorVersion: cost.priceVectorVersion,
    estimatedCostUsd: cost.estimatedUsd === null ? null : String(cost.estimatedUsd),
    costCompleteness: input.outcome === "uncertain" ? "unknown" : cost.basis === "price_vector" ? "complete" : "unknown",
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? null,
    latencyMs: input.latencyMs ?? null,
    errorMessage: input.errorMessage ? input.errorMessage.slice(0, 2000) : null,
  });
  return Number((res as { insertId: number }).insertId);
}

export interface LedgerTotals {
  totalCalls: number;
  uncertainCalls: number;
  knownCostUsd: string;
  costCompleteness: "complete" | "partial" | "unknown";
}

export async function benchmarkLedgerTotals(benchmarkId: number): Promise<LedgerTotals> {
  const db = getDb();
  const rows = await db.select({
    outcome: callAttempts.outcome,
    estimatedCostUsd: callAttempts.estimatedCostUsd,
    costCompleteness: callAttempts.costCompleteness,
  }).from(callAttempts).where(eq(callAttempts.benchmarkId, benchmarkId));
  let known = 0;
  let anyUnknown = false;
  let uncertain = 0;
  for (const r of rows) {
    if (r.outcome === "uncertain") uncertain++;
    if (r.costCompleteness !== "complete") anyUnknown = true;
    if (r.estimatedCostUsd != null) known += Number(r.estimatedCostUsd);
  }
  return {
    totalCalls: rows.length,
    uncertainCalls: uncertain,
    knownCostUsd: known.toFixed(8),
    costCompleteness: rows.length === 0 ? "unknown" : anyUnknown ? "partial" : "complete",
  };
}
