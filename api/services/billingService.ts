// ═══════════════════════════════════════════════════════════════════
//  BILLING SERVICE — Stripe Checkout + webhook processing (F0.7)
// ═══════════════════════════════════════════════════════════════════
// Everything degrades cleanly when Stripe env vars are absent: isBillingConfigured()
// returns false and routes respond 503 "billing not configured".

import Stripe from "stripe";
import { getDb } from "../queries/connection";
import { subscriptions, idempotencyKeys, teamSeats, teams } from "@db/schema";
import { eq } from "drizzle-orm";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { PLANS, type PlanId } from "../config/plans";
import * as entitlementService from "./entitlements";
import { fulfillMarketplacePurchase, revokeMarketplacePurchase } from "./entitlementSync";

let stripe: Stripe | null = null;

export function isBillingConfigured(): boolean {
  return env.stripeSecretKey.length > 0;
}

function getStripe(): Stripe | null {
  if (!isBillingConfigured()) return null;
  if (!stripe) {
    stripe = new Stripe(env.stripeSecretKey);
  }
  return stripe;
}

export class BillingNotConfiguredError extends Error {
  constructor() {
    super("billing not configured");
    this.name = "BillingNotConfiguredError";
  }
}

// ─── Checkout ───────────────────────────────────────────────────────
// One flat per-account subscription: quantity is always 1 and no seat
// counting happens on this side any more.
export async function createCheckoutSession(opts: {
  userId: number;
  plan: PlanId;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string }> {
  const client = getStripe();
  if (!client) throw new BillingNotConfiguredError();

  const plan = PLANS[opts.plan];
  if (!plan || !plan.priceId) {
    throw new Error(`Plan "${opts.plan}" is not available`);
  }

  const session = await client.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: plan.priceId, quantity: 1 }],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    client_reference_id: String(opts.userId),
    metadata: {
      userId: String(opts.userId),
      plan: plan.id,
    },
    subscription_data: {
      metadata: {
        userId: String(opts.userId),
        plan: plan.id,
      },
    },
  });

  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  logger.info("Checkout session created", { userId: opts.userId, plan: plan.id });
  return { url: session.url };
}

// ─── Marketplace one-time purchase checkout (Phase 1) ───────────────
export async function createMarketplaceCheckoutSession(opts: {
  userId: number;
  listingId: number;
  title: string;
  amountCents: number;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string }> {
  const client = getStripe();
  if (!client) throw new BillingNotConfiguredError();

  const session = await client.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: { name: opts.title },
          unit_amount: opts.amountCents,
        },
        quantity: 1,
      },
    ],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    client_reference_id: String(opts.userId),
    metadata: {
      type: "marketplace_purchase",
      userId: String(opts.userId),
      listingId: String(opts.listingId),
    },
    // PI metadata travels to the charge so refunds can be matched.
    payment_intent_data: {
      metadata: {
        type: "marketplace_purchase",
        userId: String(opts.userId),
        listingId: String(opts.listingId),
      },
    },
  });

  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  logger.info("Marketplace checkout session created", {
    userId: opts.userId,
    listingId: opts.listingId,
    amountCents: opts.amountCents,
  });
  return { url: session.url };
}

// ─── Idempotent event processing ────────────────────────────────────
// Drizzle wraps mysql2 errors — the ER_DUP_ENTRY code lives on `.cause`
// (and the top-level message becomes "Failed query: ..."), so check both
// levels. Missing this made every duplicate Stripe delivery a 500.
function isDuplicateKeyError(err: unknown): boolean {
  const e = err as { message?: string; code?: string; cause?: { message?: string; code?: string } };
  return (
    e?.code === "ER_DUP_ENTRY" ||
    e?.cause?.code === "ER_DUP_ENTRY" ||
    !!e?.message?.includes("Duplicate") ||
    !!e?.cause?.message?.includes("Duplicate")
  );
}

async function claimEvent(eventId: string): Promise<boolean> {
  const db = getDb();
  try {
    await db.insert(idempotencyKeys).values({
      key: `stripe:${eventId}`,
      scope: "stripe-webhook",
    });
    return true;
  } catch (err) {
    // Duplicate key → already processed
    if (isDuplicateKeyError(err)) {
      return false;
    }
    throw err;
  }
}

// ─── Subscription upsert + entitlement sync ─────────────────────────
function periodEndFromSubscription(sub: Stripe.Subscription): Date | null {
  const item = sub.items?.data?.[0];
  const ts = item?.current_period_end;
  return ts ? new Date(ts * 1000) : null;
}

