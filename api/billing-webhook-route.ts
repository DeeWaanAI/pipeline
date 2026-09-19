/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * BILLING WEBHOOK ROUTE (Raw HTTP POST)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * POST /api/billing/stripe-webhook
 *   Stripe signature verification over the RAW body, then idempotent event
 *   processing (subscriptions upsert + entitlement grant/revoke).
 *   Returns 503 when Stripe env vars are not configured.
 */

import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { handleStripeEvent, isBillingConfigured } from "./services/billingService";
import { env } from "./lib/env";
import { logger } from "./lib/logger";

export function registerBillingWebhookRoute(app: Hono<{ Bindings: HttpBindings }>) {
  app.post("/api/billing/stripe-webhook", async (c) => {
    // Both the API key and the webhook signing secret must be present.
    if (!isBillingConfigured() || !env.stripeWebhookSecret) {
      return c.json({ error: "billing not configured" }, 503);
    }

    const signature = c.req.header("stripe-signature");
    if (!signature) {
      return c.json({ error: "Missing stripe-signature header" }, 400);
    }

    // Signature verification requires the raw, unparsed body
    const rawBody = await c.req.text();

    try {
      const result = await handleStripeEvent(rawBody, signature);
      return c.json(result, 200);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === "Invalid webhook signature") {
        return c.json({ error: "Invalid signature" }, 400);
      }
      if (msg === "billing not configured") {
        return c.json({ error: "billing not configured" }, 503);
      }
      // Never leak internals to Stripe / the network
      logger.error("Stripe webhook processing failed", { error: msg });
      return c.json({ error: "Webhook processing failed" }, 500);
    }
  });
}
