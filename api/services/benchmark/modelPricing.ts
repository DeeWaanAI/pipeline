// Live model pricing for cost quotes (spec §9).
//
// Why not a hand-maintained table: providers reprice and run promotions, and an
// operator-maintained vector drifts silently while still being presented to the
// user as "what this will cost". So the quote asks the provider that will
// actually serve the call, falls back to the local vector, and says which one it
// used. A rate that cannot be retrieved stays UNKNOWN — never zero, never
// guessed (spec §9), and the ledger keeps storing TOKENS so any historical
// figure can be re-priced when the real bill is known.

import { inArray } from "drizzle-orm";
import { declaredModelPrices, llmProviders } from "@db/schema";
import { getDb } from "../../queries/connection";
import { createProviderAdapter } from "../../lib/providers";
import { decrypt, getMasterKey } from "../cryptoService";
import { logger } from "../../lib/logger";
import { readPriceVector } from "./benchmarkTypes";
import type { ModelRates } from "../../lib/providers/base";

export const PRICING_CACHE_TTL_MS = 10 * 60 * 1000;
/**
 * How long an EMPTY retrieval is remembered. Deliberately far shorter than the
 * positive TTL: an unreachable or slow host used to be cached as `{}` for the
 * full ten minutes, so one 8-second timeout made every attempt in the next ten
 * minutes report `unknown` for a model that had been priced minutes earlier —
 * and a quote taken in that window could only ever say the cost was
 * unretrievable. The measured evidence was the same (provider, model) pair
 * appearing as `provider_list` on six ledger rows and `NULL` on thirteen.
 */
export const PRICING_MISS_TTL_MS = 15_000;
const PROVIDER_TIMEOUT_MS = 8_000;

/** `declared` is the account owner's own stated rate for a credential they own
 *  (migration 034) — including a deliberate 0 for a locally served model. It is
 *  never called a provider's published price, and never the platform vector. */
export type PricingSource = "provider_list" | "price_vector" | "declared";

export interface ResolvedPricing {
  rates: Record<string, ModelRates>;
  sourceByModel: Record<string, PricingSource>;
  /** When the provider numbers were retrieved — a quote is a momentary fact. */
  asOf: string;
  /** Models with no rate from either source. Cost is unknown for these. */
  missing: string[];
  basis: PricingSource | "mixed" | "unknown";
}

const cache = new Map<number, { fetchedAt: number; rates: Record<string, ModelRates> }>();

/** Test seam: quote-time caching must be droppable between cases. */
export function resetPricingCache(): void {
  cache.clear();
}

