// ═══════════════════════════════════════════════════════════════════
//  PLAN CATALOG (F0.7)
// ═══════════════════════════════════════════════════════════════════
// Stripe price IDs come from env; capability sets feed the entitlements
// brain (F0.6). Adding a plan = add a row here + a Stripe price.

import { env } from "../lib/env";

export type PlanId = "solo" | "team_seat";

export interface Plan {
  id: PlanId;
  name: string;
  interval: "month";
  perSeat: boolean;
  priceId: string; // Stripe price id from env ("" when unconfigured)
}

export const PLANS: Record<PlanId, Plan> = {
  solo: {
    id: "solo",
    name: "Solo",
    interval: "month",
    perSeat: false,
    priceId: env.stripePriceSolo,
  },
  team_seat: {
    id: "team_seat",
    name: "Team Seat",
    interval: "month",
    perSeat: true,
    priceId: env.stripePriceTeamSeat,
  },
};

// Capabilities granted while a subscription on the plan is active/trialing
export const PLAN_CAPABILITIES: Record<string, ReadonlySet<string>> = {
  solo: new Set(["pipeline:fixed", "llm:1", "pipeline:custom", "llm:3", "pipeline:autodesign"]),
  team_seat: new Set(["pipeline:fixed", "llm:1", "pipeline:custom", "llm:3", "pipeline:autodesign", "team:collaborate"]),
};

/** Public, secret-free plan listing for the pricing UI. */
export function listPublicPlans(): Array<Omit<Plan, "priceId"> & { available: boolean }> {
  return Object.values(PLANS).map((p) => ({
    id: p.id,
    name: p.name,
    interval: p.interval,
    perSeat: p.perSeat,
    available: p.priceId.length > 0,
  }));
}
