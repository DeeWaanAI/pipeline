// Pure validation for MCP pipeline-authoring tools (create_pipeline /
// update_pipeline). Kept DB-free so it is unit-testable; mirrors the shapes
// of db pipeline_steps and the web pipeline editor.

import { z } from "zod";

export const STEP_TYPES = ["agent", "if", "while", "approval"] as const;
export type StepType = (typeof STEP_TYPES)[number];

/** Step types that require the pipeline:custom capability (tier-gated). */
export const CONTROL_FLOW_TYPES: ReadonlySet<string> = new Set(["if", "while"]);

export const MAX_STEPS = 20;
export const MAX_WHILE_ITERATIONS = 10;

const ifConfigSchema = z.object({
  options: z.array(z.string().min(1)).min(1),
  mappings: z.record(z.string(), z.number().int().min(1)),
});

const whileConfigSchema = z.object({
  targetStep: z.number().int().min(1),
  maxIterations: z.number().int().min(1).max(MAX_WHILE_ITERATIONS),
});

export const pipelineStepInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    role: z.string().trim().min(1).max(50).optional(),
    systemPrompt: z.string().min(1).optional(),
    stepType: z.enum(STEP_TYPES).default("agent"),
    ifConfig: ifConfigSchema.nullish(),
    whileConfig: whileConfigSchema.nullish(),
    model: z.string().max(100).nullish(),
    temperature: z.string().max(10).nullish(),
    maxTokens: z.number().int().min(1).max(128000).nullish(),
  })
  .superRefine((step, ctx) => {
    if (step.stepType === "approval") return; // human gate: no agent fields needed
    if (!step.role) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `step "${step.name}": role is required for ${step.stepType} steps` });
    }
    if (!step.systemPrompt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `step "${step.name}": systemPrompt is required for ${step.stepType} steps` });
    }
    if (step.stepType === "if" && !step.ifConfig) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `step "${step.name}": ifConfig is required for if steps` });
    }
    if (step.stepType === "while" && !step.whileConfig) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `step "${step.name}": whileConfig is required for while steps` });
    }
  });

export type PipelineStepInput = z.infer<typeof pipelineStepInputSchema>;

export const pipelineStepsInputSchema = z
  .array(pipelineStepInputSchema)
  .min(1)
  .max(MAX_STEPS);

export const pipelineConfigInputSchema = z.object({
  maxIterations: z.number().int().min(1).max(50).optional(),
  enabledAgents: z.array(z.string().min(1)).max(MAX_STEPS).optional(),
  stopOnNoImprovement: z.boolean().optional(),
});

/** True when any step needs the pipeline:custom capability (IF/WHILE). */
export function stepsRequireCustomTier(steps: PipelineStepInput[]): boolean {
  return steps.some((s) => CONTROL_FLOW_TYPES.has(s.stepType));
}

/** Validate a whileConfig.targetStep against the step's own position (1-based). */
export function findWhileTargetErrors(steps: PipelineStepInput[]): string[] {
  const errors: string[] = [];
  steps.forEach((s, i) => {
    if (s.stepType === "while" && s.whileConfig) {
      if (s.whileConfig.targetStep > i + 1) {
        errors.push(`step ${i + 1} ("${s.name}"): whileConfig.targetStep must point to itself or an earlier step`);
      }
    }
  });
  return errors;
}
