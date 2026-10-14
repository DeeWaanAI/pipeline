// What this pins: the webhook's ONLY money paths are the marketplace purchase
// (checkout.session.completed with metadata.type === "marketplace_purchase" →
// fulfillMarketplacePurchase) and its refund (charge.refunded →
// revokeMarketplacePurchase). Subscription billing was removed with the solo
// plan: legacy subscription events must still be CLAIMED (so Stripe stops
// retrying) but must never write a subscription row or touch entitlements.
// The Stripe SDK and the database are faked here; entitlements.integration.test.ts
// covers the real grant/revoke against a database.

import { describe, expect, it, vi } from "vitest";
import { idempotencyKeys, subscriptions, teamSeats, teams } from "@db/schema";

const ops: { op: string; table: unknown }[] = [];
/** Every payload the fake Stripe SDK was asked to send. */
const checkoutPayloads: any[] = [];
/** When true, the next idempotency insert fails as a duplicate. */
let duplicateNext = false;

function chainable(present: unknown[] = []) {
  const node: any = () => node;
  node.from = (table: unknown) => { ops.push({ op: "select.from", table }); return node; };
  node.where = () => node;
  node.limit = () => Promise.resolve(present);
  node.values = () => {
    if (duplicateNext) {
      duplicateNext = false;
      return Promise.reject({ code: "ER_DUP_ENTRY", message: "Duplicate entry" });
    }
    return Promise.resolve(undefined);
  };
  node.set = () => node;
  return node;
}

vi.mock("../queries/connection", () => ({
  getDb: () => ({
    select: () => chainable(),
    insert: (table: unknown) => { ops.push({ op: "insert", table }); return chainable(); },
    update: (table: unknown) => { ops.push({ op: "update", table }); return chainable(); },
    delete: (table: unknown) => { ops.push({ op: "delete", table }); return chainable(); },
  }),
}));

// constructEvent verifies a real HMAC we cannot produce without the account's
// signing secret, so the stub trusts the body — this file tests the branch the
// event takes and the payload the SDK is handed, not Stripe's signature check.
vi.mock("stripe", () => ({
  default: class FakeStripe {
    webhooks = { constructEvent: (raw: string) => JSON.parse(raw) };
    checkout = { sessions: { create: async (payload: any) => { checkoutPayloads.push(payload); return { url: "https://checkout.stripe.test/session" }; } } };
  },
}));

const fulfillMarketplacePurchase = vi.fn(async () => {});
const revokeMarketplacePurchase = vi.fn(async () => {});
vi.mock("./entitlementSync", () => ({
  fulfillMarketplacePurchase,
  revokeMarketplacePurchase,
  purchaseCapability: (listingId: number) => `pipeline:run:${listingId}`,
}));

vi.mock("../lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/env")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      stripeSecretKey: "sk_test_pinned",
      stripeWebhookSecret: "whsec_pinned",
    },
  };
});

const { handleStripeEvent, createMarketplaceCheckoutSession } = await import("./billingService");

async function deliver(event: Record<string, unknown>) {
  ops.length = 0;
  checkoutPayloads.length = 0;
  fulfillMarketplacePurchase.mockClear();
  revokeMarketplacePurchase.mockClear();
  return handleStripeEvent(JSON.stringify(event), "signature-not-checked-in-this-stub");
}

const marketplaceSession = {
  id: "evt_marketplace_checkout",
  type: "checkout.session.completed",
  data: {
    object: {
      id: "cs_test_market",
      object: "checkout.session",
      mode: "payment",
      amount_total: 499,
      payment_intent: "pi_test_1",
      metadata: { type: "marketplace_purchase", userId: "42", listingId: "7" },
    },
  },
};

