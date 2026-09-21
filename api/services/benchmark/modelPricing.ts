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
import { llmProviders } from "@db/schema";
import { getDb } from "../../queries/connection";
import { createProviderAdapter } from "../../lib/providers";
import { decrypt, getMasterKey } from "../cryptoService";
import { logger } from "../../lib/logger";
import { readPriceVector } from "./benchmarkTypes";
import type { ModelRates } from "../../lib/providers/base";

export const PRICING_CACHE_TTL_MS = 10 * 60 * 1000;
const PROVIDER_TIMEOUT_MS = 8_000;

export type PricingSource = "provider_list" | "price_vector";

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
  if (hit && Date.now() - hit.fetchedAt < PRICING_CACHE_TTL_MS) return hit.rates;

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
      // degrades to the local vector and says so.
      rates = await Promise.race([
        adapter.listPricing(),
        new Promise<Record<string, ModelRates>>((resolve) => setTimeout(() => resolve({}), PROVIDER_TIMEOUT_MS)),
      ]);
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
function lookup(rates: Record<string, ModelRates>, model: string): ModelRates | undefined {
  if (rates[model]) return rates[model];
  const lower = model.toLowerCase();
  const key = Object.keys(rates).find((k) => k.toLowerCase() === lower);
  return key ? rates[key] : undefined;
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
  const rates: ResolvedPricing["rates"] = {};
  const sourceByModel: ResolvedPricing["sourceByModel"] = {};
  const missing: string[] = [];
  for (const model of models) {
    const liveRate = lookup(live, model);
    if (liveRate) {
      rates[model] = liveRate;
      sourceByModel[model] = "provider_list";
      continue;
    }
    const fallback = vector[model];
    if (fallback) {
      rates[model] = fallback;
      sourceByModel[model] = "price_vector";
      continue;
    }
    missing.push(model);
  }

  const sources = new Set(Object.values(sourceByModel));
  const basis = sources.size === 0 ? "unknown" : sources.size === 1 ? [...sources][0] : "mixed";
  return { rates, sourceByModel, asOf: new Date().toISOString(), missing, basis };
}
