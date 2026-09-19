#!/usr/bin/env python3
"""
Phase 1 patch script: add batch endpoints to swarm router and wire batch progress in swarmService.
"""
import re

# ─── 1. Patch api/routers/swarm.ts ───
with open("api/routers/swarm.ts", "r") as f:
    router = f.read()

# Add imports
old_imports = '''import { enqueueSwarmRun } from "../workers/swarmWorker";
import { runAutoDesign } from "../services/autoDesignService";'''
new_imports = '''import { enqueueSwarmRun } from "../workers/swarmWorker";
import { runAutoDesign } from "../services/autoDesignService";
import { createBatch, getBatchStatus, listBatches, cancelBatch } from "../services/batchService";
import { isFeatureEnabled } from "../plugins/featureFlags";'''
router = router.replace(old_imports, new_imports)

# Find the closing of the router object (before the final `});`)
# We want to insert the batch endpoints before the final closing.
# The router ends with:
#     executeAgent: authedQuery
#       ...
#     }),
# });
# Let's find the last `});` that closes the router.

# Find the executeAgent block end and the router close
old_router_end = '''  // ─── Single Agent Execution (Direct LLM call, no pipeline) ───────
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
    .mutation(async ({ input, ctx }) => {'''

# Actually, it's easier to just append before the final `});`
# Find the last occurrence of `});` that closes the router
last_router_close = router.rfind("});\n")
if last_router_close == -1:
    raise ValueError("Could not find router closing")

# We need to insert before the last `});`
batch_endpoints = '''
  // ═══════════════════════════════════════════════════════════════════
  //  BATCH OPERATIONS (Research Mode)
  // ═══════════════════════════════════════════════════════════════════

  runBatch: authedQuery
    .input(
      z.object({
        projectId: z.number(),
        name: z.string().optional(),
        inputs: z.array(z.string().min(1).max(20000)).min(1).max(100),
        templateId: z.number().optional(),
        chain: z.object({
          targetProjectId: z.number(),
          inputTemplate: z.string().optional(),
        }).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const batchFlag = await isFeatureEnabled("batch_mode", ctx.user.id);
      if (!batchFlag) throw new Error("Batch mode is not enabled");

      const rl = await checkRateLimitAsync(`batch:${ctx.user.id}`, RATE_LIMITS.batch);
      if (!rl.allowed) {
        throw new Error(`Too many batch submissions. Try again in ${Math.ceil(rl.retryAfterMs / 1000)}s.`);
      }

      const hasAccess = await canAccessProject(ctx.user.id, input.projectId);
      if (!hasAccess) throw new Error("Project not found");

      return createBatch({
        projectId: input.projectId,
        userId: ctx.user.id,
        name: input.name,
        inputs: input.inputs,
        templateId: input.templateId,
        chain: input.chain,
      });
    }),

  getBatchStatus: authedQuery
    .input(z.object({ batchId: z.number() }))
    .query(async ({ input, ctx }) => {
      const batchFlag = await isFeatureEnabled("batch_mode", ctx.user.id);
      if (!batchFlag) throw new Error("Batch mode is not enabled");

      const status = await getBatchStatus(input.batchId, ctx.user.id);
      if (!status) throw new Error("Batch not found");
      return status;
    }),

  listBatches: authedQuery
    .input(z.object({ limit: z.number().default(20) }))
    .query(async ({ input, ctx }) => {
      const batchFlag = await isFeatureEnabled("batch_mode", ctx.user.id);
      if (!batchFlag) throw new Error("Batch mode is not enabled");

      return listBatches(ctx.user.id, input.limit);
    }),

  cancelBatch: authedQuery
    .input(z.object({ batchId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const batchFlag = await isFeatureEnabled("batch_mode", ctx.user.id);
      if (!batchFlag) throw new Error("Batch mode is not enabled");

      await cancelBatch(input.batchId, ctx.user.id);
      return { success: true };
    }),

'''

router = router[:last_router_close] + batch_endpoints + router[last_router_close:]

with open("api/routers/swarm.ts", "w") as f:
    f.write(router)

print("Patched api/routers/swarm.ts")

# ─── 2. Patch api/services/swarmService.ts ───
with open("api/services/swarmService.ts", "r") as f:
    svc = f.read()

# Add import for incrementBatchProgress
old_svc_imports = '''import { getMasterKey, decrypt } from "./cryptoService";
import { emitEvent } from "./eventBus";'''
new_svc_imports = '''import { getMasterKey, decrypt } from "./cryptoService";
import { emitEvent } from "./eventBus";
import { incrementBatchProgress } from "./batchService";'''
svc = svc.replace(old_svc_imports, new_svc_imports)

# Add batchId to runPipelineAsync opts signature
old_runPipelineAsync_sig = '''async function runPipelineAsync(opts: {
  db: ReturnType<typeof getDb>;
  ctx: { user: { id: number } };
  input: { projectId: number; prompt: string; giteeToken?: string; memoryMode?: string; attachments?: ChatAttachment[]; includeProjectFiles?: boolean; clientTraceId?: string };
  swarmRunId: number;
  project: typeof projects.$inferSelect;
  projectId: number;
  projectName: string;
  giteeConfig: { token: string; owner: string; repo: string; branch: string; basePath: string; promptNum: string } | null;
  memoryMode: MemoryMode;
  useLegacy: boolean;
  legacyAgents: typeof agents.$inferSelect[];
  pipeline: ResolvedStep[] | null;
  builderPrompt: string;
  state: ProjectState | null;
  episodes: Episode[];
  execCtx: ExecCtx;
  autoApprove?: boolean;
}) {'''
new_runPipelineAsync_sig = '''async function runPipelineAsync(opts: {
  db: ReturnType<typeof getDb>;
  ctx: { user: { id: number } };
  input: { projectId: number; prompt: string; giteeToken?: string; memoryMode?: string; attachments?: ChatAttachment[]; includeProjectFiles?: boolean; clientTraceId?: string };
  swarmRunId: number;
  project: typeof projects.$inferSelect;
  projectId: number;
  projectName: string;
  giteeConfig: { token: string; owner: string; repo: string; branch: string; basePath: string; promptNum: string } | null;
  memoryMode: MemoryMode;
  useLegacy: boolean;
  legacyAgents: typeof agents.$inferSelect[];
  pipeline: ResolvedStep[] | null;
  builderPrompt: string;
  state: ProjectState | null;
  episodes: Episode[];
  execCtx: ExecCtx;
  autoApprove?: boolean;
  batchId?: number;
}) {'''
svc = svc.replace(old_runPipelineAsync_sig, new_runPipelineAsync_sig)

