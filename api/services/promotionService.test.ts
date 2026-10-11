// Eligibility is the part of a promotion that touches money, and none of it
// needs a database or a Stripe account to get wrong. These pin the rules the
// admin UI will promise: who counts as a newcomer, what a code does, that a cap
// closes a grant, and that two live promotions never add up to a longer trial
// than either one.

import { describe, expect, it } from "vitest";
import { promotionEligible, pickPromotion, validatePromotion, type EligibilityContext, type PromotionCandidate } from "./promotionService";

const NOW = new Date("2026-11-01T12:00:00Z");
const SIGNUP = new Date("2026-10-25T09:00:00Z");

function promo(overrides: Partial<PromotionCandidate> = {}): PromotionCandidate {
  return {
    id: 1,
    days: 7,
    audience: "new_signups",
    code: null,
    startsAt: new Date("2026-10-01T00:00:00Z"),
    endsAt: new Date("2026-12-01T00:00:00Z"),
    maxRedemptions: null,
    active: true,
    ...overrides,
  };
}

function ctx(overrides: Partial<EligibilityContext> = {}): EligibilityContext {
  return {
    now: NOW,
    signupAt: SIGNUP,
    everSubscribed: false,
    redeemedPromotionIds: [],
    redemptionCounts: new Map(),
    requestedCode: null,
    ...overrides,
  };
}

describe("the newcomer promotion", () => {
  it("grants the days to an account that signed up inside the window", () => {
    expect(promotionEligible(promo(), ctx())).toBe("eligible");
    expect(pickPromotion([promo()], ctx())).toEqual({
      promotion: expect.objectContaining({ days: 7 }),
      source: "signup",
    });
  });

  it("refuses an account that has subscribed before, even a long-lapsed one", () => {
    expect(promotionEligible(promo(), ctx({ everSubscribed: true }))).toBe("not_new_signup");
    expect(pickPromotion([promo()], ctx({ everSubscribed: true }))).toBeNull();
  });

  it("refuses an account that joined before the promotion opened", () => {
    expect(promotionEligible(promo(), ctx({ signupAt: new Date("2026-09-13T00:00:00Z") })))
      .toBe("not_new_signup");
  });

  it("refuses after the window ends and before it starts", () => {
    expect(promotionEligible(promo(), ctx({ now: new Date("2026-12-02T00:00:00Z") }))).toBe("expired");
    expect(promotionEligible(promo({ startsAt: new Date("2026-11-05T00:00:00Z") }), ctx()))
      .toBe("not_started");
  });

  it("grants nothing once the account has already taken it", () => {
    expect(promotionEligible(promo(), ctx({ redeemedPromotionIds: [1] }))).toBe("already_redeemed");
  });

  it("closes on the cap, counting live redemptions", () => {
    const capped = promo({ maxRedemptions: 3 });
    expect(promotionEligible(capped, ctx({ redemptionCounts: new Map([[1, 2]]) }))).toBe("eligible");
    expect(promotionEligible(capped, ctx({ redemptionCounts: new Map([[1, 3]]) }))).toBe("sold_out");
  });

  it("grants nothing when the admin switched it off", () => {
    expect(promotionEligible(promo({ active: false }), ctx())).toBe("inactive");
  });

  it("treats an open-ended window as no window", () => {
    const open = promo({ startsAt: null, endsAt: null });
    expect(promotionEligible(open, ctx({ signupAt: new Date("2020-01-01T00:00:00Z") }))).toBe("eligible");
  });
});

describe("the code promotion", () => {
  const coded = promo({ id: 2, audience: "code", code: "LAUNCH-WEEK", days: 14 });

  it("needs the code typed", () => {
    expect(promotionEligible(coded, ctx())).toBe("code_required");
  });

  it("matches the code case- and space-insensitively", () => {
    expect(promotionEligible(coded, ctx({ requestedCode: "  launch-week " }))).toBe("eligible");
    expect(pickPromotion([coded], ctx({ requestedCode: "Launch-Week" }))?.promotion.id).toBe(2);
  });

  it("refuses a code that belongs to a different promotion", () => {
    expect(promotionEligible(coded, ctx({ requestedCode: "OTHER-CODE" }))).toBe("code_mismatch");
  });

  it("does not care when the account signed up — the code is the offer", () => {
    expect(promotionEligible(coded, ctx({
      signupAt: new Date("2021-03-04T00:00:00Z"),
      everSubscribed: true,
      requestedCode: "LAUNCH-WEEK",
    }))).toBe("eligible");
  });
});

describe("more than one promotion fits", () => {
  it("applies one grant, the longest, never the sum", () => {
    const short = promo({ id: 3, days: 7 });
    const long = promo({ id: 4, days: 30 });
    const picked = pickPromotion([short, long], ctx());
    expect(picked?.promotion.days).toBe(30);
    expect(picked?.promotion.id).toBe(4);
  });

  it("breaks a tie on the lower id so the answer does not depend on row order", () => {
    const a = promo({ id: 9, days: 7 });
    const b = promo({ id: 8, days: 7 });
    expect(pickPromotion([a, b], ctx())?.promotion.id).toBe(8);
    expect(pickPromotion([b, a], ctx())?.promotion.id).toBe(8);
  });

  it("returns null when nothing fits", () => {
    expect(pickPromotion([promo({ active: false }), promo({ id: 5, endsAt: new Date("2026-10-01T00:00:00Z") })], ctx()))
      .toBeNull();
  });
});

describe("what the admin may save", () => {
  const base: Parameters<typeof validatePromotion>[0] = {
    name: "Launch week", days: 7, audience: "new_signups", code: null,
    startsAt: null, endsAt: null, maxRedemptions: null, note: null,
  };

  it("accepts the newcomer offer as described", () => {
    expect(validatePromotion(base)).toBeNull();
  });

  it("rejects a name-less or nonsense-length grant", () => {
    expect(validatePromotion({ ...base, name: "  " })).toMatch(/name/i);
    expect(validatePromotion({ ...base, days: 0 })).toMatch(/between 1 and 365/);
    expect(validatePromotion({ ...base, days: 1.5 })).toMatch(/between 1 and 365/);
    expect(validatePromotion({ ...base, days: 366 })).toMatch(/between 1 and 365/);
  });

  it("rejects a window that ends before it starts", () => {
    expect(validatePromotion({
      ...base,
      startsAt: new Date("2026-11-10T00:00:00Z"),
      endsAt: new Date("2026-11-01T00:00:00Z"),
    })).toMatch(/after its start/);
  });

  it("rejects a zero cap while allowing unlimited", () => {
    expect(validatePromotion({ ...base, maxRedemptions: 0 })).toMatch(/at least 1/);
    expect(validatePromotion({ ...base, maxRedemptions: null })).toBeNull();
  });

  it("requires a usable code for a code promotion", () => {
    expect(validatePromotion({ ...base, audience: "code", code: null })).toMatch(/needs a code/);
    expect(validatePromotion({ ...base, audience: "code", code: "ab" })).toMatch(/3-32 characters/);
    expect(validatePromotion({ ...base, audience: "code", code: " launch week " })).toMatch(/3-32 characters/);
    expect(validatePromotion({ ...base, audience: "code", code: "launch-week_2026" })).toBeNull();
  });
});
