// ═══════════════════════════════════════════════════════════════════
//  BILLING SERVICE — Stripe Checkout + webhook processing (F0.7)
// ═══════════════════════════════════════════════════════════════════
// Everything degrades cleanly when Stripe env vars are absent: isBillingConfigured()
// returns false and routes respond 503 "billing not configured".
//
// Subscription billing is gone (no subscription exists as a product). The only
// money that moves is a one-time marketplace purchase: its Checkout session is
// created here, and the webhook fulfils it (or revokes it on refund) through
// entitlementSync. Legacy Stripe events for the retired solo plan and team-seat
// products are still CLAIMED (so Stripe stops retrying) but no longer write any
// subscription row or entitlement.

import Stripe from "stripe";
import { getDb } from "../queries/connection";
import { idempotencyKeys } from "@db/schema";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
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

      // Any other completed checkout belongs to the retired solo-plan or
      // team-seat subscription products. Claimed above (so Stripe stops
      // retrying) and ignored: there is no subscription to reconcile and no
      // entitlement a plan grants.
      logger.info("Ignoring checkout.session.completed for a retired subscription product", {
        eventId: event.id,
        type: session.metadata?.type ?? "subscription",
      });
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
