import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { subscriptions } from "@db/schema";
import { eq, and, inArray, desc } from "drizzle-orm";
import { listPublicPlans } from "../config/plans";
import { createCheckoutSession, isBillingConfigured, BillingNotConfiguredError } from "../services/billingService";
import { getActiveEntitlements, resolveCapabilities } from "../services/entitlements";

function billingUnavailable(): never {
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: "billing not configured",
  });
}

// Derive the public app origin from the incoming request so Stripe can
// redirect back to the frontend the user is actually on (dev vs prod).
function requestOrigin(req: Request): string {
  const origin = req.headers.get("origin");
  if (origin) return origin.replace(/\/+$/, "");
  try {
    return new URL(req.url).origin;
  } catch {
    const proto = req.headers.get("x-forwarded-proto") ?? "http";
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost";
    return `${proto}://${host}`;
  }
}

export const billingRouter = createRouter({
  // Public plan catalog (secret-free; price IDs never leave the server)
  listPlans: publicQuery.query(() => {
    return { plans: listPublicPlans(), billingEnabled: isBillingConfigured() };
  }),

  // Create a Stripe Checkout session; returns the hosted checkout URL.
  // success/cancel URLs are derived server-side from the request origin.
  // One flat per-account subscription (owner decision 2026-09-22): there is no
  // seat model and no ladder, so `solo` is the only plan that can be bought.
  createCheckout: authedQuery
    .input(z.object({
      planId: z.enum(["solo"]),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!isBillingConfigured()) billingUnavailable();
      const origin = requestOrigin(ctx.req);
      try {
        const { url } = await createCheckoutSession({
          userId: ctx.user.id,
          plan: input.planId,
          successUrl: `${origin}/settings?checkout=success`,
          cancelUrl: `${origin}/settings?checkout=cancel`,
        });
        return { url };
      } catch (err) {
        if (err instanceof BillingNotConfiguredError) billingUnavailable();
        throw err;
      }
    }),

  // Current user's active subscription + active entitlements
  mySubscription: authedQuery.query(async ({ ctx }) => {
    const db = getDb();
    const [sub] = await db.select()
      .from(subscriptions)
      .where(and(
        eq(subscriptions.userId, ctx.user.id),
        inArray(subscriptions.status, ["active", "trialing"]),
      ))
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);
    const entitlements = await getActiveEntitlements("user", ctx.user.id);
    return { subscription: sub ?? null, entitlements };
  }),

  // Current user's resolved capability set + tier (entitlements-brain
  // union: explicit grants + active subscription plan + tier + unexpired
  // voucher redemption). The UI gates features on capabilities only.
  myCapabilities: authedQuery.query(async ({ ctx }) => {
    return resolveCapabilities(ctx.user.id);
  }),
});
