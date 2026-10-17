import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import {
  swarmRuns, agentResponses, agents, llmProviders,
  projects,
} from "@db/schema";
import { eq, and, desc, asc } from "drizzle-orm";
import { ExecuteSwarmSchema, ApproveStepSchema, AutoDesignSchema } from "@contracts/index";
import type { ChatMessage } from "@contracts/index";
import { createProviderAdapter } from "../lib/providers";
import { getMasterKey, encrypt } from "../services/cryptoService";
import { loadPipelineSteps, callWithRetry, decryptApiKey, type SwarmRunParams } from "../services/swarmService";
import { enqueueSwarmRun } from "../workers/swarmWorker";
import { assertExecutionAllowed } from "../lib/hostedGuards";
import { assertRunControlAllowed, canAccessRun } from "../services/runAccess";
import { signStreamPath } from "../lib/streamToken";
import { runAutoDesign } from "../services/autoDesignService";
import { logger } from "../lib/logger";
import { checkRateLimitAsync, RATE_LIMITS } from "../lib/rateLimiter";

// ═══════════════════════════════════════════════════════════════════
//  NOTE (F0.5): the pipeline execution engine (execution loop, agent-step
//  execution, provider resolution, Gitee saves, state machine) now lives in
//  api/services/swarmService.ts and runs inside the swarm worker
//  (api/workers/swarmWorker.ts). This router keeps input validation, access
//  checks and run-row management, then ENQUEUES jobs instead of blocking.
//  tRPC return shapes are unchanged; progress still streams via SSE.
// ═══════════════════════════════════════════════════════════════════