describe("the marketplace purchase path", () => {
  it("fulfils a completed marketplace checkout from its metadata", async () => {
    await deliver(marketplaceSession);

    // Claimed: the event id was written to the idempotency ledger.
    expect(ops).toContainEqual({ op: "insert", table: idempotencyKeys });
    expect(fulfillMarketplacePurchase).toHaveBeenCalledTimes(1);
    expect(fulfillMarketplacePurchase).toHaveBeenCalledWith({
      userId: 42,
      listingId: 7,
      amountPaid: 4.99,
      stripeSessionId: "cs_test_market",
      stripePaymentIntentId: "pi_test_1",
    });
  });

  it("does not fulfil on a duplicate delivery", async () => {
    duplicateNext = true;
    const result = await deliver(marketplaceSession);
    expect(result).toMatchObject({ received: true, duplicate: true });
    expect(fulfillMarketplacePurchase).not.toHaveBeenCalled();
  });

  it("claims but does not fulfil a marketplace session with unreadable metadata", async () => {
    await deliver({
      id: "evt_bad_marketplace",
      type: "checkout.session.completed",
      data: { object: { id: "cs_bad", amount_total: 499, metadata: { type: "marketplace_purchase", userId: "x", listingId: "7" } } },
    });
    expect(ops).toContainEqual({ op: "insert", table: idempotencyKeys });
    expect(fulfillMarketplacePurchase).not.toHaveBeenCalled();
  });

  it("revokes the purchase when the charge is refunded", async () => {
    await deliver({
      id: "evt_refund",
      type: "charge.refunded",
      data: { object: { id: "ch_test_1", payment_intent: "pi_test_1" } },
    });
    expect(revokeMarketplacePurchase).toHaveBeenCalledTimes(1);
    expect(revokeMarketplacePurchase).toHaveBeenCalledWith({ stripePaymentIntentId: "pi_test_1" });
  });

  it("creates a payment-mode session carrying marketplace metadata to the charge", async () => {
    const { url } = await createMarketplaceCheckoutSession({
      userId: 42,
      listingId: 7,
      title: "Contract Redliner",
      amountCents: 499,
      successUrl: "https://app.test/marketplace/7?checkout=success",
      cancelUrl: "https://app.test/marketplace/7?checkout=cancel",
    });
    expect(url).toBe("https://checkout.stripe.test/session");

    const payload = checkoutPayloads.at(-1);
    expect(payload.mode).toBe("payment");
    expect(payload.line_items).toEqual([{
      price_data: { currency: "usd", product_data: { name: "Contract Redliner" }, unit_amount: 499 },
      quantity: 1,
    }]);
    expect(payload.metadata).toMatchObject({ type: "marketplace_purchase", userId: "42", listingId: "7" });
    expect(payload.payment_intent_data.metadata).toMatchObject({ type: "marketplace_purchase", listingId: "7" });
  });
});

describe("retired subscription products stay retired", () => {
  const legacyEvents = [
    {
      id: "evt_solo_checkout",
      type: "checkout.session.completed",
      data: { object: { id: "cs_solo", metadata: { userId: "44", plan: "solo" }, subscription: "sub_solo", customer: "cus_solo" } },
    },
    {
      id: "evt_team_checkout",
      type: "checkout.session.completed",
      data: { object: { id: "cs_team", metadata: { type: "team_seats", teamId: "7" }, subscription: "sub_team" } },
    },
    {
      id: "evt_sub_updated",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_test_2", status: "active", metadata: { userId: "42", plan: "solo" }, items: { data: [{ quantity: 1 }] } } },
    },
    {
      id: "evt_sub_deleted",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_test_2", status: "canceled", metadata: { userId: "42", plan: "solo" }, items: { data: [] } } },
    },
  ];

  it.each(legacyEvents)("$type is claimed and dropped — no subscription row, no entitlement write", async (event) => {
    await deliver(event as unknown as Record<string, unknown>);

    // Claimed: the handler got past the idempotency guard instead of
    // short-circuiting as a duplicate.
    expect(ops).toContainEqual({ op: "insert", table: idempotencyKeys });

    // Dropped: nothing was written for any subscription product, and the
    // marketplace money path was not touched.
    expect(ops).not.toContainEqual({ op: "insert", table: subscriptions });
    expect(ops).not.toContainEqual({ op: "update", table: subscriptions });
    expect(ops.some((o) => o.table === teamSeats)).toBe(false);
    expect(ops.some((o) => o.table === teams)).toBe(false);
    expect(fulfillMarketplacePurchase).not.toHaveBeenCalled();
    expect(revokeMarketplacePurchase).not.toHaveBeenCalled();
  });
});
