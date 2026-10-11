// What this pins: a Stripe event for the retired team-seat product (ticket #26)
// must be claimed and dropped. Two ways this fails silently:
//   1. the handler throws and Stripe retries the event forever, or
//   2. it falls through to the generic branch, recording a team subscription as
//      an individual plan and granting individual entitlements for money that
//      bought something we no longer sell.
// The Stripe SDK and the database are faked here; entitlements.integration.test.ts
// covers the real grant/revoke against a database.

import { describe, expect, it, vi } from "vitest";
import { idempotencyKeys, promotionRedemptions, subscriptions, teamSeats, teams } from "@db/schema";

const ops: { op: string; table: unknown }[] = [];
/** Every payload the fake Stripe SDK was asked to send. */
const checkoutPayloads: any[] = [];

function chainable(present: unknown[] = []) {
  const node: any = () => node;
  node.from = (table: unknown) => { ops.push({ op: "select.from", table }); return node; };
  node.where = () => node;
  node.limit = () => Promise.resolve(present);
  node.values = () => Promise.resolve(undefined);
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

const grant = vi.fn();
const revoke = vi.fn();
vi.mock("./entitlements", () => ({
  grant,
  revoke,
  getActiveEntitlements: vi.fn(async () => []),
}));
vi.mock("./entitlementSync", () => ({
  fulfillMarketplacePurchase: vi.fn(),
  revokeMarketplacePurchase: vi.fn(),
}));

// The grant is written by promotionService against real tables; that path is
// covered in promotionService.integration.test.ts. Here the question is only
// whether the webhook calls it, with what, and when it must not.
const recordPromotionRedemption = vi.fn(async () => {});
vi.mock("./promotionService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./promotionService")>();
  return { ...actual, recordPromotionRedemption };
});

vi.mock("../lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/env")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      stripeSecretKey: "sk_test_pinned",
      stripeWebhookSecret: "whsec_pinned",
      stripePriceSolo: "price_test_pinned",
    },
  };
});

const { handleStripeEvent, createCheckoutSession } = await import("./billingService");

async function deliver(event: Record<string, unknown>) {
  ops.length = 0;
  checkoutPayloads.length = 0;
  grant.mockClear();
  revoke.mockClear();
  recordPromotionRedemption.mockClear();
  await handleStripeEvent(JSON.stringify(event), "signature-not-checked-in-this-stub");
}

const teamSeatEvents = [
  {
    id: "evt_team_checkout",
    type: "checkout.session.completed",
    data: { object: { id: "cs_test_1", metadata: { type: "team_seats", teamId: "7" }, subscription: "sub_test_1" } },
  },
  {
    id: "evt_team_updated",
    type: "customer.subscription.updated",
    data: { object: { id: "sub_test_1", status: "active", metadata: { type: "team_seats", teamId: "7", userId: "9" }, items: { data: [{ quantity: 5 }] } } },
  },
  {
    id: "evt_team_deleted",
    type: "customer.subscription.deleted",
    data: { object: { id: "sub_test_1", status: "canceled", metadata: { type: "team_seats", teamId: "7", userId: "9" }, items: { data: [] } } },
  },
];

