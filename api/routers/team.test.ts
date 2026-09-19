// Pure unit tests for team router helpers — no DB.
//
// Covers: invite-code generation, flag-evaluation matrix.

import { describe, it, expect } from "vitest";
import { generateInviteCode } from "./team";
import { evaluateFlag } from "../plugins/featureFlags";

describe("generateInviteCode", () => {
  it("returns a 16-character string", () => {
    const code = generateInviteCode();
    expect(code).toHaveLength(16);
  });

  it("contains only alphanumeric characters", () => {
    const code = generateInviteCode();
    expect(code).toMatch(/^[A-Za-z0-9]+$/);
  });

  it("generates 1000 unique codes", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      codes.add(generateInviteCode());
    }
    expect(codes.size).toBe(1000);
  });
});

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
    // Run many times — deterministic hash means identical result
    for (let i = 0; i < 20; i++) {
      expect(evaluateFlag(flag, uid)).toBe(first);
    }
  });
});
