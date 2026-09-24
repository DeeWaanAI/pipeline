import { describe, expect, it } from "vitest";
import {
  findWhileTargetErrors,
  pipelineConfigInputSchema,
  pipelineStepInputSchema,
  pipelineStepsInputSchema,
  stepsUseControlFlow,
} from "./pipelineValidation";

const agent = (over: Record<string, unknown> = {}) => ({
  name: "Builder",
  role: "builder",
  systemPrompt: "Build the thing.",
  ...over,
});

describe("pipelineStepInputSchema", () => {
  it("preserves optional per-step provider ids and rejects malformed ids", () => {
    expect(pipelineStepInputSchema.parse(agent({ providerId: 12 }))).toHaveProperty("providerId", 12);
    expect(pipelineStepInputSchema.parse(agent({ providerId: null }))).toHaveProperty("providerId", null);
    for (const providerId of [0, -1, 1.5, "12"]) {
      expect(() => pipelineStepInputSchema.parse(agent({ providerId }))).toThrow();
    }
  });

  it("accepts a plain agent step (defaults stepType to agent)", () => {
    const s = pipelineStepInputSchema.parse(agent());
    expect(s.stepType).toBe("agent");
  });

  it("accepts an approval step with no role/prompt", () => {
    const s = pipelineStepInputSchema.parse({ name: "Human Review", stepType: "approval" });
    expect(s.stepType).toBe("approval");
  });

  it("rejects an agent step without role or systemPrompt", () => {
    expect(() => pipelineStepInputSchema.parse({ name: "X" })).toThrow();
    expect(() => pipelineStepInputSchema.parse({ name: "X", role: "builder" })).toThrow();
  });

  it("requires ifConfig for if steps and whileConfig for while steps", () => {
    expect(() =>
      pipelineStepInputSchema.parse(agent({ stepType: "if" })),
    ).toThrow();
    expect(() =>
      pipelineStepInputSchema.parse(agent({ stepType: "while" })),
    ).toThrow();
  });

  it("accepts well-formed if/while steps", () => {
    const ifStep = pipelineStepInputSchema.parse(
      agent({
        name: "Gate", stepType: "if", role: "critic",
        ifConfig: { options: ["pass", "revise"], mappings: { pass: 3, revise: 1 } },
      }),
    );
    expect(ifStep.stepType).toBe("if");
    const whileStep = pipelineStepInputSchema.parse(
      agent({
        name: "Loop", stepType: "while", role: "critic",
        whileConfig: { targetStep: 1, maxIterations: 3 },
      }),
    );
    expect(whileStep.whileConfig?.maxIterations).toBe(3);
  });

  it("caps while maxIterations at 10", () => {
    expect(() =>
      pipelineStepInputSchema.parse(
        agent({ stepType: "while", whileConfig: { targetStep: 1, maxIterations: 11 } }),
      ),
    ).toThrow();
  });
});

describe("pipelineStepsInputSchema", () => {
  it("rejects empty chains and chains over 20 steps", () => {
    expect(() => pipelineStepsInputSchema.parse([])).toThrow();
    const tooMany = Array.from({ length: 21 }, (_, i) => agent({ name: `A${i}` }));
    expect(() => pipelineStepsInputSchema.parse(tooMany)).toThrow();
  });
});

describe("stepsUseControlFlow", () => {
  it("is false for sequential agent/approval chains", () => {
    expect(
      stepsUseControlFlow([
        pipelineStepInputSchema.parse(agent()),
        pipelineStepInputSchema.parse({ name: "Review", stepType: "approval" }),
      ]),
    ).toBe(false);
  });

  it("is true when any step is if or while", () => {
    const withIf = [
      pipelineStepInputSchema.parse(agent()),
      pipelineStepInputSchema.parse(
        agent({ name: "G", stepType: "if", ifConfig: { options: ["pass"], mappings: { pass: 1 } } }),
      ),
    ];
    expect(stepsUseControlFlow(withIf)).toBe(true);
  });
});

describe("findWhileTargetErrors", () => {
  it("rejects while steps pointing to a later step", () => {
    const steps = [
      pipelineStepInputSchema.parse(agent()),
      pipelineStepInputSchema.parse(
        agent({ name: "L", stepType: "while", whileConfig: { targetStep: 5, maxIterations: 2 } }),
      ),
    ];
    expect(findWhileTargetErrors(steps).length).toBe(1);
  });

  it("accepts while steps pointing to themselves or earlier steps", () => {
    const steps = [
      pipelineStepInputSchema.parse(agent()),
      pipelineStepInputSchema.parse(
        agent({ name: "L", stepType: "while", whileConfig: { targetStep: 1, maxIterations: 2 } }),
      ),
    ];
    expect(findWhileTargetErrors(steps)).toEqual([]);
  });
});

describe("pipelineConfigInputSchema", () => {
  it("accepts partial configs and rejects absurd values", () => {
    expect(pipelineConfigInputSchema.parse({ maxIterations: 5 }).maxIterations).toBe(5);
    expect(() => pipelineConfigInputSchema.parse({ maxIterations: 0 })).toThrow();
    expect(() => pipelineConfigInputSchema.parse({ maxIterations: 51 })).toThrow();
  });
});
