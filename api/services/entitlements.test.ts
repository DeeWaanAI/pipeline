// The old test in this file pinned TIER_CAPABILITIES and PLAN_CAPABILITIES —
// the ladder matrices retired by the owner decision of 2026-09-22. What is left
// of the rights model is explicit grant rows, and the one thing worth pinning
// without a database is the shape of the string those rows store: it is written
// into `entitlements.capability` for every purchase, so changing its format
// silently orphans rights that already exist.
//
// `can()` / `grant()` / `revoke()` and the ladder's absence are covered against
// a real database in entitlements.integration.test.ts, and the "no new tier"
// invariant in api/acceptanceA22.test.ts.

import { describe, expect, it } from "vitest";
import { purchaseCapability } from "./entitlementSync";

describe("the purchase-capability contract", () => {
  it("is `pipeline:run:<listingId>`, the format already stored in existing rows", () => {
    expect(purchaseCapability(1)).toBe("pipeline:run:1");
    expect(purchaseCapability(2590)).toBe("pipeline:run:2590");
  });

  it("never produces a tier or plan name", () => {
    for (const id of [1, 42, 9999]) {
      expect(purchaseCapability(id)).not.toMatch(/pro_|standard|tier|plan|solo|team/i);
    }
  });

  it("is distinct per listing, so one purchase cannot grant another", () => {
    expect(purchaseCapability(7)).not.toBe(purchaseCapability(8));
  });
});
