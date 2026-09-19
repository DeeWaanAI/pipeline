// Pure-map assertions for the entitlement capability matrices.
// TIER_CAPABILITIES (user tier → capabilities) and PLAN_CAPABILITIES
// (subscription plan → capabilities) are the static half of the
// "can user X do Y" brain; can()/grant()/revoke() require a database
// and are NOT tested here.

import { describe, it, expect } from "vitest";
import { TIER_CAPABILITIES } from "./entitlements";
import { PLAN_CAPABILITIES } from "../config/plans";

describe("TIER_CAPABILITIES", () => {
  it("declares exactly the three known tiers", () => {
    expect(Object.keys(TIER_CAPABILITIES).sort()).toEqual([
      "pro_auto",
      "pro_designer",
      "standard",
    ]);
  });

  it("standard: fixed pipelines + a single LLM only", () => {
    const standard = TIER_CAPABILITIES.standard;
    expect([...standard].sort()).toEqual(["llm:1", "pipeline:fixed"]);
    expect(standard.has("pipeline:custom")).toBe(false);
    expect(standard.has("llm:3")).toBe(false);
    expect(standard.has("marketplace:publish")).toBe(false);
    expect(standard.has("pipeline:autodesign")).toBe(false);
  });

  it("pro_designer: adds custom pipelines, 3 LLMs, marketplace publishing", () => {
    const pro = TIER_CAPABILITIES.pro_designer;
    for (const cap of ["pipeline:fixed", "llm:1", "pipeline:custom", "llm:3", "marketplace:publish"]) {
      expect(pro.has(cap)).toBe(true);
    }
    expect(pro.size).toBe(5);
    expect(pro.has("pipeline:autodesign")).toBe(false);
  });

  it("pro_auto: everything pro_designer has, plus auto-design", () => {
    const auto = TIER_CAPABILITIES.pro_auto;
    expect(auto.has("pipeline:autodesign")).toBe(true);
    expect(auto.size).toBe(6);
  });

  it("tiers form a superset chain: standard ⊆ pro_designer ⊆ pro_auto", () => {
    const { standard, pro_designer, pro_auto } = TIER_CAPABILITIES;
    for (const cap of standard) expect(pro_designer.has(cap)).toBe(true);
    for (const cap of pro_designer) expect(pro_auto.has(cap)).toBe(true);
  });

  it("unknown tiers have no capability set", () => {
    expect(TIER_CAPABILITIES["nonexistent"]).toBeUndefined();
  });
});

describe("PLAN_CAPABILITIES", () => {
  it("solo plan unlocks the full single-user pipeline surface", () => {
    const solo = PLAN_CAPABILITIES.solo;
    for (const cap of ["pipeline:fixed", "llm:1", "pipeline:custom", "llm:3", "pipeline:autodesign"]) {
      expect(solo.has(cap)).toBe(true);
    }
  });

  it("team_seat adds team collaboration on top of the solo surface", () => {
    const team = PLAN_CAPABILITIES.team_seat;
    for (const cap of PLAN_CAPABILITIES.solo) expect(team.has(cap)).toBe(true);
    expect(team.has("team:collaborate")).toBe(true);
  });
});
