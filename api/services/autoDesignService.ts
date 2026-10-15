// Auto-design service: given a task/objective, ask an LLM to design the
// optimal multi-agent pipeline, then persist agents + steps + a reusable
// template for the project. Single implementation shared by the tRPC
// swarm.autoDesign procedure and the MCP design_pipeline tool.
//
// LEGACY synchronous path (offering redesign v2): behavior is unchanged so
// existing clients keep working during the version rollout (spec §5.2).
// The durable job path in designJobService.ts reuses THIS module's designer
// prompt + normalization + validation + persistence helpers — one designer
// implementation, two execution models. New code should prefer
// startDesignJob() (v2DesignJobs flag).
//
// Requires the caller to have ALREADY checked access (owner of projectId)
// and tier (pipeline:autodesign) — this service does not re-authorize.

import { and, eq } from "drizzle-orm";
import type { ChatMessage } from "@contracts/index";
import { llmProviders, projects } from "@db/schema";
import { extractJsonOrThrow } from "../lib/extractJson";
import { logger } from "../lib/logger";
import { createProviderAdapter } from "../lib/providers";
import { getDb } from "../queries/connection";
import { callWithRetry, decryptApiKey } from "./swarmService";
import {
  buildDesignMessages,
  normalizeDesignOutput,
  persistDesignToProject,
  validateDesignGraph,
  DesignValidationError,
} from "./designJobService";

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
 *  sampling) instead of a configured provider. Sampling is inherently
 *  NON-DURABLE (needs the live desktop session): under v2 it stays on this
 *  synchronous path and is labeled as such (spec §5.2). */
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

  // Only use enabled providers owned by this caller; sampling remains best-effort.
  let providerId = providerIdInput ?? project.defaultProviderId ?? undefined;
  if (!providerId) {
    const [fp] = await db.select().from(llmProviders)
      .where(and(eq(llmProviders.userId, userId), eq(llmProviders.isEnabled, true))).limit(1);
    if (!fp && !options?.chatFn) throw new Error("No LLM provider configured. Add one in Settings first.");
    providerId = fp?.id;
  }
  let adapter: ReturnType<typeof createProviderAdapter> | null = null;
  if (!options?.chatFn) {
    // Enforce credential access here, even for an explicit or project-default ID.
    const [provider] = await db.select().from(llmProviders)
      .where(and(eq(llmProviders.id, providerId!), eq(llmProviders.userId, userId), eq(llmProviders.isEnabled, true)));
    if (!provider) throw new Error("Provider not found");
    const apiKey = decryptApiKey(provider.apiKeyRef);
    adapter = createProviderAdapter(provider.slug, apiKey, provider.baseUrl, provider.defaultModel);
  }

  const messages = buildDesignMessages(task);

  let result = options?.chatFn
    ? await options.chatFn(messages)
    : await callWithRetry(
      () => adapter!.chat(messages, { temperature: 0.3, maxTokens: 4096 }),
      { maxRetries: 3, label: "AutoDesign" },
    );

  let design = await (async () => {
    try {
      return normalizeDesignOutput(extractJsonOrThrow<unknown>(result.content, "auto-design pipeline"));
    } catch (err) {
      if (err instanceof DesignValidationError && (err as DesignValidationError).issues[0]?.includes("'agents'")) throw err;
      logger.warn("[autoDesign] First attempt JSON extraction failed", { error: (err as Error).message, preview: result.content.substring(0, 300) });
      const retryMessages: ChatMessage[] = [
        ...messages,
        { role: "assistant", content: result.content },
        { role: "user", content: "That was not valid JSON. Output ONLY valid JSON matching the exact format requested. No markdown code blocks, no prose, no explanation — just raw JSON." },
      ];
      const retryResult = options?.chatFn
        ? await options.chatFn(retryMessages)
        : await callWithRetry(
          () => adapter!.chat(retryMessages, { temperature: 0.2, maxTokens: 4096 }),
          { maxRetries: 2, label: "AutoDesign-retry" },
        );
      result = retryResult;
      try {
        const recovered = normalizeDesignOutput(extractJsonOrThrow<unknown>(result.content, "auto-design pipeline retry"));
        logger.info("[autoDesign] JSON recovered on retry");
        return recovered;
      } catch {
        throw new Error(
          "Auto-design failed: the AI returned text instead of valid JSON. " +
          "This usually happens when the task description is too detailed or prescribes pipeline architecture. " +
          "Try again with a shorter, simpler description of the outcome you want (e.g., 'Translate legal contracts from English to Arabic').",
        );
      }
    }
  })();

  // Graph validation is enforced for NEW writes on this path too, but only
  // AFTER generation succeeded — a rejected design never touches the
  // project's existing steps (spec §5.1 / A03).
  const issues = validateDesignGraph(design);
  if (issues.length > 0) {
    throw new DesignValidationError(issues);
  }

  const { pipelineSteps } = await import("@db/schema");

  const stats = await db.transaction(async (tx) =>
    persistDesignToProject(tx, userId, projectId, design, task, providerId ?? null),
  );

  const savedSteps = await db.select().from(pipelineSteps)
    .where(eq(pipelineSteps.projectId, projectId))
    .orderBy(pipelineSteps.stepOrder);

  return {
    agentsCreated: stats.agentsCreated,
    stepsCreated: savedSteps.length,
    explanation: design.explanation,
    pipeline: savedSteps.map((s) => ({ name: s.name, role: s.role, stepType: s.stepType })),
    designedBy: options?.chatFn ? "desktop-llm" : "provider",
  };
}
