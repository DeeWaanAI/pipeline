// Auto-design service: given a task/objective, ask an LLM to design the
// optimal multi-agent pipeline, then persist agents + steps + a reusable
// template for the project. Single implementation shared by the tRPC
// swarm.autoDesign procedure and the MCP design_pipeline tool.
//
// Requires the caller to have ALREADY checked access (owner of projectId)
// and tier (pipeline:autodesign) — this service does not re-authorize.

import { and, eq } from "drizzle-orm";
import type { ChatMessage } from "@contracts/index";
import { customAgents, llmProviders, pipelineSteps, pipelineTemplates, projects } from "@db/schema";
import { extractJsonOrThrow } from "../lib/extractJson";
import { logger } from "../lib/logger";
import { createProviderAdapter } from "../lib/providers";
import { getDb } from "../queries/connection";
import { callWithRetry, decryptApiKey } from "./swarmService";

export interface AutoDesignResult {
  agentsCreated: number;
  stepsCreated: number;
  explanation: string;
  pipeline: Array<{ name: string; role: string; stepType: string }>;
  /** Which LLM path produced the design: a configured provider or the
   *  connected desktop app's own LLM via MCP sampling. */
  designedBy: "provider" | "desktop-llm";
}

/** Optional override for the LLM call — used by the MCP design_pipeline
 *  tool to run the design on the connected desktop app's own LLM (MCP
 *  sampling) instead of a configured provider. */
export interface AutoDesignOptions {
  chatFn?: (messages: ChatMessage[]) => Promise<{ content: string }>;
}