# Destructure batchId in runPipelineAsync body
old_destructure = '''  const { db, ctx, input, swarmRunId, project, giteeConfig, memoryMode, useLegacy, legacyAgents, pipeline, builderPrompt, state, episodes, execCtx, autoApprove } = opts;'''
new_destructure = '''  const { db, ctx, input, swarmRunId, project, giteeConfig, memoryMode, useLegacy, legacyAgents, pipeline, builderPrompt, state, episodes, execCtx, autoApprove, batchId } = opts;'''
svc = svc.replace(old_destructure, new_destructure)

# Wire batch progress at completion (after logger.info success line)
old_completion = '''    logger.info(`[PIPELINE-ASYNC] Run ${swarmRunId} completed successfully`);

  } catch (err) {'''
new_completion = '''    logger.info(`[PIPELINE-ASYNC] Run ${swarmRunId} completed successfully`);

    // ─── Batch progress accounting ───
    if (batchId) {
      try {
        await incrementBatchProgress(batchId, { completed: 1, tokens: totalTokens.value });
      } catch (batchErr) {
        logger.error("[PIPELINE-ASYNC] Batch progress update failed", { batchId, error: (batchErr as Error).message });
      }
    }

  } catch (err) {'''
svc = svc.replace(old_completion, new_completion)

# Wire batch progress at failure (before the emitEvent in catch block)
old_failure = '''    emitEvent(swarmRunId, {
      type: "pipeline_error",
      error: errorMsg,
      timestamp: new Date().toISOString(),
    });'''
new_failure = '''    // ─── Batch progress accounting ───
    if (batchId) {
      try {
        await incrementBatchProgress(batchId, { failed: 1, tokens: totalTokens.value });
      } catch (batchErr) {
        logger.error("[PIPELINE-ASYNC] Batch progress update failed", { batchId, error: (batchErr as Error).message });
      }
    }

    emitEvent(swarmRunId, {
      type: "pipeline_error",
      error: errorMsg,
      timestamp: new Date().toISOString(),
    });'''
svc = svc.replace(old_failure, new_failure)

# Pass batchId from runExecutePipeline call
old_runExecute_call = '''  await runPipelineAsync({
    db, ctx,
    input: {
      projectId: run.projectId,
      prompt: effectivePrompt,
      giteeToken,
      memoryMode,
      attachments: params.attachments,
      includeProjectFiles: params.includeProjectFiles,
      clientTraceId: params.clientTraceId,
    },
    swarmRunId, project: projectWithUserDefault, projectId: run.projectId, projectName: project.name,
    giteeConfig, memoryMode, useLegacy, legacyAgents, pipeline, builderPrompt, state, episodes,
    execCtx,
    autoApprove,
  });'''
new_runExecute_call = '''  await runPipelineAsync({
    db, ctx,
    input: {
      projectId: run.projectId,
      prompt: effectivePrompt,
      giteeToken,
      memoryMode,
      attachments: params.attachments,
      includeProjectFiles: params.includeProjectFiles,
      clientTraceId: params.clientTraceId,
    },
    swarmRunId, project: projectWithUserDefault, projectId: run.projectId, projectName: project.name,
    giteeConfig, memoryMode, useLegacy, legacyAgents, pipeline, builderPrompt, state, episodes,
    execCtx,
    autoApprove,
    batchId: run.batchId ?? undefined,
  });'''
svc = svc.replace(old_runExecute_call, new_runExecute_call)

# Pass batchId from runResumedPipeline call
old_runResumed_call = '''  await runPipelineAsync({
    db, ctx,
    input: { projectId: project.id, prompt: run.userPrompt ?? "", giteeToken, memoryMode, attachments: undefined, includeProjectFiles: true, clientTraceId: `resume-${Date.now()}` },
    swarmRunId, project, projectId: project.id, projectName: project.name,
    giteeConfig, memoryMode, useLegacy: false, legacyAgents: [], pipeline,
    builderPrompt: resumeBuilderPrompt, state, episodes, execCtx,
  });'''
new_runResumed_call = '''  await runPipelineAsync({
    db, ctx,
    input: { projectId: project.id, prompt: run.userPrompt ?? "", giteeToken, memoryMode, attachments: undefined, includeProjectFiles: true, clientTraceId: `resume-${Date.now()}` },
    swarmRunId, project, projectId: project.id, projectName: project.name,
    giteeConfig, memoryMode, useLegacy: false, legacyAgents: [], pipeline,
    builderPrompt: resumeBuilderPrompt, state, episodes, execCtx,
    batchId: run.batchId ?? undefined,
  });'''
svc = svc.replace(old_runResumed_call, new_runResumed_call)

with open("api/services/swarmService.ts", "w") as f:
    f.write(svc)

print("Patched api/services/swarmService.ts")
