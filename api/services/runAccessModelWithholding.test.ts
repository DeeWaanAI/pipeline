// Which model a step pins is part of a `run_only` grantor's definition, so the
// read surfaces must withhold it. These are the four cases the withholding is
// decided by; the surfaces (`export.ts`, `debug.getRunStats`) call this one
// predicate rather than each re-deriving the mode from `run_params`.

import { describe, it, expect } from "vitest";
import { MODEL_BEARING_RUN_COLUMNS, isProtectedRun, modelWasGrantorPinned, withholdsModel } from "./runAccess";

const shared = (mode: "run_only" | "full") => ({ runParams: { sharedRun: { shareId: 7, mode, granteeId: 3 } } });

describe("withholdsModel", () => {
  it("withholds the grantor's model from a run_only recipient", () => {
    expect(withholdsModel(shared("run_only"))).toBe(true);
  });

  it("does not withhold from a full recipient, who was given the definition", () => {
    expect(withholdsModel(shared("full"))).toBe(false);
  });

  it("does not withhold from a marketplace buyer run, whose manifest names the models on purpose", () => {
    const buyerRun = { runParams: { protectedRun: { listingId: 4 } } };
    expect(isProtectedRun(buyerRun)).toBe(true);
    expect(withholdsModel(buyerRun)).toBe(false);
  });

  it("does not withhold from an ordinary owner run, and never throws on a missing row", () => {
    expect(withholdsModel({ runParams: { projectId: 1 } })).toBe(false);
    expect(withholdsModel(null)).toBe(false);
    expect(withholdsModel(undefined)).toBe(false);
  });

  it("names the step column the read projections drop, and no prompt column", () => {
    expect([...MODEL_BEARING_RUN_COLUMNS]).toEqual(["modelUsed"]);
  });
});

// #40: the restriction is per VALUE, not per run. A `run_only` recipient runs on
// their own credential, so the model that served them is theirs to see; a name
// the grantor pinned in the definition is the grantor's design.
describe("modelWasGrantorPinned", () => {
  const grantorPinned = new Set(["owner-model", " Other-Model "]);
  const decide = (v: string | null | undefined) => modelWasGrantorPinned(grantorPinned, v);

  it("withholds the name the grantor chose, however the host spells or spaces it", () => {
    expect(decide("  Other-Model  ")).toBe(true);
    expect(decide("OWNER-MODEL")).toBe(true);
    expect(decide("other-model")).toBe(true);
  });

  it("shows the recipient's own resolved model", () => {
    expect(decide("grantee-model")).toBe(false);
  });

  it("shows an empty or absent value rather than inventing a restriction", () => {
    expect(decide(null)).toBe(false);
    expect(decide(undefined)).toBe(false);
    expect(decide("   ")).toBe(false);
  });

  it("nothing is pinned when the grantor pinned nothing, so every value shows", () => {
    expect(modelWasGrantorPinned(new Set(), "owner-model")).toBe(false);
  });
});