export async function runAutoDesign(
  userId: number,
  projectId: number,
  task: string,
  providerIdInput?: number,
  options?: AutoDesignOptions,
): Promise<AutoDesignResult> {
  const db = getDb();
  const [project] = await db.select().from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  if (!project) throw new Error("Project not found");

  // Resolve provider. When a chatFn is supplied (MCP sampling on the
  // desktop app's own LLM), the provider is best-effort — it only sets the
  // default provider recorded on the created agents/steps, and may be absent.
  let providerId = providerIdInput ?? project.defaultProviderId ?? undefined;
  if (!providerId) {
    const [fp] = await db.select().from(llmProviders).where(eq(llmProviders.userId, userId)).limit(1);
    if (!fp && !options?.chatFn) throw new Error("No LLM provider configured. Add one in Settings first.");
    providerId = fp?.id;
  }
  let adapter: ReturnType<typeof createProviderAdapter> | null = null;
  if (!options?.chatFn) {
    const [provider] = await db.select().from(llmProviders).where(eq(llmProviders.id, providerId!));
    if (!provider) throw new Error("Provider not found");
    const apiKey = decryptApiKey(provider.apiKeyRef);
    adapter = createProviderAdapter(provider.slug, apiKey, provider.baseUrl, provider.defaultModel);
  }

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
}`;

  const messages: ChatMessage[] = [
    { role: "system", content: "You are a pipeline design assistant. Output ONLY valid JSON. No markdown, no prose, no explanation outside the JSON block." },
    { role: "user", content: designPrompt },
  ];

  let result = options?.chatFn
    ? await options.chatFn(messages)
    : await callWithRetry(
      () => adapter!.chat(messages, { temperature: 0.3, maxTokens: 4096 }),
      { maxRetries: 3, label: "AutoDesign" },
    );

  // ─── Parse JSON from response ───────────────────────────────────
  interface DesignOutput {
    agents: Array<{ name: string; role: string; systemPrompt: string; description?: string }>;
    pipeline: Array<{ name: string; role?: string; type: string; systemPrompt?: string; ifOptions?: string[]; ifMappings?: Record<string, number> }>;
    explanation?: string;
  }

  let design: DesignOutput | null = null;

  let parseError = "";

  try {
    design = extractJsonOrThrow<DesignOutput>(result.content, "auto-design pipeline");
  } catch (err) {
    parseError = (err as Error).message;
    logger.warn("[autoDesign] First attempt JSON extraction failed", { parseError, preview: result.content.substring(0, 300) });

    // ─── Retry with explicit JSON-only reminder ───────────────────
    const retryMessages: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: result.content },
      { role: "user", content: "That was not valid JSON. Output ONLY valid JSON matching the exact format requested. No markdown code blocks, no prose, no explanation — just raw JSON." },
    ];

    try {
      const retryResult = options?.chatFn
        ? await options.chatFn(retryMessages)
        : await callWithRetry(
          () => adapter!.chat(retryMessages, { temperature: 0.2, maxTokens: 4096 }),
          { maxRetries: 2, label: "AutoDesign-retry" },
        );
      result = retryResult;
      design = extractJsonOrThrow<DesignOutput>(result.content, "auto-design pipeline retry");
      logger.info("[autoDesign] JSON recovered on retry");
    } catch (retryErr) {
      logger.error("[autoDesign] Retry also failed", { error: (retryErr as Error).message });
    }
  }

  if (!design) {
    throw new Error(
      "Auto-design failed: the AI returned text instead of valid JSON. " +
      "This usually happens when the task description is too detailed or prescribes pipeline architecture. " +
      "Try again with a shorter, simpler description of the outcome you want (e.g., 'Translate legal contracts from English to Arabic')."
    );
  }

  // ─── Structural validation: LLM may return valid JSON but without expected arrays ───
  if (!design.agents || !Array.isArray(design.agents) || design.agents.length === 0) {
    // Try common alternative structures the LLM might produce
    const altAgents = (design as any).steps || (design as any).nodes || (design as any).pipeline?.filter((s: any) => s.role);
    if (Array.isArray(altAgents) && altAgents.length > 0) {
      logger.warn("[autoDesign] 'agents' missing, recovered from alternative field");
      design.agents = altAgents;
    } else {
      throw new Error(
        "Auto-design failed: the AI returned JSON but it was missing the required 'agents' array. " +
        "The AI may have misunderstood the format. Try rephrasing your task description to be simpler."
      );
    }
  }
  if (!design.pipeline || !Array.isArray(design.pipeline)) {
    // If pipeline array is missing, create a simple sequential pipeline from the agents
    logger.warn("[autoDesign] 'pipeline' missing, creating sequential pipeline from agents");
    design.pipeline = design.agents.map((a) => ({
      name: a.name,
      role: a.role || "custom",
      type: "agent",
    }));
  }

  // ─── Create agents ───
  const createdAgents: Array<{ id: number; name: string; role: string }> = [];
  for (const agent of design.agents) {
    // Validate required fields — LLM may omit them
    if (!agent.name || !agent.name.trim()) {
      logger.warn("[autoDesign] Skipping agent with no name", { agent });
      continue;
    }
    const role = agent.role && agent.role.trim() ? agent.role.trim() : "custom";
    if (!agent.role) {
      logger.warn("[autoDesign] Agent has no role — using \"custom\"", { agentName: agent.name });
    }

    const slug = `${role}-${agent.name.toLowerCase().replace(/[^a-z0-9_-]/g, "").substring(0, 30)}`;

    // Check if agent already exists
    const [existing] = await db.select().from(customAgents)
      .where(and(eq(customAgents.userId, userId), eq(customAgents.slug, slug)))
      .limit(1);

    if (existing) {
      createdAgents.push({ id: existing.id, name: existing.name, role: existing.role });
      continue;
    }

    await db.insert(customAgents).values({
      userId,
      name: agent.name,
      slug,
      role,
      systemPrompt: agent.systemPrompt ?? `Auto-created ${role} agent for pipeline execution.`,
      description: agent.description ?? `Auto-created for: ${task.substring(0, 100)}`,
      defaultProviderId: providerId ?? null,
      temperature: "0.7",
      maxTokens: 4096,
    });

    const [created] = await db.select().from(customAgents)
      .where(and(eq(customAgents.userId, userId), eq(customAgents.slug, slug)))
      .limit(1);
    if (created) {
      createdAgents.push({ id: created.id, name: created.name, role: created.role });
    }
  }

  // ─── Delete existing pipeline steps ───
  await db.delete(pipelineSteps).where(eq(pipelineSteps.projectId, projectId));

  // ─── Create new pipeline steps ───
  const agentMap = new Map(createdAgents.map((a) => [`${a.role}-${a.name}`, a.id]));

  for (let i = 0; i < design.pipeline.length; i++) {
    const p = design.pipeline[i];
    const isApproval = p.type === "approval";

    // Find agent ID
    let agentId: number | null = null;
    if (!isApproval && p.role) {
      agentId = agentMap.get(`${p.role}-${p.name}`) ??
        createdAgents.find((a) => a.role === p.role)?.id ??
        createdAgents[0]?.id ?? null;
    }

    await db.insert(pipelineSteps).values({
      projectId,
      stepOrder: i + 1,
      agentId,
      stepType: p.type,
      name: p.name,
      role: p.role ?? "custom",
      systemPrompt: p.systemPrompt ?? (isApproval ? "Human review required" : "Process the input"),
      providerId: isApproval ? null : providerId ?? null,
      temperature: "0.7",
      maxTokens: 4096,
      ifConfig: p.type === "if" && p.ifOptions && p.ifMappings
        ? { options: p.ifOptions, mappings: p.ifMappings }
        : null,
      whileConfig: p.type === "while"
        ? { targetStep: Math.max(1, i), maxIterations: 3 }
        : null,
      isEnabled: true,
    });
  }

  const saved = await db.select().from(pipelineSteps)
    .where(eq(pipelineSteps.projectId, projectId))
    .orderBy(pipelineSteps.stepOrder);

  // ─── Auto-save as reusable template ──────────────────────────────
  const templateSteps = saved.map((s) => ({
    name: s.name,
    role: s.role,
    systemPrompt: s.systemPrompt,
    stepType: s.stepType,
    ifConfig: s.ifConfig,
    whileConfig: s.whileConfig,
    providerId: s.providerId,
    model: s.model,
    temperature: s.temperature ?? "0.7",
    maxTokens: s.maxTokens ?? 4096,
  }));

  const [tplResult] = await db.insert(pipelineTemplates).values({
    userId,
    name: `${project.name} Pipeline`,
    description: design.explanation ?? `Auto-designed pipeline with ${saved.length} steps`,
    steps: templateSteps,
    isAuto: true,
    sourceProjectId: projectId,
  });

  await db.update(projects)
    .set({ pipelineTemplateId: Number(tplResult.insertId) })
    .where(eq(projects.id, projectId));

  return {
    agentsCreated: createdAgents.length,
    stepsCreated: saved.length,
    explanation: design.explanation ?? "Pipeline designed automatically",
    pipeline: saved.map((s) => ({ name: s.name, role: s.role, stepType: s.stepType })),
    designedBy: options?.chatFn ? "desktop-llm" : "provider",
  };
}
