// MCP tool: upgrade_tier — show current plan, what you're missing, and
// a Stripe checkout URL (or pricing page link if Stripe is not configured).

import { z } from "zod";
import type { McpTool, McpAuthContext } from "../types";
import { resolveCapabilities } from "../../services/entitlements";
import { isBillingConfigured, createCheckoutSession } from "../../services/billingService";
import { TIER_CAPABILITIES } from "../../services/entitlements";
import { listPublicPlans } from "../../config/plans";
import { env } from "../../lib/env";

const inputSchema = z.object({
  planId: z.enum(["solo", "team_seat"]).optional()
    .describe("Which plan to upgrade to (solo or team_seat). If omitted, returns all options."),
});

/** Human-readable descriptions for each capability. */
const CAPABILITY_LABELS: Record<string, string> = {
  "pipeline:fixed": "Sequential pipelines",
  "llm:1": "1 LLM provider",
  "pipeline:custom": "IF/WHILE quality gates + custom pipelines",
  "llm:3": "Up to 3 LLM providers per pipeline",
  "marketplace:publish": "Publish and earn from marketplace",
  "pipeline:autodesign": "AI Auto-Designer",
  "team:collaborate": "Team collaboration",
};

export const upgradeTier: McpTool = {
  name: "upgrade_tier",
  description:
    "Show your current plan, what features are unlocked, and what you're missing. Returns upgrade options with a Stripe checkout link (or a pricing page link if billing is not live yet).",
  inputSchema,
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = inputSchema.parse(args);
    const { capabilities, tier } = await resolveCapabilities(ctx.userId);
    const capSet = new Set(capabilities);

    // Determine which capabilities are missing at each tier
    const allTiers = ["standard", "pro_designer", "pro_auto"];
    const tierIndex = allTiers.indexOf(tier);

    const missingByTier: Record<string, string[]> = {};
    for (let i = tierIndex + 1; i < allTiers.length; i++) {
      const t = allTiers[i];
      const caps = TIER_CAPABILITIES[t] ?? new Set();
      missingByTier[t] = [...caps].filter((c) => !capSet.has(c));
    }

    // Build upgrade options
    const plans = listPublicPlans();
    const billingLive = isBillingConfigured();

    const options: Array<{
      planId: string;
      name: string;
      available: boolean;
      includesTier: string;
      checkoutUrl?: string;
      pricingPageUrl?: string;
      unlocks: string[];
    }> = [];

    const origin = env.publicAppUrl;

    for (const plan of plans) {
      if (!plan.available) continue;
      const includesTier = plan.id === "solo" ? "pro_auto" : "pro_auto + team";
      const unlocks =
        plan.id === "solo"
          ? [...(TIER_CAPABILITIES["pro_auto"] ?? [])].filter((c) => !capSet.has(c))
          : ["team:collaborate", ...(TIER_CAPABILITIES["pro_auto"] ?? [])].filter((c) => !capSet.has(c));

      let checkoutUrl: string | undefined;

      if (billingLive && input.planId === plan.id) {
        try {
          const { url } = await createCheckoutSession({
            userId: ctx.userId,
            plan: plan.id,
            successUrl: `${origin}/settings?checkout=success`,
            cancelUrl: `${origin}/settings?checkout=cancel`,
          });
          checkoutUrl = url;
        } catch {
          checkoutUrl = undefined;
        }
      }

      options.push({
        planId: plan.id,
        name: plan.name,
        available: plan.available,
        includesTier,
        checkoutUrl,
        pricingPageUrl: billingLive ? undefined : `${origin}/pricing`,
        unlocks: unlocks.map((c) => CAPABILITY_LABELS[c] ?? c),
      });
    }

    return {
      currentTier: tier,
      currentCapabilities: capabilities.map((c) => CAPABILITY_LABELS[c] ?? c),
      missingCapabilities: Object.fromEntries(
        Object.entries(missingByTier).map(([t, caps]) => [t, caps.map((c) => CAPABILITY_LABELS[c] ?? c)]),
      ),
      billingLive,
      options,
      nextStep: billingLive
        ? (input.planId ? "Click the checkout URL to complete payment." : "Pass planId='solo' or 'team_seat' to get a checkout URL.")
        : "Billing is not configured yet. Visit the pricing page or contact the admin.",
    };
  },
};
