// ═══════════════════════════════════════════════════════════════════
//  BILLING SERVICE — Stripe Checkout + webhook processing (F0.7)
// ═══════════════════════════════════════════════════════════════════
// Everything degrades cleanly when Stripe env vars are absent: isBillingConfigured()
// returns false and routes respond 503 "billing not configured".

import Stripe from "stripe";
import { getDb } from "../queries/connection";
import { subscriptions, idempotencyKeys } from "@db/schema";
import { eq } from "drizzle-orm";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { PLANS, type PlanId } from "../config/plans";
import * as entitlementService from "./entitlements";
import { fulfillMarketplacePurchase, revokeMarketplacePurchase } from "./entitlementSync";
import { recordPromotionRedemption } from "./promotionService";

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
  /** Free days from an admin-defined promotion (see promotionService). The
   *  price is untouched — this is a trial, so billing continues on the same
   *  price id and there is no discounted amount to reconcile. */
  trialPeriodDays?: number;
  promotionId?: number;
  promotionSource?: "signup" | "code";
}): Promise<{ url: string }> {
  const client = getStripe();
  if (!client) throw new BillingNotConfiguredError();

  const plan = PLANS[opts.plan];
  if (!plan || !plan.priceId) {
    throw new Error(`Plan "${opts.plan}" is not available`);
  }

  const trial = opts.trialPeriodDays && opts.trialPeriodDays > 0 ? opts.trialPeriodDays : undefined;
  // Carried on the session so the webhook records exactly the grant that was
  // offered. If the promotion is edited while this session is open, the buyer
  // still gets what the session said — so that is what the ledger records.
  const metadata: Record<string, string> = {
    userId: String(opts.userId),
    plan: plan.id,
  };
  if (opts.promotionId) {
    metadata.promotionId = String(opts.promotionId);
    metadata.promotionDays = String(trial ?? 0);
    metadata.promotionSource = opts.promotionSource ?? "code";
  }

  const session = await client.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: plan.priceId, quantity: 1 }],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    client_reference_id: String(opts.userId),
    metadata,
    subscription_data: {
      metadata,
      ...(trial ? { trial_period_days: trial } : {}),
    },
  });

  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  logger.info("Checkout session created", {
    userId: opts.userId,
    plan: plan.id,
    trialPeriodDays: trial ?? 0,
    promotionId: opts.promotionId ?? null,
  });
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

// ─── Team seats: retired, events ignored ────────────────────────────
// Team features and per-seat checkout were removed (ticket #26). A team-seat
// subscription bought before that change can still be LIVE and keep sending
// Stripe events, so those events must be handled rather than throw.
//
// They are now claimed and IGNORED. `team:sync` gated no capability at all, so
// the entitlement it granted bought nothing, and writing `team_seats` again
// would keep a retired product alive in the money ledger. Ignoring is also what
// stops a legacy event falling through to the generic branch below, which would
// record a team subscription as an individual plan and grant individual
// entitlements for it. The tables stay exactly as they are — no drop, no
// rewrite of history.
function ignoreTeamSeatEvent(eventId: string, type: string): void {
  logger.info("Ignoring Stripe event for the retired team-seat product", { eventId, type });
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

      // ─── Team seat subscription (retired product) ─────────────────
      if (session.metadata?.type === "team_seats") {
        ignoreTeamSeatEvent(event.id, "checkout.session.completed");
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

      // Record the free-days grant ONLY now that a subscription exists. A
      // Checkout Session the buyer abandons must not take a place in a capped
      // promotion, which is why eligibility is read-only and the write lives
      // here. `claimEvent` already dedupes the delivery, and
      // recordPromotionRedemption is idempotent per (user, promotion) on top of
      // that — a retried event cannot double-count.
      const promotionId = parseInt(session.metadata?.promotionId ?? "", 10);
      const promotionDays = parseInt(session.metadata?.promotionDays ?? "", 10);
      if (promotionId > 0 && promotionDays > 0) {
        await recordPromotionRedemption({
          userId,
          promotionId,
          days: promotionDays,
          source: session.metadata?.promotionSource === "signup" ? "signup" : "code",
        });
      } else if (session.metadata?.promotionId) {
        logger.warn("checkout.session.completed carried an unreadable promotion id", {
          eventId: event.id,
          promotionId: session.metadata.promotionId,
        });
      }
      break;
    }

    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;

      // ─── Team seat subscription (retired product) ─────────────────
      // Intercepted before the generic branch on purpose: letting it through
      // would record a team subscription as an individual plan.
      if (sub.metadata?.type === "team_seats") {
        ignoreTeamSeatEvent(event.id, "customer.subscription.updated");
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

      // ─── Team seat subscription (retired product) ───────────────
      // Deleting the row here would rewrite the history of a product we no
      // longer sell. A `team:sync` grant issued before the retirement stays
      // inert: no code reads that capability any more.
      if (sub.metadata?.type === "team_seats") {
        ignoreTeamSeatEvent(event.id, "customer.subscription.deleted");
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
