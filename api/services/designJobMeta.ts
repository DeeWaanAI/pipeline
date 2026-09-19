// Shared designer constants, types, prompt and pure parse helpers
// (offering redesign v2, spec §5.1). No DB/provider dependencies — importable
// from BOTH designGenerationService and designJobService without cycles.
//
// AUTO_DESIGN_PROMPT_VERSION "v1" is the existing production prompt kept as
// the compatibility baseline. ANY change here = new version + regression
// evaluation; the research paper is not proof of a changed prompt's
// performance (spec §2.2).

import type { ChatMessage } from "@contracts/index";
import { logger } from "../lib/logger";

export const AUTO_DESIGN_PROMPT_VERSION = "v1";
export const AUTO_DESIGN_MAX_STEPS = 7; // existing "under 8 steps" guidance

export interface DesignAgentSpec {
  name: string;
  role: string;
  systemPrompt: string;
  description?: string;
}

export interface DesignStepSpec {
  name: string;
  role?: string;
  type: string; // agent | if | while | approval
  systemPrompt?: string;
  ifOptions?: string[];
  ifMappings?: Record<string, number>;
}

export interface NormalizedDesign {
  agents: DesignAgentSpec[];
  pipeline: DesignStepSpec[];
  explanation: string;
}

/** Durable provider-call attempt summary (spec §5.3). `uncertain` means the
 *  request may have been accepted/charged before we lost visibility —
 *  exactly-once external LLM execution is never promised. */
export interface GenerationAttemptRecord {
  attemptIndex: number;
  outcome: "success" | "failed" | "uncertain";
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  providerRequestId?: string;
  errorSummary?: string;
  startedAt: string;
  finishedAt?: string;
}

export class DesignValidationError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(`Auto-design validation failed: ${issues.join("; ")}`);
    this.name = "DesignValidationError";
    this.issues = issues;
  }
}

/** The v1 designer prompt — byte-for-byte the production baseline. */
export function buildDesignMessages(task: string): ChatMessage[] {
  const designPrompt = `You are an expert AI Pipeline Designer. Analyze the user's task and design the optimal multi-agent pipeline.

TASK: "${task}"

CRITICAL INSTRUCTION: Describe the OUTCOME you want (e.g., "Translate legal contracts from English to Arabic"), NOT the pipeline architecture (e.g., "Create a quality gate that checks..."). The designer will infer the optimal structure. Do NOT prescribe pipeline structure, quality gates, or specific agent arrangements in your task — just state the objective.

Available agent roles:
- builder: Creates initial content/draft
- critic: Reviews and identifies issues
- refiner: Fixes issues based on feedback
- polisher: Final quality check and formatting
- analyst: Analyzes data and produces insights
- strategist: Develops strategies and plans
- expert: Domain-specific expert opinion
- reviewer: General review and feedback

Design rules:
1. Always start with a Builder agent
2. CRITICAL: An IF or WHILE quality gate MUST be placed AFTER the agent it assesses, not before. The agent being assessed must already have produced output before the gate can review it.
   CORRECT: Builder → Refiner → QualityGate(IF, "revise"→Refiner) ✓
   WRONG: Builder → QualityGate(IF) → Refiner ✗ (gate has nothing to assess!)
3. Use "if" steps for decision points. The "revise" keyword should route back to the most recent REFINER or BUILDER step — the agent that can actually fix the content.
4. Use "while" steps for iterative refinement (retry until quality met). Max 3 iterations.
5. Use "approval" steps before expensive or final steps (human-in-the-loop)
6. End with Polisher for user-facing output
7. Keep pipelines under 8 steps
8. Give each agent a descriptive name reflecting its purpose
9. When using "if" or "while" steps, the agent MUST provide full analysis AND the routing keyword on the last line

For "if" steps: The agent provides a FULL quality assessment with detailed reasoning, then on the VERY LAST LINE outputs ONE keyword from a predefined list (e.g., "pass" or "revise"). The "revise" mapping MUST point to a REFINER or BUILDER agent that exists in the pipeline — never to a non-existent step.
For "while" steps: The agent provides a FULL quality assessment, then on the VERY LAST LINE outputs "retry" (to loop back and improve) or "pass" (to continue). Max 3 iterations. The targetStep MUST point to a REFINER or BUILDER agent.
For "approval" steps: The pipeline pauses for human review.

IMPORTANT: In the explanation, clearly describe the execution flow including which steps may loop or branch. Example: "Builder → Refiner → Quality Check (if revise, loops back to Refiner up to 3x) → Human Review → Polisher".

OUTPUT FORMAT: STRICT JSON ONLY. No markdown, no explanation outside JSON, no prose. The JSON must contain exactly these three top-level keys: "agents", "pipeline", "explanation".
{
  "agents": [
    { "name": "Display Name", "role": "builder|critic|refiner|polisher|analyst|strategist|expert|reviewer", "systemPrompt": "Detailed prompt...", "description": "What this agent does" }
  ],
  "pipeline": [
    { "name": "Builder", "role": "builder", "type": "agent", "systemPrompt": "..." },
    { "name": "Refiner", "role": "refiner", "type": "agent", "systemPrompt": "You are a content refiner. Improve the previous output based on any quality feedback provided. Fix all issues and produce a polished, improved version." },
    { "name": "Quality Gate", "role": "critic", "type": "if", "systemPrompt": "You are a quality gate. Review the refined output carefully. Provide your FULL assessment — strengths, weaknesses, specific issues. Then on the VERY LAST LINE output EXACTLY ONE of these keywords: pass, revise. The keyword determines pipeline routing.", "ifOptions": ["pass", "revise"], "ifMappings": { "pass": 4, "revise": 2 } },
    { "name": "Human Review", "type": "approval" },
    { "name": "Polisher", "role": "polisher", "type": "agent", "systemPrompt": "..." }
  ],
  "explanation": "Why this design was chosen"
}`
  return [
    { role: "system", content: "You are a pipeline design assistant. Output ONLY valid JSON. No markdown, no prose, no explanation outside the JSON block." },
    { role: "user", content: designPrompt },
  ];
}

/** Structural recovery of the LLM design JSON (shared by the legacy sync
 *  path and the durable job path — same behavior as the original service). */
export function normalizeDesignOutput(raw: unknown): NormalizedDesign {
  const design = raw as Partial<{
    agents: DesignAgentSpec[];
    pipeline: DesignStepSpec[];
    explanation: string;
  }> & Record<string, unknown>;

  if (!design.agents || !Array.isArray(design.agents) || design.agents.length === 0) {
    const alt = (design as any).steps || (design as any).nodes || (design as any).pipeline?.filter((s: any) => s.role);
    if (Array.isArray(alt) && alt.length > 0) design.agents = alt;
    else throw new DesignValidationError(["missing required 'agents' array"]);
  }
  if (!design.pipeline || !Array.isArray(design.pipeline)) {
    logger.warn("[designJob] 'pipeline' missing, creating sequential pipeline from agents");
    design.pipeline = design.agents!.map((a) => ({ name: a.name, role: a.role || "custom", type: "agent" }));
  }
  return {
    agents: design.agents!,
    pipeline: design.pipeline!,
    explanation: design.explanation ?? "Pipeline designed automatically",
  };
}
