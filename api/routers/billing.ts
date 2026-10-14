import { createRouter, authedQuery } from "../middleware";
import { resolveCapabilities } from "../services/entitlements";

// Subscription billing is gone (no subscription exists as a product): the plan
// catalog, the solo checkout and the mySubscription read were removed with it.
// Marketplace purchases create their Stripe checkout in marketplace.purchase
// (billingService.createMarketplaceCheckoutSession) and are fulfilled by the
// webhook entry in api/billing-webhook-route.ts. What remains here is the
// entitlements read the UI gates features on.
export const billingRouter = createRouter({
  // Current user's resolved capability set (entitlements-brain union:
  // explicit grants + purchase rows). The UI gates features on capabilities
  // only.
  myCapabilities: authedQuery.query(async ({ ctx }) => {
    return resolveCapabilities(ctx.user.id);
  }),
});
