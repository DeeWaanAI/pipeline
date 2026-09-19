// Unit tests for the durable design-job validation core (offering redesign
// v2, spec §5.1). Pure functions — no DB, no provider calls.

import { describe, expect, it } from "vitest";
import {
  AUTO_DESIGN_MAX_STEPS,
  canonicalStepHash,
  normalizeDesignOutput,
  validateDesignGraph,
  type NormalizedDesign,
} from "./designJobService";

const agentStep = (name: string, role: string) => ({ name, role, type: "agent", systemPrompt: `p-${name}` });

const validDesign: NormalizedDesign = {
  agents: [
    { name: "Translator", role: "builder", systemPrompt: "translate" },
    { name: "Checker", role: "critic", systemPrompt: "check" },
  ],
  pipeline: [
    { name: "Translator", role: "builder", type: "agent" },
    { name: "Quality Gate", role: "critic", type: "if", ifOptions: ["pass", "revise"], ifMappings: { pass: 3, revise: 1 } },
    { name: "Polisher", role: "polisher", type: "agent" },
  ],
  explanation: "sequential with one backward gate",
};

describe("validateDesignGraph", () => {
  it("accepts a well-formed graph with backward if-routing", () => {
    expect(validateDesignGraph(validDesign)).toEqual([]);
  });

  it("accepts functional critic/refiner roles and bounded while loops (A03)", () => {
    const design: NormalizedDesign = {
      agents: [agentStep("B", "builder"), agentStep("R", "refiner")],
      pipeline: [
        agentStep("B", "builder"),
        agentStep("R", "refiner"),
        { name: "Loop", role: "critic", type: "while" },
      ],
      explanation: "loop",
    };
    expect(validateDesignGraph(design)).toEqual([]);
  });

  it("rejects if-mappings that target a nonexistent step", () => {
    const design = structuredClone(validDesign) as NormalizedDesign;
    design.pipeline[1].ifMappings = { pass: 9, revise: 1 };
    const issues = validateDesignGraph(design);
    expect(issues.some((i) => i.includes("nonexistent step"))).toBe(true);
  });

  it("rejects self-routing if-mappings (infinite self-loop)", () => {
    const design = structuredClone(validDesign) as NormalizedDesign;
    design.pipeline[1].ifMappings = { pass: 3, revise: 2 }; // step 2 → itself
    expect(validateDesignGraph(design).some((i) => i.includes("self-loop"))).toBe(true);
  });

  it("allows forward continue edges and backward revise edges", () => {
    const design = structuredClone(validDesign) as NormalizedDesign;
    design.pipeline[1].ifMappings = { pass: 3, revise: 1 };
    expect(validateDesignGraph(design)).toEqual([]);
  });

  it("rejects oversized plans beyond the v1 baseline cap", () => {
    const design = structuredClone(validDesign) as NormalizedDesign;
    design.pipeline = Array.from({ length: AUTO_DESIGN_MAX_STEPS + 2 }, (_, i) => agentStep(`S${i}`, "builder"));
    expect(validateDesignGraph(design).some((i) => i.includes("exceeds"))).toBe(true);
  });

  it("rejects unknown step types and role-less non-approval steps", () => {
    const design: NormalizedDesign = {
      agents: [{ name: "X", role: "builder", systemPrompt: "x" }],
      pipeline: [
        { name: "Weird", role: "builder", type: "teleport" as string },
        { name: "NoRole", type: "agent" } as unknown as NormalizedDesign["pipeline"][number],
      ],
      explanation: "",
    };
    const issues = validateDesignGraph(design);
    expect(issues.some((i) => i.includes("unknown step type"))).toBe(true);
    expect(issues.some((i) => i.includes("no role"))).toBe(true);
  });

  it("keeps approval steps supported without agent fields (private workflows)", () => {
    const design: NormalizedDesign = {
      agents: [{ name: "B", role: "builder", systemPrompt: "b" }],
      pipeline: [agentStep("B", "builder"), { name: "Human Review", type: "approval" }],
      explanation: "",
    };
    expect(validateDesignGraph(design)).toEqual([]);
  });
});

describe("normalizeDesignOutput", () => {
  it("recovers 'agents' from alternative structures", () => {
    const raw = { steps: [{ name: "A", role: "builder", systemPrompt: "a" }], explanation: "e" };
    const design = normalizeDesignOutput(raw);
    expect(design.agents).toHaveLength(1);
    expect(design.pipeline).toHaveLength(1); // sequential from agents
    expect(design.pipeline[0].type).toBe("agent");
  });

  it("throws when no agent list can be found at all", () => {
    expect(() => normalizeDesignOutput({ nonsense: true })).toThrow(/agents/);
  });
});

describe("canonicalStepHash", () => {
  it("is stable across row ordering and irrelevant field order", () => {
    const a = canonicalStepHash([
      { stepOrder: 2, stepType: "agent", name: "B", role: "builder", systemPrompt: "p2", ifConfig: null, whileConfig: null, isEnabled: true },
      { stepOrder: 1, stepType: "agent", name: "A", role: "critic", systemPrompt: "p1", ifConfig: null, whileConfig: null, isEnabled: true },
    ]);
    const b = canonicalStepHash([
      { stepOrder: 1, stepType: "agent", name: "A", role: "critic", systemPrompt: "p1", ifConfig: null, whileConfig: null, isEnabled: true },
      { stepOrder: 2, stepType: "agent", name: "B", role: "builder", systemPrompt: "p2", ifConfig: null, whileConfig: null, isEnabled: true },
    ]);
    expect(a).toBe(b);
  });

  it("changes when a prompt changes (legacy writers, no counter bump)", () => {
    const before = canonicalStepHash([{ stepOrder: 1, stepType: "agent", name: "A", role: "builder", systemPrompt: "v1", isEnabled: true }]);
    const after = canonicalStepHash([{ stepOrder: 1, stepType: "agent", name: "A", role: "builder", systemPrompt: "v2", isEnabled: true }]);
    expect(before).not.toBe(after);
  });
});
