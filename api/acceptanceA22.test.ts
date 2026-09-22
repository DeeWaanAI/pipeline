// A22 (offering redesign spec §12): "No new Pro tier, forced frontier default,
// unapproved fixed hold/trial entitlement, per-step optimizer, reward
// credits/points/badges, or automatic numerical punishment is introduced."
//
// A22 is a NEGATIVE invariant, so the useful test is one that fails the day
// someone adds the thing — over the real registered surface and the real
// schema objects, not over a grep of source text. Clauses that are behavioural
// rather than structural (a `trial` entitlement must not be minted without the
// owner's policy, and a delisting must never be automatic) are covered where
// they are enforced: api/services/marketplaceExecution.integration.test.ts and
// api/services/evidenceService.integration.test.ts.

import { describe, expect, it } from "vitest";
import * as schema from "@db/schema";
import { TOOLS } from "./mcp/tools/index";

// Every drizzle table object carries its SQL name on `_.name`.
const tableNames: string[] = (Object.values(schema) as Array<{ _?: { name?: string } } | null | undefined>)
  .map((t) => t?._?.name)
  .filter((n): n is string => typeof n === "string");

describe("A22 — the commercial model introduces no ladder and no reward economy", () => {
  it("the database has no credits, points, badges or reputation ledger", () => {
    const forbidden = /credit|point|badge|reward|karma|leaderboard|penalt/i;
    const offenders = tableNames.filter((n) => forbidden.test(n));
    expect(offenders, `reward-economy tables: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the paid ladder is not widened: users.tier holds only the legacy values", async () => {
    const { users } = await import("@db/schema");
    const column = users.tier as unknown as { enumValues?: readonly string[] };
    const legacy = ["standard", "pro_designer", "pro_auto"];
    // Keeping the column is deliberate (additive-migrations rule); what must not
    // happen is a NEW rung being bolted on while the ladder is retired.
    expect(column.enumValues?.slice().sort()).toEqual(legacy.slice().sort());
  });

  it("no tool sells a plan or grants a tier", () => {
    const forbidden = /upgrade_tier|buy_|purchase_plan|set_tier|grant_tier|assign_plan/i;
    expect(TOOLS.map((t) => t.name).filter((n) => forbidden.test(n))).toEqual([]);
  });

  it("no tool mutates a numerical score or rating on someone else's behalf", () => {
    // Reputation must move through measured evidence (a benchmark, a review
    // task) rather than an admin/automatic dial.
    const forbidden = /adjust_rating|set_grade|bump_score|reset_grade|apply_penalty|demote/i;
    expect(TOOLS.map((t) => t.name).filter((n) => forbidden.test(n))).toEqual([]);
  });

  it("nothing that can spend the account's money is reachable on a read-only scope", () => {
    const spending = TOOLS.filter((t) => /start_benchmark|resume_benchmark|run_batch|run_pipeline|start_design_job|design_pipeline|start_protected_run/.test(t.name));
    expect(spending.length).toBeGreaterThan(3);
    for (const tool of spending) {
      expect(tool.requiredScopes, `${tool.name} demands more than read`).not.toEqual(["mcp:read"]);
    }
  });

  it("a benchmark still needs its approval artifact, and the approval is its own tool", () => {
    expect(TOOLS.map((t) => t.name)).toContain("approve_benchmark_spend");
    for (const name of ["start_benchmark", "resume_benchmark"]) {
      const tool = TOOLS.find((t) => t.name === name);
      expect(tool, `${name} is registered`).toBeDefined();
      const shape = Object.keys((tool?.inputSchema as unknown as { shape?: Record<string, unknown> })?.shape ?? {});
      expect(shape, `${name} must take a spendApprovalId`).toContain("spendApprovalId");
    }
  });
});