/**
 * Reconcile the entitlement rows a subscription wrote.
 *
 * A plan no longer grants any capability (there is no plan ladder — one flat
 * subscription buys the whole product, see api/config/plans.ts), so an active
 * subscription adds nothing here. The revoke arm stays: `entitlements` rows
 * with source="subscription" from before this change are still real rows, and
 * they must be cleaned up when a live subscription lapses or is canceled.
 */
async function syncSubscriptionEntitlements(opts: {
  userId: number;
  plan: string;
  status: string;
  sourceRef: string;
}): Promise<void> {
  const active = opts.status === "active" || opts.status === "trialing";
  if (active) return;

  await entitlementService.revoke({
    subjectType: "user",
    subjectId: opts.userId,
    source: "subscription",
    sourceRef: opts.sourceRef,
  });
}

async function upsertSubscription(opts: {
  userId: number;
  plan: string;
  status: string;
  stripeCustomerId?: string | null;
  stripeSubscriptionId: string;
  seats: number;
  currentPeriodEnd: Date | null;
}): Promise<void> {
  const db = getDb();
  const [existing] = await db.select()
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, opts.stripeSubscriptionId))
    .limit(1);

  if (existing) {
    await db.update(subscriptions)
      .set({
        plan: opts.plan,
        status: opts.status,
        seats: opts.seats,
        currentPeriodEnd: opts.currentPeriodEnd,
      })
      .where(eq(subscriptions.id, existing.id));
  } else {
    await db.insert(subscriptions).values({
      userId: opts.userId,
      plan: opts.plan,
      status: opts.status,
      stripeCustomerId: opts.stripeCustomerId ?? null,
      stripeSubscriptionId: opts.stripeSubscriptionId,
      seats: opts.seats,
      currentPeriodEnd: opts.currentPeriodEnd,
    });
  }
}

// ─── Team seat helpers — RECONCILIATION ONLY ────────────────────────
// Team features and per-seat checkout were removed (ticket #26), but a
// team-seat subscription bought before that change can still be LIVE, so its
// Stripe events must keep being recorded instead of throwing. Nothing new can
// be purchased on this path. `team:sync` gates no capability any more; the
// grant/revoke below just keeps the entitlement ledger honest about what the
// subscription paid for.
// Capability the team owner holds while a team seat subscription is active.
const TEAM_SYNC_CAPABILITY = "team:sync";

/** Upsert the single team_seats row for a team (team_id is UNIQUE). */
async function upsertTeamSeats(opts: {
  teamId: number;
  seats: number;
  stripeSubscriptionId: string;
  stripeSubscriptionItemId: string | null;
}): Promise<void> {
  const db = getDb();
  const [existing] = await db.select()
    .from(teamSeats)
    .where(eq(teamSeats.teamId, opts.teamId))
    .limit(1);

  if (existing) {
    if (
      existing.seats === opts.seats &&
      existing.stripeSubscriptionId === opts.stripeSubscriptionId &&
      existing.stripeSubscriptionItemId === opts.stripeSubscriptionItemId
    ) {
      logger.info("Team seats already up to date — skipping", { teamId: opts.teamId });
      return;
    }
    await db.update(teamSeats)
      .set({
        seats: opts.seats,
        stripeSubscriptionId: opts.stripeSubscriptionId,
        stripeSubscriptionItemId: opts.stripeSubscriptionItemId,
      })
      .where(eq(teamSeats.teamId, opts.teamId));
  } else {
    await db.insert(teamSeats).values({
      teamId: opts.teamId,
      seats: opts.seats,
      stripeSubscriptionId: opts.stripeSubscriptionId,
      stripeSubscriptionItemId: opts.stripeSubscriptionItemId,
    });
  }
}

/**
 * Grant/revoke the owner's team:sync capability for a team seat
 * subscription. Idempotent: re-granting the same sourceRef is a no-op
 * (mirrors syncSubscriptionEntitlements).
 */
async function syncTeamSyncEntitlement(opts: {
  ownerId: number;
  active: boolean;
  sourceRef: string;
}): Promise<void> {
  if (opts.active) {
    const existing = await entitlementService.getActiveEntitlements("user", opts.ownerId);
    if (existing.some((e) => e.capability === TEAM_SYNC_CAPABILITY && e.sourceRef === opts.sourceRef)) return;
    await entitlementService.grant({
      subjectType: "user",
      subjectId: opts.ownerId,
      capability: TEAM_SYNC_CAPABILITY,
      source: "subscription",
      sourceRef: opts.sourceRef,
    });
  } else {
    await entitlementService.revoke({
      subjectType: "user",
      subjectId: opts.ownerId,
      capability: TEAM_SYNC_CAPABILITY,
      source: "subscription",
      sourceRef: opts.sourceRef,
    });
  }
}

