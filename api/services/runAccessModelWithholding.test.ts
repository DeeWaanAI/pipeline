// Ticket #40 (owner decision): the model that ran a step is NOT withheld.
//
// It used to be, for `run_only` shares, on the reasoning that a step's model is
// part of the grantor's definition. That was only true because a shared run
// executed the GRANTOR's pinned model on the recipient's credential — which is
// both a leak and a broken promise, since the recipient supplies their own key
// and their own models. `pipelineSharing.loadAuthorizedSharedSnapshotSteps` now
// drops that pin the way it already dropped the grantor's provider binding, so
// the value on a recipient's step row is their own model and there is nothing
// left to withhold. These are the two halves of that rule.

import { describe, expect, it, vi } from "vitest";

vi.mock("../queries/connection", () => ({
  getDb: () => { throw new Error("the redaction rule must not reach the database"); },
}));

import {
  PROMPT_BEARING_RUN_COLUMNS, isProtectedRun, redactProtectedAgentRun, sharedRunOf,
} from "./runAccess";
import type { agentRuns } from "@db/schema";

const stepRow = {
  id: 1, swarmRunId: 7, projectId: 3, agentName: "Draft", agentRole: "builder",
  pipelineStep: 1, iteration: 1, status: "completed",
  systemPrompt: "GRANTOR SYSTEM PROMPT: read /vault/deeds",
  userPrompt: "GRANTOR STEP PROMPT", contextInput: "GRANTOR CONTEXT",
  modelUsed: "grantee-model", providerUsed: "grantee-provider", tokensUsed: 13,
} as unknown as typeof agentRuns.$inferSelect;

const runOnly = { runParams: { sharedRun: { shareId: 7, mode: "run_only", granteeId: 3 } } };

describe("the redaction rule (ticket #40)", () => {
  it("drops the grantor's prompt text and nothing else", () => {
    const redacted = redactProtectedAgentRun(stepRow);
    for (const column of PROMPT_BEARING_RUN_COLUMNS) expect(redacted[column]).toBeUndefined();
    expect(Object.keys(redacted).sort()).toEqual(
      Object.keys(stepRow).filter((k) => !(PROMPT_BEARING_RUN_COLUMNS as readonly string[]).includes(k)).sort(),
    );
  });

  it("shows the model that served the call, even to a run_only recipient", () => {
    expect(redactProtectedAgentRun(stepRow).modelUsed).toBe("grantee-model");
    // The same projection is what the caller's own surface sees: no marker, and
    // no second, narrower answer for a `full` share.
    expect(JSON.stringify(redactProtectedAgentRun(stepRow))).not.toMatch(/withheld/);
  });

  it("still recognises a run_only shared run as protected, and names its mode", () => {
    expect(isProtectedRun(runOnly)).toBe(true);
    expect(sharedRunOf(runOnly)?.mode).toBe("run_only");
  });

  it("leaves an owner's own run unredacted, and never throws on a missing row", () => {
    expect(isProtectedRun({ runParams: { projectId: 1 } })).toBe(false);
    expect(isProtectedRun(null)).toBe(false);
    expect(isProtectedRun(undefined)).toBe(false);
    expect(sharedRunOf(null)).toBeNull();
  });
});