describe("the retired team-seat product", () => {
  it.each(teamSeatEvents)("$type is claimed and dropped", async (event) => {
    await deliver(event as unknown as Record<string, unknown>);

    // Claimed: the event id was written to the idempotency ledger, so the
    // handler got past the guard instead of short-circuiting as a duplicate.
    expect(ops).toContainEqual({ op: "insert", table: idempotencyKeys });

    // Dropped: nothing was written for the team product, no plan row was
    // upserted, and the entitlement ledger was not touched.
    expect(ops).not.toContainEqual({ op: "insert", table: teamSeats });
    expect(ops).not.toContainEqual({ op: "update", table: teamSeats });
    expect(ops).not.toContainEqual({ op: "delete", table: teamSeats });
    expect(ops.some((o) => o.table === teams)).toBe(false);
    expect(ops).not.toContainEqual({ op: "insert", table: subscriptions });
    expect(ops).not.toContainEqual({ op: "update", table: subscriptions });
    expect(grant).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("still processes an individual subscription, so the assertions above are not just a deaf harness", async () => {
    await deliver({
      id: "evt_individual",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_test_2", status: "canceled", metadata: { userId: "42", plan: "solo" },
          customer: "cus_test_2", items: { data: [{ quantity: 1, current_period_end: 1767225600 }] },
        },
      },
    });

    expect(ops.some((o) => o.table === subscriptions)).toBe(true);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(grant).not.toHaveBeenCalled(); // an active plan grants nothing; a lapse only revokes
  });
});

// A promotion is a TRIAL, not a discount: the price id stays the single flat
// price and Stripe stops billing until the days run out. These pin that the
// grant reaches the API call, and that the redemption is booked only when a
// subscription actually exists.
describe("a free-days promotion at checkout", () => {
  const promotionSession = {
    id: "evt_promo_checkout",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_promo",
        object: "checkout.session",
        mode: "subscription",
        customer: "cus_promo",
        subscription: "sub_promo",
        metadata: { userId: "42", plan: "solo", promotionId: "7", promotionDays: "7", promotionSource: "signup" },
      },
    },
  };

  it("sends the trial days and carries the grant through to the webhook", async () => {
    await createCheckoutSession({
      userId: 42,
      plan: "solo",
      successUrl: "https://app.test/settings?checkout=success",
      cancelUrl: "https://app.test/settings?checkout=cancel",
      trialPeriodDays: 7,
      promotionId: 7,
      promotionSource: "signup",
    });

    const payload = checkoutPayloads.at(-1);
    expect(payload.mode).toBe("subscription");
    expect(payload.line_items).toEqual([{ price: "price_test_pinned", quantity: 1 }]);
    expect(payload.subscription_data.trial_period_days).toBe(7);
    expect(payload.metadata).toMatchObject({ promotionId: "7", promotionDays: "7", promotionSource: "signup" });
    expect(payload.subscription_data.metadata).toMatchObject({ promotionId: "7" });
  });

  it("sends no trial at all when the account has no grant", async () => {
    await createCheckoutSession({
      userId: 43,
      plan: "solo",
      successUrl: "https://app.test/ok",
      cancelUrl: "https://app.test/no",
    });

    const payload = checkoutPayloads.at(-1);
    expect("trial_period_days" in payload.subscription_data).toBe(false);
    expect(payload.metadata.promotionId).toBeUndefined();
  });

  it("books the redemption when the subscription actually completes", async () => {
    await deliver(promotionSession);

    expect(recordPromotionRedemption).toHaveBeenCalledTimes(1);
    expect(recordPromotionRedemption).toHaveBeenCalledWith({
      userId: 42, promotionId: 7, days: 7, source: "signup",
    });
  });

  it("books nothing for an ordinary signup, or for metadata it cannot read", async () => {
    await deliver({
      id: "evt_plain_checkout",
      type: "checkout.session.completed",
      data: { object: { id: "cs_plain", metadata: { userId: "44", plan: "solo" }, subscription: "sub_plain", customer: "cus_plain" } },
    });
    expect(recordPromotionRedemption).not.toHaveBeenCalled();

    // A promotion id that is not a number must not become a silent grant of
    // zero days, and must not break the rest of the webhook either.
    await deliver({
      id: "evt_bad_promo_meta",
      type: "checkout.session.completed",
      data: { object: { id: "cs_bad", metadata: { userId: "45", plan: "solo", promotionId: "seven" }, subscription: "sub_bad", customer: "cus_bad" } },
    });
    expect(recordPromotionRedemption).not.toHaveBeenCalled();
    expect(ops.some((o) => o.table === subscriptions)).toBe(true);
  });
});