// Helper: OWNER-ONLY project access (team sharing was removed with #26).
async function canAccessProject(userId: number, projectId: number): Promise<boolean> {
  const db = getDb();
  const [project] = await db
    .select({ userId: projects.userId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return !!project && project.userId === userId;
}

// ═══════════════════════════════════════════════════════════════════
//  ROUTER
// ═══════════════════════════════════════════════════════════════════
export const swarmRouter = createRouter({

  prepareRun: authedQuery
    .input(z.object({ projectId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const hasAccess = await canAccessProject(ctx.user.id, input.projectId);
      if (!hasAccess) throw new Error("Project not found");

      const db = getDb();

      // Wrap initial record creation in a transaction for atomicity
      let runId: number;
      await db.transaction(async (tx) => {
        await tx.insert(swarmRuns).values({
          projectId: input.projectId, userId: ctx.user.id,
          userPrompt: "", status: "queued",
          pipelineVersion: "custom-v2", agentsUsed: [],
        });
        const [run] = await tx.select().from(swarmRuns)
          .where(eq(swarmRuns.userId, ctx.user.id))
          .orderBy(desc(swarmRuns.id)).limit(1);
        runId = run.id;
      });

      return { runId: runId! };
    }),

  getPipeline: authedQuery
    .input(z.object({ projectId: z.number() }))
    .query(async ({ input, ctx }) => {
      const hasAccess = await canAccessProject(ctx.user.id, input.projectId);
      if (!hasAccess) throw new Error("Project not found");

      const db = getDb();
      const pipeline = await loadPipelineSteps(db, input.projectId);
      if (!pipeline) {
        logger.info("[getPipeline] no pipeline_steps found, falling back to legacy agents", { projectId: input.projectId });
        const legacy = await db.select().from(agents)
          .where(and(eq(agents.projectId, input.projectId), eq(agents.isEnabled, true)))
          .orderBy(asc(agents.pipelineOrder));
        logger.info("[getPipeline] returning legacy agents", { projectId: input.projectId, count: legacy.length });
        return {
          steps: legacy.map((a, i) => ({ stepOrder: i + 1, name: a.name, role: a.role, systemPrompt: a.systemPrompt, isEnabled: true, providerId: a.providerId, model: a.model, stepType: "agent" as const, ifConfig: null, whileConfig: null })),
          isCustom: false,
        };
      }
      logger.info("[getPipeline] returning custom pipeline steps", { projectId: input.projectId, count: pipeline.length });
      return {
        steps: pipeline.map((s) => ({ stepOrder: s.stepOrder, name: s.name, role: s.role, systemPrompt: s.systemPrompt, isEnabled: true, providerId: s.providerId, model: s.model, stepType: s.stepType, ifConfig: s.ifConfig, whileConfig: s.whileConfig })),
        isCustom: true,
      };
    }),

  // A12: the SSE route is no longer reachable by run id alone. EventSource
  // cannot send headers, so the browser asks here for a signature scoped to one
  // run and valid for an hour; the session token never enters a URL.
  streamUrl: authedQuery
    .input(z.object({ swarmRunId: z.number() }))
    .query(async ({ input, ctx }) => {
      if (!(await canAccessRun(ctx.user.id, input.swarmRunId))) throw new Error("Run not found");
      return { url: signStreamPath(input.swarmRunId, ctx.user.id) };
    }),

  execute: authedQuery
    .input(ExecuteSwarmSchema)
    .mutation(async ({ input, ctx }) => {
      // V3 L4: refuse before any DB work so the answer is the 410 pointer,
      // never a confusing "Project not found" on a marketplace-only deploy.
      assertExecutionAllowed();
      const rl = await checkRateLimitAsync(`execute:${ctx.user.id}`, RATE_LIMITS.execute);
      if (!rl.allowed) {
        throw new Error(`Too many executions. Try again in ${Math.ceil(rl.retryAfterMs / 1000)}s.`);
      }
      logger.info(`[EXECUTE-ENTRY] project=${input.projectId} runId=${input.runId} user=${ctx.user.id} trace=${input.clientTraceId ?? "none"}`);
      const hasAccess = await canAccessProject(ctx.user.id, input.projectId);
      if (!hasAccess) throw new Error("Project not found");

      const db = getDb();
      const [project] = await db.select().from(projects)
        .where(eq(projects.id, input.projectId)).limit(1);
      if (!project) throw new Error("Project not found");

      // ─── Resolve runId ───
      let swarmRunId: number = 0;

      if (input.runId) {
        const [existing] = await db.select().from(swarmRuns)
          .where(and(eq(swarmRuns.id, input.runId), eq(swarmRuns.userId, ctx.user.id)));
        if (!existing) throw new Error("Run not found");
        // A marketplace run belongs to `marketplaceExecution.start`, not to this
        // entry point: re-running it here would rebuild run_params and lose the
        // protected context rather than reuse it.
        assertRunControlAllowed(existing);

        // Guard: refuse to resume a run that is no longer active. Prevents
        // stale HITL clicks on old chats from re-running tail steps (which
        // previously caused spurious Gitee files to be created).
        if (existing.executionState && existing.status !== "running") {
          logger.warn(`[execute] Refusing resume on run ${input.runId} (status=${existing.status}) — clearing stale executionState`);
          await db.update(swarmRuns).set({ executionState: null }).where(eq(swarmRuns.id, input.runId));
          // Return the existing final response so the frontend can render it
          let finalText = "Pipeline already completed.";
          if (existing.finalResponseId) {
            const [resp] = await db.select({ content: agentResponses.content }).from(agentResponses)
              .where(eq(agentResponses.id, existing.finalResponseId));
            if (resp) finalText = resp.content;
          }
          return { finalResponse: finalText, chain: [], awaitingApproval: false };
        }

        await db.update(swarmRuns).set({
          status: "running", userPrompt: input.prompt,
          startedAt: new Date(),
        }).where(eq(swarmRuns.id, input.runId));
        swarmRunId = input.runId;
      } else {
        // Wrap new run creation in a transaction for atomicity
        await db.transaction(async (tx) => {
          await tx.insert(swarmRuns).values({
            projectId: input.projectId, userId: ctx.user.id,
            userPrompt: input.prompt, status: "running",
            isTestRun: input.isTestRun ?? false,
          });
          const [run] = await tx.select().from(swarmRuns)
            .where(eq(swarmRuns.userId, ctx.user.id))
            .orderBy(desc(swarmRuns.id)).limit(1);
          swarmRunId = run.id;
        });
      }

      // ─── Persist worker rehydration payload, then enqueue ───
      // The pipeline runs in the swarm worker (F0.5); this request returns
      // immediately and progress streams via SSE exactly as before.
      const runParams: SwarmRunParams = {
        source: "execute",
        prompt: input.prompt,
        memoryMode: input.memoryMode ?? "balanced",
        attachments: input.attachments,
        includeProjectFiles: input.includeProjectFiles,
        isTestRun: input.isTestRun,
        autoApprove: input.isTestRun ? true : input.autoApprove,
        clientTraceId: input.clientTraceId,
      };
      if (input.chain) {
        runParams.chain = {
          targetProjectId: input.chain.targetProjectId,
          inputTemplate: input.chain.inputTemplate,
          depth: 0,
          lineage: [swarmRunId],
        };
      }
      if (input.giteeToken) {
        runParams.giteeTokenEnc = encrypt(input.giteeToken, getMasterKey()).encrypted;
      }
      await db.update(swarmRuns).set({ runParams }).where(eq(swarmRuns.id, swarmRunId));

      const jobId = await enqueueSwarmRun(swarmRunId, ctx.user.id);
      logger.info(`[EXECUTE-QUEUED] run=${swarmRunId} job=${jobId}`);

      return { swarmRunId, status: "started" as const };
    }),

  /**
   * Resume a paused pipeline (after approval)
   */
  resumePipeline: authedQuery
    .input(z.object({
      runId: z.number(),
      giteeToken: z.string().optional(),
      memoryMode: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const rl = await checkRateLimitAsync(`execute:${ctx.user.id}`, RATE_LIMITS.execute);
      if (!rl.allowed) {
        throw new Error(`Too many executions. Try again in ${Math.ceil(rl.retryAfterMs / 1000)}s.`);
      }
      const db = getDb();

      const [run] = await db.select().from(swarmRuns)
        .where(eq(swarmRuns.id, input.runId)).limit(1);
      // Was fetched by id with no owner check, then re-queued: a stranger could
      // resume another user's run. Scoped to the run's owner (§8.1, A12).
      if (!run || run.userId !== ctx.user.id) throw new Error("Run not found");
      assertRunControlAllowed(run);

      const [project] = await db.select().from(projects)
        .where(eq(projects.id, run.projectId)).limit(1);
      if (!project) throw new Error("Project not found");

      if (!run.executionState) throw new Error("No execution state to resume");

      // Persist rehydration payload and re-enqueue; the worker rebuilds the
      // resume context (state, Gitee config, enriched builder prompt) from the DB.
      const runParams: SwarmRunParams = {
        source: "resumePipeline",
        prompt: run.userPrompt ?? "",
        memoryMode: input.memoryMode ?? "balanced",
        includeProjectFiles: true,
        clientTraceId: `resume-${Date.now()}`,
      };
      if (input.giteeToken) {
        runParams.giteeTokenEnc = encrypt(input.giteeToken, getMasterKey()).encrypted;
      }

      await db.update(swarmRuns)
        .set({ status: "running", startedAt: new Date(), runParams })
        .where(eq(swarmRuns.id, input.runId));

      const jobId = await enqueueSwarmRun(input.runId, ctx.user.id);
      logger.info(`[RESUME-QUEUED] run=${input.runId} job=${jobId}`);

      return { swarmRunId: input.runId, status: "resumed" as const };
    }),

  // ─── Approve a paused pipeline step ───
  approveStep: authedQuery
    .input(ApproveStepSchema)
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [run] = await db.select().from(swarmRuns)
        .where(and(eq(swarmRuns.id, input.runId), eq(swarmRuns.userId, ctx.user.id)));
      if (!run) throw new Error("Run not found");
      assertRunControlAllowed(run);
      if (!run.executionState) throw new Error("No pending approval for this run");

      // Update execution state with the approval action
      const execState = run.executionState as NonNullable<typeof run.executionState>;
      execState.pendingApproval = {
        stepOrder: execState.pendingApproval?.stepOrder ?? 0,
        lastOutput: execState.pendingApproval?.lastOutput ?? "",
        action: input.action,
        instructions: input.instructions,
      };

      await db.update(swarmRuns)
        .set({ executionState: execState })
        .where(eq(swarmRuns.id, input.runId));

      // Re-enqueue so the worker resumes the run with the recorded decision.
      // The frontend also calls execute(runId) afterwards; the worker's
      // per-run claim makes the double enqueue safe (second job no-ops).
      try {
        await enqueueSwarmRun(input.runId, ctx.user.id);
      } catch (err) {
        logger.error("[approveStep] Failed to enqueue resume job", { runId: input.runId, error: (err as Error).message });
      }

      return { success: true, action: input.action };
    }),

  // ─── Auto Design: LLM generates agents + pipeline ─────────────────
  autoDesign: authedQuery
    .input(AutoDesignSchema)
    .mutation(async ({ input, ctx }) =>
      runAutoDesign(ctx.user.id, input.projectId, input.task, input.providerId),
    ),

  cancelRun: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      logger.warn("[CANCEL-AUDIT] User cancelling run", { userId: ctx.user.id, runId: input.id, at: new Date().toISOString() });
      logger.warn("[CANCEL-AUDIT] Stack trace", { stack: new Error("cancel trace").stack });

      await getDb().update(swarmRuns)
        .set({ status: "cancelled" })
        .where(and(eq(swarmRuns.id, input.id), eq(swarmRuns.userId, ctx.user.id)));
      return { success: true };
    }),

  getRun: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input, ctx }) => {
      const [run] = await getDb().select().from(swarmRuns)
        .where(and(eq(swarmRuns.id, input.id), eq(swarmRuns.userId, ctx.user.id)));
      return run ?? null;
    }),

  listRuns: authedQuery
    .input(z.object({ projectId: z.number(), limit: z.number().default(20) }))
    .query(async ({ input, ctx }) => {
      return getDb().select().from(swarmRuns)
        .where(and(eq(swarmRuns.projectId, input.projectId), eq(swarmRuns.userId, ctx.user.id)))
        .orderBy(desc(swarmRuns.startedAt))
        .limit(input.limit);
    }),

  // ─── Get latest run status for a project (for mount-time recovery) ──
  getRunStatus: authedQuery
    .input(z.object({ projectId: z.number() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      const [run] = await db.select().from(swarmRuns)
        .where(and(eq(swarmRuns.projectId, input.projectId), eq(swarmRuns.userId, ctx.user.id)))
        .orderBy(desc(swarmRuns.startedAt))
        .limit(1);
      if (!run) return { hasActiveRun: false };

      const isActuallyRunning = run.status === "running";
      const execState = run.executionState as unknown as Record<string, unknown> | null;
      const isAwaitingApproval = isActuallyRunning
        && !!execState
        && execState.pendingApproval !== undefined;

      // Staleness check: a run stuck in "running" for >30 min without activity
      // is likely dead (server crash, lost SSE). Report it as not running to
      // prevent ghost spinners and stale HITL banners.
      // Exception: runs genuinely awaiting human approval can stay pending indefinitely.
      let isRunning = isActuallyRunning;
      if (isActuallyRunning && !isAwaitingApproval) {
        const lastActivity = run.completedAt ?? run.startedAt ?? new Date();
        const minutesSinceActivity = (Date.now() - new Date(lastActivity).getTime()) / 60_000;
        if (minutesSinceActivity > 30) {
          isRunning = false;
        }
      }

      return {
        hasActiveRun: isRunning || isAwaitingApproval,
        runId: run.id,
        status: run.status,
        isRunning,
        isAwaitingApproval,
        lastOutput: isAwaitingApproval
          ? ((execState as Record<string, Record<string, string>>)?.pendingApproval?.lastOutput ?? "")
          : "",
      };
    }),

  // ─── Single Agent Execution (Direct LLM call, no pipeline) ───────
  // For quick tasks where running a full pipeline is wasteful.
  // Uses project's default provider or specified provider.
  executeAgent: authedQuery
    .input(
      z.object({
        projectId: z.number(),
        prompt: z.string().min(1),
        attachments: z.array(z.any()).optional(),
        providerId: z.number().optional(), // Override provider
        model: z.string().optional(), // Override model
        systemPrompt: z.string().optional(), // Custom system prompt
        includeProjectFiles: z.boolean().optional(), // Include project files in context
        conversationHistory: z.array(
          z.object({ role: z.enum(["user", "assistant"]), content: z.string() })
        ).max(20).optional(), // Last N messages for conversation context
      })
    )
    .mutation(async ({ input, ctx }) => {
      const rl = await checkRateLimitAsync(`execute:${ctx.user.id}`, RATE_LIMITS.execute);
      if (!rl.allowed) {
        throw new Error(`Too many executions. Try again in ${Math.ceil(rl.retryAfterMs / 1000)}s.`);
      }
      const hasAccess = await canAccessProject(ctx.user.id, input.projectId);
      if (!hasAccess) throw new Error("Project not found");

      const db = getDb();

      // Get project
      const [project] = await db.select().from(projects)
        .where(eq(projects.id, input.projectId)).limit(1);
      if (!project) throw new Error("Project not found");

      // Resolve provider: explicit > project default > user's first provider
      let resolvedProviderId = input.providerId ?? project.defaultProviderId;

      if (!resolvedProviderId) {
        // Fallback: use the user's first available provider
        const [firstProv] = await db.select().from(llmProviders)
          .where(eq(llmProviders.userId, ctx.user.id))
          .limit(1);
        if (!firstProv) throw new Error("No LLM providers configured. Please add a provider in Settings > LLM Providers.");
        resolvedProviderId = firstProv.id;
      }

      let [prov] = await db.select().from(llmProviders)
        .where(and(eq(llmProviders.id, resolvedProviderId), eq(llmProviders.userId, ctx.user.id)));

      // If not found (a stale or foreign provider id on the project), fall back
      // to the calling user's own first available provider — never another account's.
      if (!prov) {
        logger.info("[executeAgent] Provider not found for user, falling back to user's first provider", { providerId: resolvedProviderId, userId: ctx.user.id });
        const [fp] = await db.select().from(llmProviders).where(eq(llmProviders.userId, ctx.user.id)).limit(1);
        if (!fp) throw new Error("No LLM provider configured. Add one in Settings first.");
        prov = fp;
      }

      const apiKey = decryptApiKey(prov.apiKeyRef);
      const adapter = createProviderAdapter(prov.slug, apiKey, prov.baseUrl, prov.defaultModel);

      // Build context from project files if requested
      let userPrompt = input.prompt;
      if (input.includeProjectFiles) {
        // 1. Try Intelligence Card first (new system)
        const [projectWithCard] = await db
          .select()
          .from(projects)
          .where(eq(projects.id, input.projectId))
          .limit(1);

        if (projectWithCard?.intelligenceCard) {
          const card = projectWithCard.intelligenceCard;
          const cardContext = [
            "═══ PROJECT CONTEXT (Intelligence Card) ═══",
            `Type: ${card.projectType} | Language: ${card.primaryLanguage} | Framework: ${card.framework}`,
            `Files: ${card.totalFiles} | Architecture: ${card.architecture}`,
            "",
            "┌─ FILE TREE",
            ...card.fileTree.slice(0, 50).map((f) =>
              ` ${f.isEntryPoint ? "▶" : " "} ${f.path} [${f.language}]${f.exports.length > 0 ? ` (${f.exports.length} exports)` : ""}`
            ),
            ...(card.fileTree.length > 50 ? [`... and ${card.fileTree.length - 50} more files`] : []),
            "",
            ...(card.databaseTables.length > 0 ? [
              "┌─ DATABASE SCHEMA",
              ...card.databaseTables.map((t) =>
                ` ${t.name}: ${t.columns.map((c) => `${c.name}(${c.type})`).join(", ")}`
              ),
              "",
            ] : []),
            ...(card.apiEndpoints.length > 0 ? [
              "┌─ API ROUTES",
              ...card.apiEndpoints.map((r) => ` ${r.method} ${r.path}`),
              "",
            ] : []),
            ...(card.todos.length > 0 ? [
              "┌─ TODOs",
              ...card.todos.map((t) => ` • ${t}`),
              "",
            ] : []),
            "═══ END PROJECT CONTEXT ═══",
          ].join("\n");

          userPrompt = `${cardContext}\n\n---\n\nUser request: ${input.prompt}`;
        } else {
          // 2. Fallback: read files from disk (Hybrid Architecture)
          const { listProjectFiles, readProjectFile } = await import("../services/projectFilesDisk");
          const filePaths = await listProjectFiles(input.projectId);

          if (filePaths.length > 0) {
            const files: Array<{ path: string; content: string }> = [];
            for (const filePath of filePaths.slice(0, 20)) {
              const content = await readProjectFile(input.projectId, filePath);
              if (content !== null) files.push({ path: filePath, content });
            }

            if (files.length > 0) {
              const fileContext = files.map((f) =>
                `--- FILE: ${f.path} ---\n${f.content.slice(0, 5000)}\n--- END FILE ---`
              ).join("\n\n");
              userPrompt = `${fileContext}\n\nUser request: ${input.prompt}`;
            }
          }
        }
      }

      // Build multimodal content if attachments present
      let userContent: string | Array<{ type: string; text?: string; image_url?: { url: string } }> = userPrompt;

      if (input.attachments && input.attachments.length > 0) {
        const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
          { type: "text", text: userPrompt },
        ];
        for (const att of input.attachments) {
          if (att.type?.startsWith("image/") && att.dataUrl) {
            parts.push({ type: "image_url", image_url: { url: att.dataUrl } });
          } else if (att.textContent) {
            parts.push({ type: "text", text: `\n\n--- File: ${att.name} ---\n${att.textContent}\n--- End of ${att.name} ---` });
          } else if (att.dataUrl) {
            // PDFs and other files: include a reference (models that support document input can use the data URL)
            parts.push({ type: "text", text: `\n\n[File attached: ${att.name} (${att.type}, ${(att.size / 1024).toFixed(1)}KB)]` });
          }
        }
        userContent = parts;
      }

      // System prompt
      const systemPrompt = input.systemPrompt
        ?? `You are a helpful assistant working on the project "${project.name}". Be concise and actionable.`;

      const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        // Inject conversation history so the agent is aware of previous exchanges
        ...(input.conversationHistory ?? []).map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
        { role: "user", content: userContent },
      ];

      const startTime = Date.now();
      const result = await callWithRetry(
        () => adapter.chat(messages, {
          model: input.model ?? prov.defaultModel,
          temperature: 0.7,
          maxTokens: 4096,
        }),
        { maxRetries: 3, label: "AgentDirect" },
      );
      const latency = Date.now() - startTime;

      return {
        content: result.content,
        model: input.model ?? prov.defaultModel,
        provider: prov.slug,
        tokensUsed: result.usage?.totalTokens ?? 0,
        latencyMs: latency,
      };
    }),

});
