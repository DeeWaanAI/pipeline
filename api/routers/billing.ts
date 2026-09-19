import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { subscriptions, teams, teamMembers, teamSeats } from "@db/schema";
import { eq, and, inArray, desc, sql } from "drizzle-orm";
import { listPublicPlans } from "../config/plans";
import { createCheckoutSession, createTeamSeatCheckoutSession, isBillingConfigured, BillingNotConfiguredError } from "../services/billingService";
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
  createCheckout: authedQuery
    .input(z.object({
      planId: z.enum(["solo", "team_seat"]),
      seats: z.number().int().min(1).max(100).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!isBillingConfigured()) billingUnavailable();
      const origin = requestOrigin(ctx.req);
      try {
        const { url } = await createCheckoutSession({
          userId: ctx.user.id,
          plan: input.planId,
          seats: input.seats,
          successUrl: `${origin}/settings?checkout=success`,
          cancelUrl: `${origin}/settings?checkout=cancel`,
        });
        return { url };
      } catch (err) {
        if (err instanceof BillingNotConfiguredError) billingUnavailable();
        throw err;
      }
    }),

  // Team seat checkout (Phase 2 TeamSync): owner-only; one subscription
  // whose quantity equals the current member count.
  createTeamCheckout: authedQuery
    .input(z.object({
      teamId: z.number().int().positive(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!isBillingConfigured()) billingUnavailable();
      const db = getDb();

      const [team] = await db.select()
        .from(teams)
        .where(eq(teams.id, input.teamId))
        .limit(1);
      if (!team) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Team not found" });
      }
      if (team.ownerId !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the team owner can manage seat billing" });
      }

      const [countRow] = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(teamMembers)
        .where(eq(teamMembers.teamId, input.teamId));
      const seatCount = Math.max(1, Number(countRow?.count ?? 1));

      const origin = requestOrigin(ctx.req);
      try {
        const { url } = await createTeamSeatCheckoutSession({
          teamId: input.teamId,
          userId: ctx.user.id,
          seatCount,
          successUrl: `${origin}/settings?checkout=success`,
          cancelUrl: `${origin}/settings?checkout=cancel`,
        });
        return { checkoutUrl: url };
      } catch (err) {
        if (err instanceof BillingNotConfiguredError) billingUnavailable();
        throw err;
      }
    }),

  // Seat billing status for a team (any member can view).
  teamSeatStatus: authedQuery
    .input(z.object({
      teamId: z.number().int().positive(),
    }))
    .query(async ({ input, ctx }) => {
      const db = getDb();

      const [membership] = await db.select()
        .from(teamMembers)
        .where(and(
          eq(teamMembers.teamId, input.teamId),
          eq(teamMembers.userId, ctx.user.id),
        ))
        .limit(1);
      if (!membership) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Not a member of this team" });
      }

      const [seatRow] = await db.select()
        .from(teamSeats)
        .where(eq(teamSeats.teamId, input.teamId))
        .limit(1);

      const [countRow] = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(teamMembers)
        .where(eq(teamMembers.teamId, input.teamId));

      return {
        seats: seatRow?.seats ?? Math.max(1, Number(countRow?.count ?? 0)),
        hasActiveSubscription: Boolean(seatRow?.stripeSubscriptionId),
      };
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
