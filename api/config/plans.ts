// ═══════════════════════════════════════════════════════════════════
//  PLAN CATALOG (F0.7)
// ═══════════════════════════════════════════════════════════════════
// One flat monthly per-account subscription (owner decision 2026-09-22):
// no tier ladder, no seats, no per-run fees — the user always pays for their
// own LLM calls with their own keys (BYOK). The Stripe price ID comes from
// env; `subscriptions` rows still record whatever plan string a live
// subscription carries so webhook reconciliation keeps working.
//
// PLAN_CAPABILITIES used to live here and fed the entitlements brain; a plan
// now grants no capability, so it is gone. `team_seat` (per-seat billing) is
// gone with the team features.

import { env } from "../lib/env";

export type PlanId = "solo";

export interface Plan {
  id: PlanId;
  name: string;
  interval: "month";
  priceId: string; // Stripe price id from env ("" when unconfigured)
}

export const PLANS: Record<PlanId, Plan> = {
  solo: {
    id: "solo",
    name: "DeeWaanAI",
    interval: "month",
    priceId: env.stripePriceSolo,
  },
};

/** Public, secret-free plan listing for the pricing UI. */
export function listPublicPlans(): Array<Omit<Plan, "priceId"> & { available: boolean }> {
  return Object.values(PLANS).map((p) => ({
    id: p.id,
    name: p.name,
    interval: p.interval,
    available: p.priceId.length > 0,
  }));
}
