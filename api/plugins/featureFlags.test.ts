// Unit tests for feature flag evaluation helper.
//
// These test the pure evaluateFlag() function extracted from
// api/plugins/featureFlags.ts for testability.

import { describe, it, expect } from "vitest";
import { evaluateFlag } from "./featureFlags";

describe("evaluateFlag", () => {
  it("enabled=true → true regardless of userId", () => {
    const flag = { enabled: true, rollout: 0, allowed: [] };
    expect(evaluateFlag(flag, 1)).toBe(true);
    expect(evaluateFlag(flag)).toBe(true);
  });

  it("enabled=false, rollout=100 → true for any userId", () => {
    const flag = { enabled: false, rollout: 100, allowed: [] };
    expect(evaluateFlag(flag, 1)).toBe(true);
    expect(evaluateFlag(flag, 999)).toBe(true);
  });

  it("enabled=false, rollout=0, user on allowlist → true", () => {
    const flag = { enabled: false, rollout: 0, allowed: [42, 99] };
    expect(evaluateFlag(flag, 42)).toBe(true);
    expect(evaluateFlag(flag, 99)).toBe(true);
  });

  it("enabled=false, rollout=0, user NOT on allowlist → false", () => {
    const flag = { enabled: false, rollout: 0, allowed: [42] };
    expect(evaluateFlag(flag, 1)).toBe(false);
    expect(evaluateFlag(flag, 43)).toBe(false);
  });

  it("unknown flag (undefined) → false", () => {
    expect(evaluateFlag(undefined, 1)).toBe(false);
    expect(evaluateFlag(undefined)).toBe(false);
  });

  it("rollout>0 but no userId → false", () => {
    const flag = { enabled: false, rollout: 50, allowed: [] };
    expect(evaluateFlag(flag)).toBe(false);
  });

  it("rollout gate is deterministic: same userId → same result", () => {
    const flag = { enabled: false, rollout: 50, allowed: [] };
    const uid = 12345;
    const first = evaluateFlag(flag, uid);
    for (let i = 0; i < 20; i++) {
      expect(evaluateFlag(flag, uid)).toBe(first);
    }
  });
});
