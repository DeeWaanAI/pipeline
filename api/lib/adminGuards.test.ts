import { describe, it, expect } from "vitest";
import { adminDemotionError } from "./adminGuards";

describe("adminDemotionError — lockout guard", () => {
  it("blocks self-demotion", () => {
    expect(
      adminDemotionError({ actorId: 1, targetId: 1, targetIsAdmin: true, adminCount: 3, newRole: "user" }),
    ).toMatch(/demote yourself/);
  });

  it("blocks demoting the last remaining admin", () => {
    expect(
      adminDemotionError({ actorId: 1, targetId: 2, targetIsAdmin: true, adminCount: 1, newRole: "user" }),
    ).toMatch(/last remaining admin/);
  });

  it("allows demoting an admin when others remain", () => {
    expect(
      adminDemotionError({ actorId: 1, targetId: 2, targetIsAdmin: true, adminCount: 2, newRole: "user" }),
    ).toBeNull();
  });

  it("allows promotions unconditionally", () => {
    expect(
      adminDemotionError({ actorId: 1, targetId: 1, targetIsAdmin: false, adminCount: 1, newRole: "admin" }),
    ).toBeNull();
  });

  it("allows re-demoting a non-admin (no-op)", () => {
    expect(
      adminDemotionError({ actorId: 1, targetId: 2, targetIsAdmin: false, adminCount: 1, newRole: "user" }),
    ).toBeNull();
  });
});
