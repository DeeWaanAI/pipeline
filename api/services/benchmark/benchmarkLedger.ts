// Append-only provider-call ledger (offering redesign spec §6.1/§9).
// Design rule: retries NEVER overwrite prior attempts; uncertain outcomes
// remain visible; cost completeness is explicit (`unknown` ≠ 0).

import { and, eq, sql } from "drizzle-orm";
import { callAttempts } from "@db/schema";
import { getDb } from "../../queries/connection";
import type { ExecutionPurpose } from "../../../contracts/offeringV2";
import { PRICE_VECTOR_VERSION } from "./benchmarkTypes";
import { rateForAttempt } from "./modelPricing";

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
  /**
   * Route to price an AGGREGATE row by: set only when every call in it ran on
   * one (provider, model) pair — see `singleRouteOfSnapshot`. Pricing input
   * only: `provider_ref_id` keeps its meaning of "whose credential this call
   * was billed against", which an aggregate of several calls does not have.
   */
  pricingRoute?: { providerRefId: number; model: string } | null;
}

/**
 * A row is priced from the same sources, in the same order, as the quote the
 * user approved against: the host's published list first, then the local vector.
 * The call actually made is `returnedModel` when the provider named it; if that
 * id is not in the list, the requested id is used — the quote was built from the
 * requested id too, so the pair stays comparable instead of splitting into
 * "$ quoted" against "unknown actual". An unresolvable id is UNKNOWN, never 0.
 */
async function priceAttempt(input: RecordAttemptInput) {
  const models = [...new Set([
    input.returnedModel, input.requestedModel, input.pricingRoute?.model,
  ].map((m) => (m ?? "").trim()).filter(Boolean))];
  const providerRefId = input.pricingRoute?.providerRefId ?? input.providerRefId;
  for (const model of models) {
    const rate = await rateForAttempt(providerRefId, model);
    if (!rate) continue;
    const tokens = input.promptTokens ?? 0;
    const completion = input.completionTokens ?? 0;
    const usd = (tokens / 1000) * rate.rates.in + (completion / 1000) * rate.rates.out;
    return {
      costBasis: rate.basis,
      costPricingAsOf: rate.asOf,
      priceVectorVersion: rate.basis === "price_vector" ? PRICE_VECTOR_VERSION : null,
      estimatedCostUsd: String(Math.round(usd * 1e8) / 1e8),
    };
  }
  return { costBasis: null, costPricingAsOf: null, priceVectorVersion: null, estimatedCostUsd: null };
}

export async function recordCallAttempt(input: RecordAttemptInput): Promise<number> {
  const db = getDb();
  const [maxRow] = await db
    .select({ m: sql<number>`COALESCE(MAX(${callAttempts.attemptIndex}), 0)` })
    .from(callAttempts)
    .where(and(eq(callAttempts.operationKind, input.operationKind), eq(callAttempts.operationId, input.operationId)));
  // A pricing lookup touches the provider's public list, so it must never be
  // able to lose the ledger row it is annotating (spec §9: an attempt without a
  // dollar figure is still a visible attempt).
  const cost = await priceAttempt(input).catch(() => ({
    costBasis: null, costPricingAsOf: null, priceVectorVersion: null, estimatedCostUsd: null,
  }));
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
    costBasis: cost.costBasis,
    costPricingAsOf: cost.costPricingAsOf,
    estimatedCostUsd: cost.estimatedCostUsd,
    costCompleteness: input.outcome === "uncertain" ? "unknown" : cost.estimatedCostUsd === null ? "unknown" : "complete",
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
  /** Rows with a dollar figure at all. `totalCalls - pricedOperations` is the
   *  part of the bill that is still UNKNOWN, and UNKNOWN is never 0 (§9). */
  pricedOperations: number;
  /** Ledger rows are ONE PER LOGICAL OPERATION (a generation run, a judge
   *  call) with that operation's summed usage — NOT one per provider LLM call.
   *  A pipeline generation that made 6 provider calls is one `generation`
   *  row, so these counts are never comparable with the plan's call counts. */
  generationOperations: number;
  judgmentOperations: number;
  knownCostUsd: string;
  costCompleteness: "complete" | "partial" | "unknown";
  /** Which sources produced the dollar figures on this benchmark's rows, in
   *  first-seen order. A disclosure must say this: "platform price vector" is a
   *  false statement about a row priced from the provider's own list. */
  pricingBases: string[];
}