async function fetchProviderRates(providerId: number): Promise<Record<string, ModelRates>> {
  const hit = cache.get(providerId);
  if (hit) {
    // A remembered failure expires on its own clock, so the next caller retries
    // instead of inheriting someone else's timeout for ten minutes.
    const ttl = Object.keys(hit.rates).length ? PRICING_CACHE_TTL_MS : PRICING_MISS_TTL_MS;
    if (Date.now() - hit.fetchedAt < ttl) return hit.rates;
  }

  const db = getDb();
  const [provider] = await db.select().from(llmProviders).where(inArray(llmProviders.id, [providerId])).limit(1);
  if (!provider) return {};

  let rates: Record<string, ModelRates> = {};
  try {
    const adapter = createProviderAdapter(
      provider.slug, decrypt(provider.apiKeyRef, getMasterKey()), provider.baseUrl, provider.defaultModel,
    );
    if (adapter.listPricing) {
      // A slow or unreachable host must not stall or fail a quote: the caller
      // degrades to the local vector and says so. The timer is cleared on
      // purpose — an unrefused 8-second timer outlives the call it was guarding.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        rates = await Promise.race([
          adapter.listPricing(),
          new Promise<Record<string, ModelRates>>((resolve) => {
            timer = setTimeout(() => resolve({}), PROVIDER_TIMEOUT_MS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (err) {
    logger.warn("live pricing failed; falling back to the local price vector", {
      providerId, slug: provider.slug, error: (err as Error).message,
    });
  }
  cache.set(providerId, { fetchedAt: Date.now(), rates });
  return rates;
}

/** Exact id match, then case-insensitive exact. Deliberately not fuzzy: an
 *  unmatched model must produce UNKNOWN rather than a sibling model's price. */
export function lookupRate(rates: Record<string, ModelRates>, model: string): ModelRates | undefined {
  if (rates[model]) return rates[model];
  const lower = model.toLowerCase();
  const key = Object.keys(rates).find((k) => k.toLowerCase() === lower);
  return key ? rates[key] : undefined;
}

/**
 * The owner's own stated rates for the credentials named, converted to the
 * per-1k unit the ledger uses (declarations are entered per 1M, because that is
 * the unit the provider consoles show). Read on every lookup and deliberately
 * NOT cached: a declaration is a number the owner just typed, and serving a
 * ten-minute-old copy would price the next call with a figure they have already
 * corrected.
 */
async function declaredRatesFor(
  providerIds: number[],
): Promise<Map<string, { rates: ModelRates; asOf: Date }>> {
  const out = new Map<string, { rates: ModelRates; asOf: Date }>();
  if (!providerIds.length) return out;
  // Like the live fetch above, a failed price lookup must be able to make the
  // answer UNKNOWN and nothing worse: it cannot fail the quote or the ledger
  // row it is annotating. An empty map is exactly that.
  let rows: Array<{
    modelId: string; inputUsdPerMillion: string; outputUsdPerMillion: string; updatedAt: Date;
  }> = [];
  try {
    const found = await getDb().select({
      modelId: declaredModelPrices.modelId,
      inputUsdPerMillion: declaredModelPrices.inputUsdPerMillion,
      outputUsdPerMillion: declaredModelPrices.outputUsdPerMillion,
      updatedAt: declaredModelPrices.updatedAt,
    }).from(declaredModelPrices).where(inArray(declaredModelPrices.providerRefId, [...new Set(providerIds)]));
    if (Array.isArray(found)) rows = found;
  } catch (err) {
    logger.warn("declared price lookup failed; the model stays UNKNOWN rather than guessed", {
      providerIds, error: (err as Error).message,
    });
    return out;
  }
  const disputed = new Set<string>();
  for (const r of rows) {
    const key = String(r.modelId ?? "").trim().toLowerCase();
    // A row with no model id prices nothing; skipping it must not take the
    // whole lookup down, because "no rate" is a valid answer and a throw is not.
    if (!key) continue;
    const rates = { in: Number(r.inputUsdPerMillion) / 1000, out: Number(r.outputUsdPerMillion) / 1000 };
    const prior = out.get(key);
    // Two of the SAME owner's credentials disagreeing about one model id is a
    // mistake only they can fix. Picking either number would present a guess as
    // a measurement, so a disputed model goes back to UNKNOWN instead.
    if (prior && (prior.rates.in !== rates.in || prior.rates.out !== rates.out)) {
      disputed.add(key);
      out.delete(key);
    } else if (!prior && !disputed.has(key)) {
      out.set(key, { rates, asOf: r.updatedAt });
    }
  }
  return out;
}

export interface AttemptRate {
  rates: ModelRates;
  basis: PricingSource;
  /** When the provider's published numbers were read. Null for the local
   *  vector, which is versioned (`priceVectorVersion`) rather than timestamped. */
  asOf: Date | null;
}

/**
 * One attempt's rate, from the same sources and in the same priority order as
 * `resolveModelPricing`: ask the provider that served the call, then the local
 * vector, then the owner's declared rate for that credential, then say unknown.
 * Used by the ledger so actuals and the quote the user approved are built from
 * the same numbers (spec §9) — a quote priced live and an actual priced from a
 * stale vector is not a comparable pair.
 *
 * Declared comes LAST on purpose: it is the one source that is not a published
 * number, so it may only turn UNKNOWN into a figure, never replace a price the
 * host actually states.
 *
 * Returns null when nothing is known. Null must never be recorded as 0.
 */
export async function rateForAttempt(
  providerRefId: number | null | undefined,
  model: string | null | undefined,
): Promise<AttemptRate | null> {
  const m = (model ?? "").trim();
  if (!m) return null;
  if (typeof providerRefId === "number") {
    const live = lookupRate(await fetchProviderRates(providerRefId), m);
    if (live) return { rates: live, basis: "provider_list", asOf: new Date() };
  }
  const vector = lookupRate(readPriceVector(), m);
  if (vector) return { rates: vector, basis: "price_vector", asOf: null };
  if (typeof providerRefId === "number") {
    const declared = (await declaredRatesFor([providerRefId])).get(m.toLowerCase());
    if (declared) return { rates: declared.rates, basis: "declared", asOf: declared.asOf };
  }
  return null;
}

export async function resolveModelPricing(opts: {
  providerIds: number[]; models: string[];
}): Promise<ResolvedPricing> {
  const models = [...new Set(opts.models.filter(Boolean))];
  const live: Record<string, ModelRates> = {};
  for (const providerId of [...new Set(opts.providerIds.filter((id): id is number => typeof id === "number"))]) {
    Object.assign(live, await fetchProviderRates(providerId));
  }

  const vector = readPriceVector();
  // Same third source, same order, so a quote and the actuals it is approved
  // against can never disagree about whether a declared rate was used.
  const declared = await declaredRatesFor(opts.providerIds.filter((id): id is number => typeof id === "number"));
  const rates: ResolvedPricing["rates"] = {};
  const sourceByModel: ResolvedPricing["sourceByModel"] = {};
  const missing: string[] = [];
  for (const model of models) {
    const liveRate = lookupRate(live, model);
    if (liveRate) {
      rates[model] = liveRate;
      sourceByModel[model] = "provider_list";
      continue;
    }
    const fallback = lookupRate(vector, model);
    if (fallback) {
      rates[model] = fallback;
      sourceByModel[model] = "price_vector";
      continue;
    }
    const stated = declared.get(model.trim().toLowerCase());
    if (stated) {
      rates[model] = stated.rates;
      sourceByModel[model] = "declared";
      continue;
    }
    missing.push(model);
  }

  const sources = new Set(Object.values(sourceByModel));
  const basis = sources.size === 0 ? "unknown" : sources.size === 1 ? [...sources][0] : "mixed";
  return { rates, sourceByModel, asOf: new Date().toISOString(), missing, basis };
}