// ─── Webhook entry point ────────────────────────────────────────────
export async function handleStripeEvent(rawBody: string, signature: string): Promise<{ received: true; duplicate?: boolean }> {
  const client = getStripe();
  if (!client || !env.stripeWebhookSecret) throw new BillingNotConfiguredError();

  let event: Stripe.Event;
  try {
    event = client.webhooks.constructEvent(rawBody, signature, env.stripeWebhookSecret);
  } catch (err) {
    logger.warn("Stripe webhook signature verification failed", { error: (err as Error).message });
    throw new Error("Invalid webhook signature");
  }

  const firstTime = await claimEvent(event.id);
  if (!firstTime) {
    logger.debug("Stripe event already processed — skipping", { eventId: event.id, type: event.type });
    return { received: true, duplicate: true };
  }

  logger.info("Stripe event received", { eventId: event.id, type: event.type });

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;

      // ─── Marketplace one-time purchase (Phase 1) ────────────────
      if (session.metadata?.type === "marketplace_purchase") {
        const userId = parseInt(session.metadata?.userId ?? "", 10);
        const listingId = parseInt(session.metadata?.listingId ?? "", 10);
        const amountCents = session.amount_total ?? 0;
        if (!userId || !listingId || amountCents <= 0) {
          logger.warn("marketplace checkout.session.completed missing metadata", { eventId: event.id });
          break;
        }
        await fulfillMarketplacePurchase({
          userId,
          listingId,
          amountPaid: amountCents / 100,
          stripeSessionId: session.id,
          stripePaymentIntentId:
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : session.payment_intent?.id ?? null,
        });
        break;
      }

      // ─── Team seat subscription (Phase 2 TeamSync) ──────────────
      if (session.metadata?.type === "team_seats") {
        const teamId = parseInt(session.metadata?.teamId ?? "", 10);
        const stripeSubscriptionId = typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id;
        if (!teamId || Number.isNaN(teamId) || !stripeSubscriptionId) {
          logger.warn("team_seats checkout.session.completed missing metadata", { eventId: event.id });
          break;
        }
        const subscription = await client.subscriptions.retrieve(stripeSubscriptionId);
        const item = subscription.items?.data?.[0];
        await upsertTeamSeats({
          teamId,
          seats: item?.quantity ?? 1,
          stripeSubscriptionId,
          stripeSubscriptionItemId: item?.id ?? null,
        });
        // Grant the owner team:sync while the subscription is active.
        const db = getDb();
        const [team] = await db.select({ ownerId: teams.ownerId })
          .from(teams)
          .where(eq(teams.id, teamId))
          .limit(1);
        if (team) {
          await syncTeamSyncEntitlement({ ownerId: team.ownerId, active: true, sourceRef: stripeSubscriptionId });
        } else {
          logger.warn("team_seats checkout for unknown team", { eventId: event.id, teamId });
        }
        break;
      }

      const userId = parseInt(session.metadata?.userId ?? session.client_reference_id ?? "", 10);
      const plan = session.metadata?.plan ?? "solo";
      const seats = parseInt(session.metadata?.seats ?? "1", 10) || 1;
      const stripeSubscriptionId = typeof session.subscription === "string"
        ? session.subscription
        : session.subscription?.id;
      if (!userId || Number.isNaN(userId) || !stripeSubscriptionId) {
        logger.warn("checkout.session.completed missing userId or subscription", { eventId: event.id });
        break;
      }
      await upsertSubscription({
        userId,
        plan,
        status: "active",
        stripeCustomerId: typeof session.customer === "string" ? session.customer : session.customer?.id ?? null,
        stripeSubscriptionId,
        seats,
        currentPeriodEnd: null, // filled in by subscription.updated
      });
      await syncSubscriptionEntitlements({ userId, plan, status: "active", sourceRef: stripeSubscriptionId });
      break;
    }

    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;

      // ─── Team seat subscription (Phase 2 TeamSync) ──────────────
      // Intercept before the generic branch so team subscriptions never
      // land in the user-level `subscriptions` table.
      if (sub.metadata?.type === "team_seats") {
        const teamId = parseInt(sub.metadata?.teamId ?? "", 10);
        if (!teamId || Number.isNaN(teamId)) {
          logger.warn("team_seats subscription.updated missing teamId", { eventId: event.id });
          break;
        }
        const db = getDb();
        const item = sub.items?.data?.[0];
        const [seatRow] = await db.select()
          .from(teamSeats)
          .where(eq(teamSeats.teamId, teamId))
          .limit(1);
        if (seatRow && item?.quantity && seatRow.seats !== item.quantity) {
          await db.update(teamSeats)
            .set({ seats: item.quantity })
            .where(eq(teamSeats.teamId, teamId));
        }
        const [team] = await db.select({ ownerId: teams.ownerId })
          .from(teams)
          .where(eq(teams.id, teamId))
          .limit(1);
        if (team) {
          const active = sub.status === "active" || sub.status === "trialing";
          await syncTeamSyncEntitlement({ ownerId: team.ownerId, active, sourceRef: sub.id });
        }
        break;
      }

      const userId = parseInt(sub.metadata?.userId ?? "", 10);
      if (!userId || Number.isNaN(userId)) {
        logger.warn("subscription.updated missing userId metadata", { eventId: event.id });
        break;
      }
      const plan = sub.metadata?.plan ?? "solo";
      const seats = sub.items?.data?.[0]?.quantity ?? parseInt(sub.metadata?.seats ?? "1", 10) ?? 1;
      await upsertSubscription({
        userId,
        plan,
        status: sub.status,
        stripeCustomerId: typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null,
        stripeSubscriptionId: sub.id,
        seats,
        currentPeriodEnd: periodEndFromSubscription(sub),
      });
      await syncSubscriptionEntitlements({ userId, plan, status: sub.status, sourceRef: sub.id });
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;

      // ─── Team seat subscription (Phase 2 TeamSync) ──────────────
      if (sub.metadata?.type === "team_seats") {
        const db = getDb();
        // The team_seats row is the canonical link; metadata teamId is a fallback.
        const [seatRow] = await db.select()
          .from(teamSeats)
          .where(eq(teamSeats.stripeSubscriptionId, sub.id))
          .limit(1);
        const metaTeamId = parseInt(sub.metadata?.teamId ?? "", 10);
        const resolvedTeamId = seatRow?.teamId ?? (Number.isNaN(metaTeamId) ? null : metaTeamId);
        if (seatRow) {
          // No status column on team_seats — removal IS deactivation.
          await db.delete(teamSeats).where(eq(teamSeats.id, seatRow.id));
        }
        if (resolvedTeamId) {
          const [team] = await db.select({ ownerId: teams.ownerId })
            .from(teams)
            .where(eq(teams.id, resolvedTeamId))
            .limit(1);
          if (team) {
            await syncTeamSyncEntitlement({ ownerId: team.ownerId, active: false, sourceRef: sub.id });
          }
        } else {
          logger.warn("team_seats subscription.deleted with no matching team", { eventId: event.id });
        }
        break;
      }

      const userId = parseInt(sub.metadata?.userId ?? "", 10);
      if (!userId || Number.isNaN(userId)) {
        logger.warn("subscription.deleted missing userId metadata", { eventId: event.id });
        break;
      }
      const plan = sub.metadata?.plan ?? "solo";
      await upsertSubscription({
        userId,
        plan,
        status: "canceled",
        stripeCustomerId: typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null,
        stripeSubscriptionId: sub.id,
        seats: sub.items?.data?.[0]?.quantity ?? 1,
        currentPeriodEnd: periodEndFromSubscription(sub),
      });
      await syncSubscriptionEntitlements({ userId, plan, status: "canceled", sourceRef: sub.id });
      break;
    }

    case "charge.refunded": {
      // Marketplace refund → revoke purchase + entitlement (Phase 1).
      // Matched by payment intent, which we stored at fulfillment.
      const charge = event.data.object as Stripe.Charge;
      const paymentIntentId =
        typeof charge.payment_intent === "string"
          ? charge.payment_intent
          : charge.payment_intent?.id;
      if (!paymentIntentId) {
        logger.warn("charge.refunded without payment_intent", { eventId: event.id });
        break;
      }
      await revokeMarketplacePurchase({ stripePaymentIntentId: paymentIntentId });
      break;
    }

    default:
      logger.debug("Stripe event type not handled", { type: event.type });
  }

  return { received: true };
}