/** The part of `LedgerTotals` a disclosure needs, so a grouped query over many
 *  benchmarks can produce the same sentence as the per-benchmark totals. */
export type CostDisclosureInput = Pick<
  LedgerTotals,
  "totalCalls" | "uncertainCalls" | "pricedOperations" | "knownCostUsd" | "costCompleteness" | "pricingBases"
>;

export async function benchmarkLedgerTotals(benchmarkId: number): Promise<LedgerTotals> {
  const db = getDb();
  const rows = await db.select({
    operationKind: callAttempts.operationKind,
    outcome: callAttempts.outcome,
    estimatedCostUsd: callAttempts.estimatedCostUsd,
    costCompleteness: callAttempts.costCompleteness,
    costBasis: callAttempts.costBasis,
  }).from(callAttempts).where(eq(callAttempts.benchmarkId, benchmarkId));
  let known = 0;
  let anyUnknown = false;
  let uncertain = 0;
  let priced = 0;
  let generationOperations = 0;
  let judgmentOperations = 0;
  const pricingBases: string[] = [];
  for (const r of rows) {
    if (r.outcome === "uncertain") uncertain++;
    if (r.operationKind === "generation") generationOperations++;
    if (r.operationKind === "judgment") judgmentOperations++;
    if (r.costCompleteness !== "complete") anyUnknown = true;
    if (r.costBasis && !pricingBases.includes(r.costBasis)) pricingBases.push(r.costBasis);
    if (r.estimatedCostUsd != null) {
      known += Number(r.estimatedCostUsd);
      priced++;
    }
  }
  return {
    totalCalls: rows.length,
    uncertainCalls: uncertain,
    pricedOperations: priced,
    generationOperations,
    judgmentOperations,
    knownCostUsd: known.toFixed(8),
    costCompleteness: rows.length === 0 ? "unknown" : anyUnknown ? "partial" : "complete",
    pricingBases,
  };
}

/**
 * The ledger reduced to something a user can read without misreading it.
 * `knownUsd` is a FACT only when every recorded operation is priced; otherwise
 * it is `null` and the partial sum appears as `pricedSoFarUsd` inside a
 * sentence that says it is a floor. An earlier build answered "19 calls,
 * $0.00000000" for a benchmark whose 19 calls had simply not been priced yet,
 * which a user reads as "nothing owed" (D9 finding 1) — and "not known" is one
 * encoding, not `null` in one field and `0` in another.
 */
export function costDisclosure(totals: CostDisclosureInput) {
  const unpriced = totals.totalCalls - totals.pricedOperations;
  const bases = totals.pricingBases.length ? ` priced from ${totals.pricingBases.join(" + ")}` : "";
  if (totals.totalCalls === 0) {
    return {
      knownUsd: null, pricedSoFarUsd: null, unpricedOperations: 0, uncertainOperations: 0,
      completeness: totals.costCompleteness, pricingBases: totals.pricingBases,
      display: "No provider call recorded against this benchmark yet — nothing has been spent.",
    };
  }
  if (unpriced === 0) {
    return {
      knownUsd: totals.knownCostUsd, pricedSoFarUsd: totals.knownCostUsd,
      unpricedOperations: 0, uncertainOperations: totals.uncertainCalls,
      completeness: totals.costCompleteness, pricingBases: totals.pricingBases,
      display: `$${totals.knownCostUsd} across ${totals.totalCalls} recorded operations, all of them priced${bases}.`
        + (totals.uncertainCalls ? ` ${totals.uncertainCalls} of those calls returned an uncertain outcome, so the true figure may be higher.` : ""),
    };
  }
  return {
    knownUsd: null, pricedSoFarUsd: totals.knownCostUsd,
    unpricedOperations: unpriced, uncertainOperations: totals.uncertainCalls,
    completeness: totals.costCompleteness, pricingBases: totals.pricingBases,
    display: `At least $${totals.knownCostUsd} of ${totals.totalCalls} recorded operations is priced${bases}; ${unpriced} have no price yet, so this is a FLOOR and not the total owed.`,
  };
}
