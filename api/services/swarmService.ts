// ═══════════════════════════════════════════════════════════════════
//  SWARM SERVICE — pipeline execution engine (F0.5)
// ═══════════════════════════════════════════════════════════════════
// The execution loop that used to live inside the `execute` tRPC mutation
// now lives here so it can run inside a queue worker (api/workers/swarmWorker.ts).
// The worker job payload is just { swarmRunId, userId } — everything else is
// rehydrated from the DB (swarm_runs.run_params + execution_state), which is
// what makes runs resumable after a crash/deploy.
//
// Logic was moved verbatim from api/routers/swarm.ts; only logging changed
// (console.* → logger).

import { getDb } from "../queries/connection";
import {
  swarmRuns, agentRuns, agentResponses, agents, llmProviders,
  projects, pipelineSteps, customAgents, users, notifications, swarmBatches,
} from "@db/schema";
import { eq, and, or, desc, asc, sql, inArray, isNull } from "drizzle-orm";
import type { ChatMessage, ChatAttachment, ContentPart } from "@contracts/index";
import { createProviderAdapter } from "../lib/providers";
import { getMasterKey, decrypt } from "./cryptoService";
import { emitEvent } from "./eventBus";
import { incrementBatchProgress } from "./batchService";
import { logger } from "../lib/logger";

/** Parse Retry-After (seconds) from provider error message. */
function parseRetryAfter(msg: string): number | undefined {
  const m = msg.match(/\[retry-after:(\d+)\]/);
  if (m) return parseInt(m[1], 10) * 1000;
  return undefined;
}

/** Truncate error messages for DB storage: keep head and tail. */
const safeError = (msg: string) =>
  msg.length > 2000 ? `${msg.slice(0, 1000)} …[truncated]… ${msg.slice(-1000)}` : msg;
import { getRedis } from "../infra/redis";
import { INSTANCE_ID } from "../infra/pubsub";
import { acquireProviderSlot, reportProviderResult } from "../lib/providerThrottle";

import {
  updateStateWithSession,
  serializeStateToMarkdown,
  parseStateFromMarkdown,
  buildBuilderPrompt,
  triggerCompressionIfNeeded,
  type ProjectState,
  type MemoryMode,
} from "./stateSummarizer";

import {
  retrieveEpisodes, createEpisode, rotateEpisodes,
  serializeEpisodes,
  parseEpisodes,
  type Episode,
} from "./memoryManager";

import {
  createOrUpdateFile, validateToken, listRepos,
  createRepo,
  getFileContent,
} from "./giteeService";

// ─── Persisted worker rehydration payload (swarm_runs.run_params) ───
export interface SwarmRunParams {
  source: "execute" | "resumePipeline";
  prompt: string;
  giteeTokenEnc?: string;
  memoryMode?: string;
  attachments?: ChatAttachment[];
  includeProjectFiles?: boolean;
  isTestRun?: boolean;
  autoApprove?: boolean;
  clientTraceId?: string;
  // Research Mode (batch + chaining)
  batchId?: number;
  stateless?: boolean;
  chain?: {
    targetProjectId: number;
    inputTemplate?: string;
    depth: number;
    lineage: number[];
  };
  // Offering redesign v2: immutable workflow-version snapshot to execute
  // instead of the mutable project steps (benchmark candidates, protected
  // runs). The steps are loaded from pipeline_versions at execution time.
  snapshotVersionId?: number;
  callPlanId?: number;
  /** §8.1: present when the snapshot belongs to ANOTHER user (a marketplace
   *  buyer running a seller's published version). Execution is authorized
   *  through this context and re-checked against current rows, never through
   *  ownership of the version. */
  protectedRun?: import("./marketplaceExecutionService").ProtectedRunParams;
  /** A per-account pipeline share (api/services/pipelineSharing.ts): the
   *  recipient running the grantor's workflow. Authorized the same way — the
   *  grant row is re-read at dispatch, never trusted from this blob — and a
   *  `run_only` grant is redacted exactly like a protected buyer run. */
  sharedRun?: import("./runAccess").SharedRunAccessParams;
}

export function decryptApiKey(encryptedRef: string): string {
  return decrypt(encryptedRef, getMasterKey());
}

// ─── Convert attachments to multimodal content parts ──────────────
// Supports images (data URLs) and text files. Returns array of content parts
// for vision-capable models (OpenAI, Kimi, Qwen, GPT-4o, etc.).
function buildMultimodalContent(text: string, attachments?: ChatAttachment[]): string | ContentPart[] {
  if (!attachments || attachments.length === 0) return text;

  const parts: ContentPart[] = [{ type: "text", text }];

  for (const att of attachments) {
    // Images: include as image_url with data URL
    if (att.type.startsWith("image/") && att.dataUrl) {
      parts.push({
        type: "image_url",
        image_url: { url: att.dataUrl, detail: "auto" },
      });
    }
    // Text files: append content as text
    else if (att.textContent) {
      parts.push({
        type: "text",
        text: `\n\n--- File: ${att.name} ---\n${att.textContent}\n--- End of ${att.name} ---`,
      });
    }
    // Other files with data URL (PDFs etc.)
    else if (att.dataUrl) {
      parts.push({
        type: "text",
        text: `\n\n[File attached: ${att.name} (${att.type}, ${(att.size / 1024).toFixed(1)}KB)]`,
      });
    }
  }

  return parts;
}

// ─── Credit-exhausted error (special handling: don't retry) ──────
class CreditExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreditExhaustedError";
  }
}
class ProviderThrottledError extends Error {
  retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`Provider throttled, retry after ${retryAfterMs}ms`);
    this.name = "ProviderThrottledError";
    this.retryAfterMs = retryAfterMs;
  }
}
class RunThrottledError extends Error {
  retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`Run throttled, retry after ${retryAfterMs}ms`);
    this.name = "RunThrottledError";
    this.retryAfterMs = retryAfterMs;
  }
}

class BatchPausedError extends Error {
  reason: "credit" | "outage";
  constructor(reason: "credit" | "outage") {
    super(`Batch paused: ${reason}`);
    this.name = "BatchPausedError";
    this.reason = reason;
  }
}

// Genuine account/billing problems → pause batch, user must top up. NOT retryable.
const CREDIT_ERROR_PATTERNS = [
  /insufficient_quota/i, /quota_exceeded/i, /exceeded.*quota/i,
  /billing.*disabled/i, /payment.*required/i, /402/,
  /credit/i, /balance/i, /account.*deactivated/i,
];

// Transient provider throttling → retry, then requeue. NEVER pauses the batch.
const RATE_LIMIT_PATTERNS = [
  /429/, /rate.?limit/i, /too.*many.*requests/i, /throttl/i, /limit.*exceeded/i,
];

function isCreditError(msg: string): boolean {
  return CREDIT_ERROR_PATTERNS.some((p) => p.test(msg));
}
function isRateLimitError(msg: string): boolean {
  return RATE_LIMIT_PATTERNS.some((p) => p.test(msg));
}

// ─── Retry wrapper for LLM API calls ──────────────────────────────
// Credit errors: throw immediately (user must add credit).
// Other errors: retry up to maxRetries with exponential backoff (1s, 2s, 4s).
export async function callWithRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; label?: string } = {},
): Promise<T> {
  const { maxRetries = 3, label = "API" } = options;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err as Error;
      if (isCreditError(lastErr.message)) {
        throw new CreditExhaustedError(`API credit exhausted: ${lastErr.message}. Please add credit and retry.`);
      }
      if (isRateLimitError(lastErr.message)) {
        // Rate-limits are transient: keep retrying with exponential backoff.
        if (attempt === maxRetries) break;
        const delay = 1000 * Math.pow(2, attempt);
        logger.warn(`[${label}] Attempt ${attempt + 1} rate-limited: ${lastErr.message}. Retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      if (attempt === maxRetries) break;
      const delay = 1000 * Math.pow(2, attempt);
      logger.warn(`[${label}] Attempt ${attempt + 1} failed: ${lastErr.message}. Retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // Retries exhausted: a rate-limit is transient saturation → requeue via the
  // throttle path (do NOT pause the batch). Anything else fails the run as before.
  if (lastErr && isRateLimitError(lastErr.message)) {
    const retryAfterMs = parseRetryAfter(lastErr.message) ?? 5000;
    throw new ProviderThrottledError(retryAfterMs);
  }
  throw lastErr ?? new Error(`${label} failed after ${maxRetries + 1} attempts`);
}

function getResponseTypeForRole(role: string): string {
  switch (role) {
    case "builder": return "raw";
    case "critic": return "feedback";
    case "refiner": return "corrected";
    case "polisher": return "final";
    default: return "intermediate";
  }
}

// ─── Resolved pipeline step (all types) ────────────────────────────
export interface ResolvedStep {
  stepId: number;
  stepOrder: number;
  name: string;
  role: string;
  systemPrompt: string;
  providerId: number | null;
  model: string | null;
  temperature: string;
  maxTokens: number;
  agentId: number | null;
  stepType: string;
  ifConfig: { options: string[]; mappings: Record<string, number> } | null;
  whileConfig: { targetStep: number; maxIterations: number } | null;
}

// ─── In-memory execution context ───────────────────────────────────
const MAX_STEP_VISITS = 1000; // Hard cap: any step visited more than this forces advance
const MAX_WHILE_ITERATIONS = 3; // Hard cap for WHILE loops regardless of DB config

/**
 * The three `agent_runs` columns that carry prompt text.
 *
 * For an ordinary run they hold a 200-char summary, which is what the owner's
 * history/debug screens read. On a PROTECTED run the same rows are written
 * under the BUYER's project — so a summary of the seller's system prompt would
 * be reachable by anyone entitled to read that run (export, history, debug). §8.1 forbids that, so nothing of the definition is persisted
 * on a protected run at all: the columns record only that a step ran, with its
 * length. Redacting at the write beats filtering at every read, because a read
 * path added next month inherits the protection automatically.
 */
export function stepPromptAuditFields(fields: {
  systemPrompt: string;
  userPromptText: string;
  contextData: string | null;
  restricted?: boolean;
}): { systemPrompt: string | null; userPrompt: string; contextInput: string | null } {
  if (fields.restricted) {
    return {
      systemPrompt: fields.systemPrompt
        ? `[protected: ${fields.systemPrompt.length.toLocaleString()} chars, not stored]`
        : null,
      userPrompt: `[protected: ${fields.userPromptText.length.toLocaleString()} chars, not stored]`,
      contextInput: null,
    };
  }
  const fileCount = (fields.userPromptText.match(/=== FILE:/g) || []).length;
  return {
    systemPrompt: fields.systemPrompt
      ? `[${fields.systemPrompt.length.toLocaleString()} chars] ${fields.systemPrompt.substring(0, 200).replace(/\n/g, " ")}`
      : null,
    userPrompt: `[${fields.userPromptText.length.toLocaleString()} chars${fileCount > 0 ? `, ${fileCount} files` : ""}] ${fields.userPromptText.substring(0, 200).replace(/\n/g, " ")}`,
    contextInput: fields.contextData,
  };
}

/** A provider error can quote the request it rejected, and on a protected run
 *  that request IS the seller's workflow. The stream therefore carries a fixed
 *  notice instead; `marketplaceExecution.get` classifies the stored error into
 *  a category so the buyer still learns why it failed (§8.1, A12). */
const PROTECTED_ERROR_NOTICE =
  "protected_run_error: the provider's message is withheld on a protected run because it can quote the seller's workflow. Read marketplaceExecution.get for the failure category.";

interface ExecCtx {
  currentIndex: number;        // Position in pipeline array
  chain: typeof agentResponses.$inferSelect[];
  iterationCounts: Map<number, number>; // stepIndex -> count (for WHILE)
  visitCounts: Map<number, number>;     // stepIndex -> total visits (for all loop types)
  modifyInstructions?: string; // For "modify" approval action
  pendingApproval?: { stepOrder: number; lastOutput: string; action?: string; instructions?: string }; // Human-in-the-loop state
}

function makeFreshCtx(): ExecCtx {
  return { currentIndex: 0, chain: [], iterationCounts: new Map(), visitCounts: new Map() };
}

function serializeCtx(ctx: ExecCtx) {
  const state: Record<string, unknown> = {
    currentIndex: ctx.currentIndex,
    chain: ctx.chain.map((r) => ({ id: r.id, content: r.content, agentRole: r.metadata.agentRole, agentName: r.metadata.agentName })),
    iterationCounts: Object.fromEntries(ctx.iterationCounts),
    visitCounts: Object.fromEntries(ctx.visitCounts),
    modifyInstructions: ctx.modifyInstructions,
  };
  if (ctx.pendingApproval) state.pendingApproval = ctx.pendingApproval;
  return state as unknown as typeof swarmRuns.$inferSelect.executionState;
}

function deserializeCtx(raw: NonNullable<typeof swarmRuns.$inferSelect.executionState>): ExecCtx {
  const rawRecord = raw as unknown as Record<string, unknown>;
  const iterObj = (rawRecord.iterationCounts ?? {}) as Record<string, number>;
  const visitObj = (rawRecord.visitCounts ?? {}) as Record<string, number>;
  return {
    currentIndex: raw.currentIndex ?? 0,
    chain: [], // Chain is reloaded from DB responses on resume
    iterationCounts: new Map(Object.entries(iterObj).map(([k, v]) => [parseInt(k), v])),
    visitCounts: new Map(Object.entries(visitObj).map(([k, v]) => [parseInt(k), v])),
    modifyInstructions: rawRecord.modifyInstructions as string | undefined,
    pendingApproval: rawRecord.pendingApproval as ExecCtx["pendingApproval"],
  };
}

// ─── Load pipeline steps from DB ───────────────────────────────────
export async function loadPipelineSteps(
  db: ReturnType<typeof getDb>,
  projectId: number,
): Promise<ResolvedStep[] | null> {
  try {
    const steps = await db
      .select()
      .from(pipelineSteps)
      .where(and(
        eq(pipelineSteps.projectId, projectId),
        or(
          isNull(pipelineSteps.isEnabled),
          eq(pipelineSteps.isEnabled, true),
        ),
      ))
      .orderBy(asc(pipelineSteps.stepOrder));

    logger.debug(`[loadPipelineSteps] project=${projectId}: loaded ${steps.length} steps`);
    if (steps.length === 0) return null;

    // Log each step for audit
    steps.forEach((s) => {
      logger.debug(`[loadPipelineSteps]  step ${s.stepOrder}: name="${s.name}" role="${s.role}" type="${s.stepType}" agentId=${s.agentId}`);
    });

    // Look up agent defaults (provider, model) for agent steps
    const agentIds = steps.map((s) => s.agentId).filter((id): id is number => id != null);
    const agentDefaults = new Map<number, { providerId: number | null; model: string | null }>();
    if (agentIds.length > 0) {
      try {
        const rows = await db
          .select({ id: customAgents.id, providerId: customAgents.defaultProviderId, model: customAgents.defaultModel })
          .from(customAgents)
          .where(inArray(customAgents.id, agentIds));
        for (const a of rows) agentDefaults.set(a.id, { providerId: a.providerId ?? null, model: a.model ?? null });
        logger.debug(`[loadPipelineSteps]  resolved ${rows.length}/${agentIds.length} agent defaults`);
      } catch (agentErr) {
        logger.error("[loadPipelineSteps] Agent lookup failed", { error: (agentErr as Error).message });
      }
    }

    const resolved = steps.map((s) => {
      const defs = s.agentId ? agentDefaults.get(s.agentId) : null;
      return {
        stepId: s.id,
        stepOrder: s.stepOrder,
        name: s.name,
        role: s.role,
        systemPrompt: s.systemPrompt,
        providerId: s.providerId ?? defs?.providerId ?? null,
        model: s.model ?? defs?.model ?? null,
        temperature: s.temperature ?? "0.7",
        maxTokens: s.maxTokens ?? 4096,
        agentId: s.agentId,
        stepType: s.stepType ?? "agent",
        ifConfig: s.ifConfig,
        whileConfig: s.whileConfig,
      };
    });

    logger.debug(`[loadPipelineSteps]  returning ${resolved.length} resolved steps`);
    return resolved;
  } catch (err) {
    logger.error("[loadPipelineSteps] FATAL Error", { error: (err as Error).message });
    return null;
  }
}

// ─── Execute a single agent step ───────────────────────────────────
async function executeAgentStep(opts: {
  db: ReturnType<typeof getDb>;
  ctx: { user: { id: number } };
  swarmRunId: number;
  projectId: number;
  project: { defaultProviderId: number | null };
  stepNum: number;
  agentId?: number | null;
  agentName: string;
  agentRole: string;
  systemPrompt: string;
  providerId: number | null;
  model: string | null;
  temperature: string;
  maxTokens: number;
  userPromptText: string;
  contextData: string | null;
  attachments?: ChatAttachment[];
  parentRespId?: number;
  onTokens: (t: number) => void;
  onLatency: (l: number) => void;
  /** §8.2: protected snapshot run — harden the transport of this call. */
  restricted?: boolean;
  giteeSave?: { token: string; owner: string; repo: string; branch: string; basePath: string; promptNum: string; index: number };
}) {
  const { db, ctx, swarmRunId, projectId, project, stepNum, agentName, agentRole } = opts;
  const { agentId, systemPrompt, providerId, model, temperature, maxTokens, userPromptText, contextData, attachments, parentRespId, onTokens, onLatency, restricted, giteeSave } = opts;

  logger.debug(`[STEP-TRACE] Step ${stepNum} "${agentName}" START`);
  emitEvent(swarmRunId, { type: "step_start", step: stepNum, agentRole, agentName });

  // Store only a summary in DB — full prompt stays in memory for LLM call
  const auditFields = stepPromptAuditFields({ systemPrompt, userPromptText, contextData, restricted });

  await db.insert(agentRuns).values({
    swarmRunId, projectId, agentId: agentId ?? null,
    agentName, agentRole, pipelineStep: stepNum, iteration: 1,
    systemPrompt: auditFields.systemPrompt,
    userPrompt: auditFields.userPrompt,
    contextInput: auditFields.contextInput,
    status: "running",
  });

  const [agentRun] = await db.select().from(agentRuns)
    .where(eq(agentRuns.swarmRunId, swarmRunId))
    .orderBy(desc(agentRuns.id))
    .limit(1);

  let llmResult;
  let resolvedProviderId = providerId ?? project.defaultProviderId;
  let prov: typeof llmProviders.$inferSelect | undefined;

  try {
    logger.debug(`[STEP-TRACE] Step ${stepNum} resolving provider...`);
    // Resolve provider: always the CALLING user's own provider — a stored id
    // that is not theirs is never used (they pay for their own calls, BYOK).
    if (!resolvedProviderId) {
      const [fp] = await db.select().from(llmProviders).where(eq(llmProviders.userId, ctx.user.id)).limit(1);
      if (!fp) throw new Error("No LLM provider configured. Add one in Settings first.");
      resolvedProviderId = fp.id;
    }

    // Try to find the provider belonging to the current user
    let [p] = await db
      .select()
      .from(llmProviders)
      .where(and(eq(llmProviders.id, resolvedProviderId), eq(llmProviders.userId, ctx.user.id)))
      .limit(1);

    // If not found (stale or foreign provider id), fall back to the calling
    // user's own first available provider.
    if (!p) {
      logger.debug(`[STEP-TRACE] Provider ${resolvedProviderId} not found for user ${ctx.user.id}, falling back`);
      const [fp] = await db.select().from(llmProviders).where(eq(llmProviders.userId, ctx.user.id)).limit(1);
      if (!fp) throw new Error("No LLM provider configured. Add one in Settings first.");
      p = fp;
    }
    prov = p;
    const slot = await acquireProviderSlot(prov.slug, (prov.config as any)?.declaredRpm);
    if (!slot.ok) {
      logger.warn(`[STEP-TRACE] Step ${stepNum} throttled by provider ${prov.slug}, retry after ${slot.retryAfterMs}ms`);
      throw new ProviderThrottledError(slot.retryAfterMs);
    }
    logger.debug(`[STEP-TRACE] Step ${stepNum} using provider ${prov.name} (${prov.slug})`);

    const apiKey = decryptApiKey(prov.apiKeyRef);
    const adapter = createProviderAdapter(prov.slug, apiKey, prov.baseUrl, prov.defaultModel);

    const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];
    if (contextData) messages.push({ role: "user", content: contextData });
    // Build multimodal content if attachments present (images, text files)
    const userContent = buildMultimodalContent(userPromptText, attachments);
    messages.push({ role: "user", content: userContent });

    logger.debug(`[STEP-TRACE] Step ${stepNum} calling LLM (prompt=${userPromptText.length} chars)...`);
    const start = Date.now();
    llmResult = await callWithRetry(
      () => adapter.chat(messages, {
        model: model ?? prov!.defaultModel,
        temperature: parseFloat(temperature ?? "0.7"),
        maxTokens: maxTokens ?? 4096,
        ...(restricted ? { noRedirect: true } : {}),
      }),
      { maxRetries: 3, label: `Pipeline[${swarmRunId}] step ${stepNum}` },
    );
    const elapsed = Date.now() - start;
    logger.debug(`[STEP-TRACE] Step ${stepNum} LLM returned in ${elapsed}ms (${llmResult.usage.totalTokens} tokens)`);
    onLatency(elapsed);
    onTokens(llmResult.usage.totalTokens);
    await reportProviderResult(prov!.slug, "ok");
  } catch (err) {
    logger.error(`[STEP-TRACE] Step ${stepNum} FAILED`, { error: (err as Error).message });
    await db.update(agentRuns).set({ status: "failed", completedAt: new Date() })
      .where(eq(agentRuns.id, agentRun.id));
    const msg = (err as Error).message;
    const isCredit = err instanceof CreditExhaustedError;
    const isRateLimit = err instanceof ProviderThrottledError || msg.includes("429") || msg.toLowerCase().includes("rate limit") || msg.toLowerCase().includes("throttled");
    if (isCredit || isRateLimit) {
      const retryAfterMs = parseRetryAfter(msg);
      await reportProviderResult(prov!.slug, "rate_limited", retryAfterMs);
    }
    emitEvent(swarmRunId, {
      type: "step_error",
      step: stepNum,
      agentRole,
      agentName,
      error: isCredit
        ? `CREDIT_EXHAUSTED: ${restricted ? "out of credits — top up to run this workflow" : msg}`
        : restricted
          ? PROTECTED_ERROR_NOTICE
          : msg,
      isCreditError: isCredit,
    });
    throw err;
  }

  logger.debug(`[STEP-TRACE] Step ${stepNum} storing response...`);
  await db.insert(agentResponses).values({
    agentRunId: agentRun.id, swarmRunId, projectId,
    parentResponseId: parentRespId ?? null,
    responseType: getResponseTypeForRole(agentRole),
    content: llmResult.content,
    metadata: {
      model: llmResult.model, provider: prov!.name, providerSlug: prov!.slug,
      tokensUsed: { prompt: llmResult.usage.promptTokens, completion: llmResult.usage.completionTokens, total: llmResult.usage.totalTokens },
      latencyMs: llmResult.latencyMs, temperature: parseFloat(temperature ?? "0.7"), maxTokens: maxTokens ?? 4096,
      agentName, agentRole, agentSlug: agentRole,
      pipelineStep: stepNum, iteration: 1,
      buildMethod: parentRespId ? `${agentRole}_from_#${parentRespId}` : "initial",
      sourceResponseIds: parentRespId ? [parentRespId] : [],
    },
  });

  const [response] = await db.select().from(agentResponses)
    .where(eq(agentResponses.swarmRunId, swarmRunId))
    .orderBy(desc(agentResponses.id))
    .limit(1);
  logger.debug(`[STEP-TRACE] Step ${stepNum} response stored (id=${response?.id})`);

  await db.update(agentRuns).set({
    status: "completed", tokensUsed: llmResult.usage.totalTokens,
    latencyMs: llmResult.latencyMs, modelUsed: llmResult.model, providerUsed: prov!.slug,
    completedAt: new Date(),
  }).where(eq(agentRuns.id, agentRun.id));

  emitEvent(swarmRunId, { type: "step_complete", step: stepNum, agentRole, agentName, tokensUsed: llmResult.usage.totalTokens, latencyMs: llmResult.latencyMs });
  logger.debug(`[STEP-TRACE] Step ${stepNum} "${agentName}" COMPLETE`);

  // Incremental Gitee save
  if (giteeSave && response) {
    try {
      const prefix = String(giteeSave.index + 1).padStart(2, "0");
      const agentName = response.metadata.agentName.replace(/[^a-zA-Z0-9_-]/g, "_");
      const role = response.metadata.agentRole;
      const iterTag = response.metadata.iteration > 1 ? `-v${response.metadata.iteration}` : "";
      const content = `# ${role.toUpperCase()} — ${giteeSave.promptNum}\n\n**Agent**: ${response.metadata.agentName}\n**Model**: ${response.metadata.model}\n**Tokens**: ${response.metadata.tokensUsed.total}\n**Latency**: ${response.metadata.latencyMs}ms\n\n---\n\n${response.content}`;
      await createOrUpdateFile(giteeSave.token, giteeSave.owner, giteeSave.repo, `${giteeSave.basePath}/${giteeSave.promptNum}-${prefix}-${agentName}${iterTag}.md`, content, `${agentName}: ${giteeSave.promptNum}`, giteeSave.branch);
    } catch (err) { logger.error(`[Gitee] Step ${stepNum} save failed`, { error: (err as Error).message }); }
  }

  return response;
}

// ─── Load project state from Gitee ─────────────────────────────────
async function loadProjectState(
  token: string, owner: string, repo: string, projectName: string, branch: string,
): Promise<{ state: ProjectState; episodes: Episode[] }> {
  let state: ProjectState = { goal: projectName, keyDecisions: [], recentActivity: [], openReferences: [], longTermSummaries: [] };
  let episodes: Episode[] = [];
  try {
    const sf = await getFileContent(token, owner, repo, `swarm_studio/${projectName}/state.md`, branch);
    const parsed = parseStateFromMarkdown(sf.content);
    if (parsed) state = parsed;
  } catch { /* no state yet */ }
  try {
    const ef = await getFileContent(token, owner, repo, `swarm_studio/${projectName}/memory/episodes.json`, branch);
    episodes = parseEpisodes(ef.content);
  } catch { /* no episodes yet */ }
  return { state, episodes };
}

async function loadLastPolisherOutput(
  db: ReturnType<typeof getDb>, projectId: number, userId: number, currentRunId: number,
): Promise<string | null> {
  try {
    const [prev] = await db.select().from(swarmRuns)
      .where(and(eq(swarmRuns.projectId, projectId), eq(swarmRuns.userId, userId), eq(swarmRuns.status, "completed")))
      .orderBy(desc(swarmRuns.id)).limit(1);
    if (prev && prev.id !== currentRunId) {
      const [lr] = await db.select().from(agentResponses)
        .where(eq(agentResponses.swarmRunId, prev.id))
        .orderBy(desc(agentResponses.id)).limit(1);
      return lr?.content ?? null;
    }
  } catch { /* ignore */ }
  return null;
}

// ─── Run the execution state machine ───────────────────────────────
async function runExecutionLoop(opts: {
  db: ReturnType<typeof getDb>;
  ctx: { user: { id: number } };
  swarmRunId: number;
  project: typeof projects.$inferSelect;
  pipeline: ResolvedStep[];
  execCtx: ExecCtx;
  builderPrompt: string;
  totalTokens: { value: number };
  totalLatency: { value: number };
  giteeConfig: { token: string; owner: string; repo: string; branch: string; basePath: string; promptNum: string } | null;
  checkCancelled: (label?: string) => Promise<boolean>;
  attachments?: ChatAttachment[];
  autoApprove?: boolean;
  restricted?: boolean;
}): Promise<{ chain: typeof agentResponses.$inferSelect[]; completed: boolean; awaitingApproval?: { stepOrder: number; lastOutput: string } }> {
  const { db, ctx, swarmRunId, project, pipeline, execCtx, builderPrompt, totalTokens, totalLatency, giteeConfig, checkCancelled, attachments, autoApprove, restricted } = opts;

  const makeGiteeSave = (index: number) => giteeConfig ? { ...giteeConfig, index } : undefined;
  const tk = (t: number) => { totalTokens.value += t; };
  const lat = (l: number) => { totalLatency.value += l; };

  // ─── Circuit Breaker: initialize run tracking ───
  let cbLimits: any = null;
  let cbEnabled = false;
  try {
    const cb = await import("../plugins/circuit-breaker");
    const { isFeatureEnabled } = await import("../plugins/featureFlags");
    cbEnabled = await isFeatureEnabled("circuit_breaker", ctx.user.id);
    if (cbEnabled) {
      cbLimits = cb.startPipelineRun(swarmRunId);
    }
  } catch { /* circuit breaker not available */ }

  while (execCtx.currentIndex < pipeline.length) {
    if (await checkCancelled(`step-${execCtx.currentIndex}`)) throw new Error("Pipeline cancelled by user");

    const step = pipeline[execCtx.currentIndex];

    // ─── GLOBAL LOOP GUARD: prevent any step from being visited too many times ───
    const visits = (execCtx.visitCounts.get(execCtx.currentIndex) ?? 0) + 1;
    execCtx.visitCounts.set(execCtx.currentIndex, visits);
    if (visits > MAX_STEP_VISITS) {
      logger.warn(`[runExecutionLoop] Step "${step.name}" (idx=${execCtx.currentIndex}) visited ${visits} times — forcing advance to prevent infinite loop`);
      emitEvent(swarmRunId, { type: "step_start", step: step.stepOrder, agentRole: "system", agentName: `${step.name} (forced pass)` });
      execCtx.currentIndex++;
      continue;
    }

    // ─── APPROVAL: pause for human ───
    if (step.stepType === "approval") {
      // A protected (buyer) run has no human in the loop: the person on the
      // other side bought an ANSWER, not the seller's review workflow, and the
      // pause state would otherwise carry an intermediate output the buyer view
      // is not allowed to contain (§8.1 final-output-only).
      if (autoApprove || restricted) {
        // Test mode: auto-approve and continue without pausing
        logger.info(`[AUTO-APPROVE] Step ${step.stepOrder} (${step.name}) auto-approved for ${restricted ? "protected" : "test"} run`);
        execCtx.currentIndex++;
        continue;
      }
      const lastOutput = execCtx.chain[execCtx.chain.length - 1]?.content ?? "";
      // Store pending approval in context so resume can detect and advance past it
      execCtx.pendingApproval = { stepOrder: step.stepOrder, lastOutput };
      await db.update(swarmRuns).set({
        executionState: serializeCtx(execCtx),
      }).where(eq(swarmRuns.id, swarmRunId));
      emitEvent(swarmRunId, { type: "awaiting_approval", step: step.stepOrder, lastOutput, agentName: step.name });
      return { chain: execCtx.chain, completed: false, awaitingApproval: { stepOrder: step.stepOrder, lastOutput } };
    }

    // ─── AGENT / IF / WHILE: all need an LLM call ───
    const isFirstStep = execCtx.currentIndex === 0;

    // ─── CONTEXT RESOLUTION: prevent quality-gate assessment from being treated as content ───
    // When looping back after an IF/WHILE gate, the last chain entry is the gate's assessment.
    // The refiner needs the ORIGINAL CONTENT to fix, not the assessment text.
    const rawPrevOutput = execCtx.chain[execCtx.chain.length - 1]?.content ?? "";
    const prevRole = execCtx.chain[execCtx.chain.length - 1]?.metadata?.agentRole ?? "";
    const isPrevAGate = ["if", "while", "critic", "reviewer"].includes(prevRole);

    // Find the last non-gate output (actual content to work with)
    let contentToWorkWith = rawPrevOutput;
    if (isPrevAGate && execCtx.chain.length >= 2) {
      for (let i = execCtx.chain.length - 2; i >= 0; i--) {
        const c = execCtx.chain[i];
        const role = c?.metadata?.agentRole ?? "";
        if (!["if", "while", "critic", "reviewer"].includes(role)) {
          contentToWorkWith = c?.content ?? "";
          break;
        }
      }
    }

    // Find the most recent quality assessment (feedback to apply)
    let qualityFeedback = "";
    let feedbackSource = "";
    if (execCtx.chain.length > 0) {
      const last = execCtx.chain[execCtx.chain.length - 1];
      const lastRole = last?.metadata?.agentRole ?? "";
      if (["if", "while", "critic", "reviewer"].includes(lastRole)) {
        qualityFeedback = last?.content ?? "";
        feedbackSource = last?.metadata?.agentName ?? lastRole;
      }
    }

    // For looped steps: find all previous assessments of the same gate type
    let prevAssessment = "";
    if ((step.stepType === "if" || step.stepType === "while") && execCtx.chain.length > 1) {
      for (let i = execCtx.chain.length - 2; i >= 0; i--) {
        const c = execCtx.chain[i];
        if (c && (c.metadata?.agentRole === step.role || c.metadata?.agentName === step.name)) {
          prevAssessment = c.content;
          break;
        }
      }
    }

    let stepPrompt: string;
    let ctxData: string | null;

    if (isFirstStep) {
      // Builder: create or revise based on feedback
      if (execCtx.chain.length > 0 && execCtx.modifyInstructions) {
        stepPrompt = `${builderPrompt}\n\n[ADDITIONAL INSTRUCTIONS FROM USER]\n${execCtx.modifyInstructions}`;
        ctxData = null;
      } else if (execCtx.chain.length > 0 && qualityFeedback) {
        // Loop-back: builder receives quality feedback to revise
        stepPrompt = `REVISE the previous output based on the quality feedback below.\n\n[ORIGINAL REQUEST]\n${builderPrompt}\n\n[QUALITY FEEDBACK FROM ${feedbackSource}]\n${qualityFeedback}\n\nProduce a significantly improved version that addresses all feedback.`;
        ctxData = null;
      } else if (execCtx.chain.length > 0) {
        const lastQualityFeedback = execCtx.chain[execCtx.chain.length - 1];
        stepPrompt = `REVISE the previous output based on the feedback below.\n\n[ORIGINAL REQUEST]\n${builderPrompt}\n\n[FEEDBACK FROM ${lastQualityFeedback?.metadata?.agentName ?? "Reviewer"}]\n${lastQualityFeedback?.content ?? ""}\n\nProduce a significantly improved version.`;
        ctxData = null;
      } else {
        stepPrompt = execCtx.modifyInstructions
          ? `${builderPrompt}\n\n[ADDITIONAL INSTRUCTIONS FROM USER]\n${execCtx.modifyInstructions}`
          : builderPrompt;
        ctxData = null;
      }
    } else if (step.stepType === "if") {
      const opts = step.ifConfig?.options?.join(", ") ?? "pass, fail";
      const visitInfo = visits > 1 ? `\n\nNOTE: This is your ${visits}th time reviewing this output. If the refiner has adequately addressed previous issues, output "pass" to move forward. Only output "revise" if NEW significant issues remain.` : "";
      stepPrompt = `You are a quality gate reviewer. Analyze the previous output below carefully. Provide your FULL assessment — strengths, weaknesses, specific issues, and detailed reasoning. Be thorough and specific.

Then on the VERY LAST LINE of your response, output EXACTLY ONE of these keywords: ${opts}

This keyword on the last line determines pipeline routing. The full analysis above is saved for audit.${visitInfo}`;
      const gateContextParts: string[] = [];
      gateContextParts.push(`[ORIGINAL USER REQUEST]\n${builderPrompt}\n[END ORIGINAL REQUEST]`);
      gateContextParts.push(`[OUTPUT TO REVIEW]\n${contentToWorkWith}\n[END OUTPUT TO REVIEW]`);
      if (prevAssessment) {
        gateContextParts.push(`[PREVIOUS ASSESSMENT]\n${prevAssessment}\n[END PREVIOUS ASSESSMENT]`);
      }
      ctxData = gateContextParts.join("\n\n");
    } else if (step.stepType === "while") {
      const iterations = execCtx.iterationCounts.get(execCtx.currentIndex) ?? 0;
      const visitInfo = visits > 1 ? `\n\nNOTE: You have reviewed this output ${visits} time(s) already (iteration ${iterations + 1}). The refiner has been given your previous feedback. If the output now meets quality standards, output "pass". Only output "retry" if significant NEW issues remain that were not addressed.` : "";
      stepPrompt = `You are a quality checker. Review the previous output below carefully. Provide your FULL assessment — does it meet quality standards? What specific improvements are needed? Be thorough.

Then on the VERY LAST LINE of your response, output EXACTLY "retry" (to loop back and improve) or "pass" (to continue).

This keyword on the last line determines pipeline routing. The full analysis above is saved for audit.${visitInfo}`;
      const whileContextParts: string[] = [];
      whileContextParts.push(`[ORIGINAL USER REQUEST]\n${builderPrompt}\n[END ORIGINAL REQUEST]`);
      whileContextParts.push(`[OUTPUT TO REVIEW]\n${contentToWorkWith}\n[END OUTPUT TO REVIEW]`);
      if (prevAssessment) {
        whileContextParts.push(`[PREVIOUS ASSESSMENT]\n${prevAssessment}\n[END PREVIOUS ASSESSMENT]`);
      }
      ctxData = whileContextParts.join("\n\n");
    } else {
      // Normal agent — role-specific step prompts
      if (qualityFeedback && (step.role === "refiner" || step.role === "builder")) {
        stepPrompt = `Review the previous output below and improve it based on the quality feedback provided.

[QUALITY FEEDBACK FROM ${feedbackSource}]
${qualityFeedback}

Now process the actual content below and produce an improved version. Output the full improved content directly — do NOT wrap in JSON, do NOT add meta-commentary.`;
      } else if (step.role === "translator") {
        stepPrompt = `Translate the content below to the appropriate target language. Output ONLY the translated text — natural, fluent prose. Do NOT wrap in JSON, do NOT add summaries, do NOT explain your translation choices. Preserve all formatting (tables, markdown structure) in the translated version.`;
      } else if (step.role === "polisher") {
        stepPrompt = `Polish the content below for clarity, consistency, and completeness. Output the polished content directly. Do NOT wrap in JSON or add meta-commentary.`;
      } else if (step.role === "expert") {
        stepPrompt = `Enrich the content below with domain-specific expertise. Add depth, accuracy, and professional insights. Output the enriched content directly. Do NOT wrap in JSON.`;
      } else {
        stepPrompt = `Process the output from the previous step for the original request. Output your result directly — do NOT wrap in JSON or add unnecessary commentary.`;
      }
      // Build readable context instead of raw JSON — helps the LLM understand the project
      const contextParts: string[] = [];
      contextParts.push(`[ORIGINAL USER REQUEST]\n${builderPrompt}\n[END ORIGINAL REQUEST]`);
      contextParts.push(`[PREVIOUS AGENT OUTPUT]\n${contentToWorkWith}\n[END PREVIOUS OUTPUT]`);
      if (qualityFeedback) {
        contextParts.push(`[QUALITY FEEDBACK FROM ${feedbackSource}]\n${qualityFeedback}\n[END QUALITY FEEDBACK]`);
      }
      ctxData = contextParts.join("\n\n");
    }

    // ─── Circuit Breaker: check limits before executing ───
    if (cbEnabled && cbLimits) {
      const cb = await import("../plugins/circuit-breaker");
      const estimateTokens = step.maxTokens ?? 4000;
      const estimateCost = (estimateTokens / 1000) * 0.01; // rough $0.01/1K tokens
      const result = cb.checkStep(swarmRunId, step.name, estimateTokens, estimateCost, cbLimits);
      if (!result.allowed) {
        logger.warn(`[CircuitBreaker] Blocked step "${step.name}": ${result.reason}`);
        throw new Error(`Pipeline aborted: ${result.reason}`);
      }
    }

    const resp = await executeAgentStep({
      db, ctx, swarmRunId, projectId: project.id, project,
      stepNum: step.stepOrder, agentId: step.agentId,
      agentName: step.name, agentRole: step.role,
      systemPrompt: step.systemPrompt,
      providerId: step.providerId, model: step.model ?? null,
      temperature: step.temperature, maxTokens: step.maxTokens,
      userPromptText: stepPrompt, contextData: ctxData,
      attachments,
      parentRespId: execCtx.chain[execCtx.chain.length - 1]?.id,
      onTokens: tk, onLatency: lat,
      restricted,
      giteeSave: makeGiteeSave(execCtx.chain.length),
    });

    // ─── Circuit Breaker: record actual usage ───
    const tokensUsed = resp.metadata?.tokensUsed?.total ?? 0;
    if (cbEnabled && tokensUsed > 0) {
      const cb = await import("../plugins/circuit-breaker");
      const actualCost = (tokensUsed / 1000) * 0.01;
      cb.recordStepUsage(swarmRunId, step.name, tokensUsed, actualCost);
    }

    // ─── Unwrap JSON-wrapped responses ──────────────────────────────
    // Some LLMs wrap translations in {"translation": "..."} even when told not to
    resp.content = unwrapJsonResponse(resp.content);

    execCtx.chain.push(resp);
    execCtx.modifyInstructions = undefined; // Clear after use

    // ─── IF: branch based on keyword (last line) ───
    if (step.stepType === "if") {
      const lines = resp.content.trim().split("\n").map((l) => l.trim()).filter(Boolean);
      const lastLine = lines[lines.length - 1] ?? resp.content;
      const keyword = lastLine.toLowerCase().replace(/[^a-z0-9_-]/g, "");
      const mapping = step.ifConfig?.mappings?.[keyword];
      if (mapping) {
        const targetIdx = pipeline.findIndex((s) => s.stepOrder === mapping);
        execCtx.currentIndex = targetIdx >= 0 ? targetIdx : execCtx.currentIndex + 1;
      } else {
        execCtx.currentIndex++;
      }
      // Save state after IF decision so iteration counts survive
      await db.update(swarmRuns).set({ executionState: serializeCtx(execCtx) }).where(eq(swarmRuns.id, swarmRunId)).catch(() => {});
      continue;
    }

    // ─── WHILE: loop or continue (keyword on last line) ───
    if (step.stepType === "while") {
      const lines = resp.content.trim().split("\n").map((l) => l.trim()).filter(Boolean);
      const lastLine = lines[lines.length - 1] ?? resp.content;
      const decision = lastLine.toLowerCase();
      const iterations = execCtx.iterationCounts.get(execCtx.currentIndex) ?? 0;
      // HARD CAP: never allow more than MAX_WHILE_ITERATIONS regardless of DB config
      const maxIter = Math.min(step.whileConfig?.maxIterations ?? 3, MAX_WHILE_ITERATIONS);
      const targetStep = step.whileConfig?.targetStep;

      if (decision.includes("retry") && iterations < maxIter && targetStep) {
        execCtx.iterationCounts.set(execCtx.currentIndex, iterations + 1);
        const targetIdx = pipeline.findIndex((s) => s.stepOrder === targetStep);
        execCtx.currentIndex = targetIdx >= 0 ? targetIdx : execCtx.currentIndex + 1;
        emitEvent(swarmRunId, { type: "step_start", step: step.stepOrder, agentRole: "system", agentName: `Loop (${iterations + 1}/${maxIter})` });
      } else {
        if (decision.includes("retry") && iterations >= maxIter) {
          logger.warn(`[runExecutionLoop] WHILE step "${step.name}" hit max iterations (${maxIter}) — forcing pass`);
        }
        execCtx.currentIndex++;
      }
      // Save state after WHILE decision so iteration counts survive
      await db.update(swarmRuns).set({ executionState: serializeCtx(execCtx) }).where(eq(swarmRuns.id, swarmRunId)).catch(() => {});
      continue;
    }

    // ─── Normal agent: advance ───
    execCtx.currentIndex++;
  }

  // ─── Circuit Breaker: cleanup ───
  if (cbEnabled) {
    try { const cb = await import("../plugins/circuit-breaker"); cb.endPipelineRun(swarmRunId); } catch { /* ignore */ }
  }

  return { chain: execCtx.chain, completed: true };
}

// ─── Unwrap JSON-wrapped LLM responses ────────────────────────────
// LLMs sometimes wrap content in {"translation": "..."} or {"response": "..."}
// even when explicitly told not to. This extracts the inner content.
function unwrapJsonResponse(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return content;

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      const keys = Object.keys(parsed);
      // Single-key JSON with string value → unwrap
      if (keys.length === 1 && typeof parsed[keys[0]] === "string") {
        const inner = parsed[keys[0]];
        if (inner.trim().length > 10) return inner;
      }
    }
  } catch {
    // Not valid JSON — leave as-is
  }
  return content;
}

// ─── Gitee final save (state + episodes) ──────────────────────────
async function giteeFinalSave(opts: {
  giteeConfig: { token: string; owner: string; repo: string; branch: string; basePath: string; promptNum: string };
  state: ProjectState | null;
  episodes: Episode[];
  chain: typeof agentResponses.$inferSelect[];
  project: typeof projects.$inferSelect;
  prompt: string;
  memoryMode: MemoryMode;
}) {
  const { giteeConfig: g, state, episodes, chain, project, prompt, memoryMode } = opts;
  try {
    let currentState = state;
    if (!currentState) {
      currentState = { goal: project.description || prompt, keyDecisions: [], recentActivity: [], openReferences: [], longTermSummaries: [] };
    }
    const agentOutputs = chain.map((r) => ({ role: r.metadata.agentRole, name: r.metadata.agentName, content: r.content }));
    const finalOut = chain[chain.length - 1];
    currentState = updateStateWithSession(currentState, project.name, project.description, prompt, agentOutputs, finalOut.content);
    currentState = triggerCompressionIfNeeded(currentState, memoryMode);

    await createOrUpdateFile(g.token, g.owner, g.repo, `${g.basePath}/${g.promptNum}-state.md`, serializeStateToMarkdown(currentState), `state: ${g.promptNum}`, g.branch);
    await createOrUpdateFile(g.token, g.owner, g.repo, `${g.basePath}/state.md`, serializeStateToMarkdown(currentState), `state: ${g.promptNum} (latest)`, g.branch);

    const newEp = createEpisode(prompt, finalOut.content, episodes);
    const newEps = rotateEpisodes([newEp, ...episodes], 50);
    await createOrUpdateFile(g.token, g.owner, g.repo, `${g.basePath}/memory/episodes.json`, serializeEpisodes(newEps), `memory: ${g.promptNum}`, g.branch);
  } catch (err) {
    logger.error("[Gitee] Final save failed", { error: (err as Error).message });
  }
}

// ═══════════════════════════════════════════════════════════════════
//  PIPELINE RUNNER
// ═══════════════════════════════════════════════════════════════════
// Progress is streamed via SSE. Previously fire-and-forget inside the tRPC
// request; now awaited inside the queue worker.

async function runPipelineAsync(opts: {
  db: ReturnType<typeof getDb>;
  ctx: { user: { id: number } };
  input: { projectId: number; prompt: string; giteeToken?: string; memoryMode?: string; attachments?: ChatAttachment[]; includeProjectFiles?: boolean; clientTraceId?: string; stateless?: boolean };
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
  chain?: SwarmRunParams["chain"];
  /** §8.2: this run executes a protected (non-owner) snapshot, so transport
   *  hardening applies: no HTTP redirect may take the prompt and the key to
   *  another origin. Ordinary runs keep default fetch behavior. */
  restricted?: boolean;
}) {
  const { db, ctx, input, swarmRunId, project, giteeConfig, memoryMode, useLegacy, legacyAgents, pipeline, builderPrompt, state, episodes, execCtx, autoApprove, batchId, chain, restricted } = opts;

  // ─── checkCancelled helper ───
  const checkCancelled = async (label?: string) => {
    const [r] = await db
      .select({ status: swarmRuns.status, startedAt: swarmRuns.startedAt })
      .from(swarmRuns)
      .where(eq(swarmRuns.id, swarmRunId));
    const prefix = label ? `[checkCancelled:${label}]` : "[checkCancelled]";
    if (r?.status === "cancelled") {
      const startedMs = r.startedAt ? new Date(r.startedAt).getTime() : 0;
      const ageMs = Date.now() - startedMs;
      if (ageMs < 3000) {
        logger.warn(`${prefix} Run ${swarmRunId} has status=cancelled but age=${ageMs}ms < 3s — treating as NOT cancelled (retry guard)`);
        return false;
      }
      logger.warn(`${prefix} Run ${swarmRunId} is genuinely cancelled (age=${ageMs}ms)`);
      return true;
    }
    return false;
  };

  // ─── Build pipeline steps ───
  let steps: ResolvedStep[] = [];
  if (useLegacy) {
    steps = legacyAgents.map((a, i) => ({
      stepId: a.id,
      stepOrder: i + 1,
      name: a.name,
      role: a.role,
      systemPrompt: a.systemPrompt,
      providerId: a.providerId,
      model: a.model,
      temperature: "0.7",
      maxTokens: 4096,
      agentId: null,
      stepType: "agent" as const,
      ifConfig: null,
      whileConfig: null,
    }));
  } else if (pipeline) {
    steps = pipeline;
  }

  if (steps.length === 0) {
    const errMsg = "No pipeline steps configured";
    logger.error(`[PIPELINE-ASYNC] Run ${swarmRunId}: ${errMsg}`);
    await db.update(swarmRuns).set({ status: "failed", completedAt: new Date(), error: errMsg }).where(eq(swarmRuns.id, swarmRunId));
    emitEvent(swarmRunId, { type: "pipeline_error", error: errMsg, timestamp: new Date().toISOString() });
    return;
  }

  const totalTokens = { value: 0 };
  const totalLatency = { value: 0 };

  try {
    const result = await runExecutionLoop({
      db, ctx, swarmRunId, project, pipeline: steps, execCtx,
      builderPrompt, totalTokens, totalLatency,
      giteeConfig, checkCancelled,
      attachments: input.attachments,
      autoApprove,
      restricted,
    });

    // ─── Approval pause ───
    if (result.awaitingApproval) {
      await db.update(swarmRuns).set({
        executionState: serializeCtx(execCtx),
      }).where(eq(swarmRuns.id, swarmRunId));
      emitEvent(swarmRunId, {
        type: "pipeline_complete",
        awaitingApproval: true,
        finalResponse: result.awaitingApproval.lastOutput,
        chain: execCtx.chain.map((r) => ({ id: r.id, content: r.content, agentRole: r.metadata.agentRole, agentName: r.metadata.agentName })),
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // ─── Completion ───
    const finalOut = result.chain[result.chain.length - 1];
    const finalResponseId = finalOut?.id ?? null;
    const finalResponseText = finalOut?.content ?? "Pipeline completed with no output.";

    await db.update(swarmRuns).set({
      status: "completed",
      completedAt: new Date(),
      finalResponseId,
      totalTokensUsed: totalTokens.value,
      totalLatencyMs: totalLatency.value,
      executionState: null, // Clear so stale pendingApproval doesn't replay on re-open
    }).where(eq(swarmRuns.id, swarmRunId));

    emitEvent(swarmRunId, {
      type: "pipeline_complete",
      finalResponse: finalResponseText,
      totalTokens: totalTokens.value,
      totalLatencyMs: totalLatency.value,
      // Intermediate step content is not part of a protected run's stream; the
      // buyer reads the final output, nothing else (§8.1).
      ...(restricted ? {} : { chain: result.chain.map((r) => ({ id: r.id, content: r.content, agentRole: r.metadata.agentRole, agentName: r.metadata.agentName })) }),
      timestamp: new Date().toISOString(),
    });

    // ─── Gitee final save ───
    if (giteeConfig && !input.stateless) {
      await giteeFinalSave({
        giteeConfig,
        state,
        episodes,
        chain: result.chain,
        project,
        prompt: input.prompt,
        memoryMode,
      });
    }

    // Drop the in-memory terminal event cache now that the final event has been
    // delivered and the run is truly done. Without this, late SSE subscribers
    // would replay the completion event forever and re-trigger UI side-effects.
    try {
      const { clearTerminalEvent } = await import("./eventBus");
      clearTerminalEvent(swarmRunId);
    } catch { /* ignore */ }

    logger.info(`[PIPELINE-ASYNC] Run ${swarmRunId} completed successfully`);

    // ─── Batch progress accounting ───
    if (batchId) {
      try {
        await incrementBatchProgress(batchId, { completed: 1, tokens: totalTokens.value });
      } catch (batchErr) {
        logger.error("[PIPELINE-ASYNC] Batch progress update failed", { batchId, error: (batchErr as Error).message });
      }
    }

    // ─── Pipeline chaining ───
    if (chain) {
      try {
        await handlePipelineChain({ db, swarmRunId, finalResponseText, chain, userId: ctx.user.id, batchId, originalInput: input.prompt });
      } catch (chainErr) {
        logger.error("[PIPELINE-ASYNC] Chaining failed", { swarmRunId, error: (chainErr as Error).message });
      }
    }

  } catch (err) {
    const errorMsg = (err as Error).message;
    const isCancel = errorMsg.includes("cancelled");
    const isThrottle = err instanceof ProviderThrottledError || err instanceof RunThrottledError;

    if (isThrottle) {
      const retryAfterMs = (err as any).retryAfterMs ?? 5000;
      await db.update(swarmRuns).set({
        executionState: serializeCtx(execCtx),
      }).where(eq(swarmRuns.id, swarmRunId));
      throw new RunThrottledError(retryAfterMs);
    }

    const isCredit = err instanceof CreditExhaustedError || errorMsg.includes("CREDIT_EXHAUSTED");
    if (isCredit && batchId) {
      await db.update(swarmRuns).set({
        executionState: serializeCtx(execCtx),
      }).where(eq(swarmRuns.id, swarmRunId));
      await db.update(swarmBatches).set({ status: "paused_credit" }).where(eq(swarmBatches.id, batchId));
      await db.insert(notifications).values({
        userId: ctx.user.id,
        type: "batch_paused_credit",
        title: "Batch paused — API credits exhausted",
        message: `Batch ${batchId} paused because API credits were exhausted at run ${swarmRunId}. Top up and resume; nothing was lost.`,
        dataJson: { batchId, swarmRunId },
      });
      logger.warn(`[PIPELINE-ASYNC] Batch ${batchId} paused_credit at run ${swarmRunId}`);
      throw new BatchPausedError("credit");
    }

    await db.update(swarmRuns).set({
      status: isCancel ? "cancelled" : "failed",
      completedAt: new Date(),
      executionState: null, // Clear so a failed/cancelled run doesn't replay HITL on re-open
      error: isCancel ? null : safeError(errorMsg),
    }).where(eq(swarmRuns.id, swarmRunId));

    // ─── Batch progress accounting ───
    if (batchId) {
      try {
        await incrementBatchProgress(batchId, { failed: 1, tokens: totalTokens.value });
      } catch (batchErr) {
        logger.error("[PIPELINE-ASYNC] Batch progress update failed", { batchId, error: (batchErr as Error).message });
      }
    }

    emitEvent(swarmRunId, {
      type: "pipeline_error",
      error: restricted ? PROTECTED_ERROR_NOTICE : errorMsg,
      timestamp: new Date().toISOString(),
    });

    try {
      const { clearTerminalEvent } = await import("./eventBus");
      clearTerminalEvent(swarmRunId);
    } catch { /* ignore */ }

    logger.error(`[PIPELINE-ASYNC] Run ${swarmRunId} ${isCancel ? "cancelled" : "failed"}`, { error: errorMsg });
  }
}

// ═══════════════════════════════════════════════════════════════════
//  RUN CLAIMS — prevent two workers executing the same run
// ═══════════════════════════════════════════════════════════════════
const CLAIM_TTL_MS = 30 * 60 * 1000; // matches getRunStatus 30-min staleness
const localClaims = new Map<number, number>(); // runId -> expiry ts

/** Try to claim a run for exclusive execution. Never throws. */
async function claimRun(swarmRunId: number): Promise<boolean> {
  const redis = await getRedis();
  if (redis) {
    try {
      const res = await redis.set(`claim:swarm:${swarmRunId}`, INSTANCE_ID, "PX", CLAIM_TTL_MS, "NX");
      return res === "OK";
    } catch (err) {
      logger.warn("claimRun: redis claim failed, using local claim", { swarmRunId, error: (err as Error).message });
    }
  }
  const now = Date.now();
  const expiry = localClaims.get(swarmRunId);
  if (expiry && expiry > now) return false;
  localClaims.set(swarmRunId, now + CLAIM_TTL_MS);
  return true;
}

/** Release a run claim so a later job (e.g. approval resume) can pick it up. */
async function releaseRun(swarmRunId: number): Promise<void> {
  localClaims.delete(swarmRunId);
  const redis = await getRedis();
  if (redis) {
    try { await redis.del(`claim:swarm:${swarmRunId}`); } catch { /* ignore */ }
  }
}
// ─── Pipeline chaining helper ─────────────────────────────────────
async function handlePipelineChain(opts: {
  db: ReturnType<typeof getDb>;
  swarmRunId: number;
  finalResponseText: string;
  chain: NonNullable<SwarmRunParams["chain"]>;
  userId: number;
  batchId?: number;
  originalInput: string;
}) {
  const { db, swarmRunId, finalResponseText, chain, userId, batchId, originalInput } = opts;

  // Guard 1: depth limit
  if (chain.depth >= 3) {
    logger.info(`[CHAIN] Skipping chain for run ${swarmRunId}: depth limit (${chain.depth}) reached`);
    return;
  }

  // Guard 2: target project access
  const [targetProject] = await db.select().from(projects)
    .where(eq(projects.id, chain.targetProjectId)).limit(1);
  if (!targetProject) {
    logger.warn(`[CHAIN] Skipping chain for run ${swarmRunId}: target project ${chain.targetProjectId} not found`);
    return;
  }
  if (targetProject.userId !== userId) {
    logger.warn(`[CHAIN] Skipping chain for run ${swarmRunId}: cross-user chain not allowed`);
    return;
  }

  // Guard 3: cycle detection (target project in lineage more than once)
  const lineageProjects = new Set<number>();
  for (const ancestorId of chain.lineage) {
    const [ancestor] = await db.select({ projectId: swarmRuns.projectId }).from(swarmRuns)
      .where(eq(swarmRuns.id, ancestorId)).limit(1);
    if (ancestor) lineageProjects.add(ancestor.projectId);
  }
  if (lineageProjects.has(chain.targetProjectId)) {
    logger.warn(`[CHAIN] Skipping chain for run ${swarmRunId}: cycle detected (targetProjectId ${chain.targetProjectId} already in lineage)`);
    return;
  }

  // Render template
  const template = chain.inputTemplate ?? "{{finalResponse}}";
  const renderedPrompt = template
    .replace(/\{\{finalResponse\}\}/g, finalResponseText)
    .replace(/\{\{originalInput\}\}/g, originalInput);

  // Insert chained run
  let chainedRunId = 0;
  await db.transaction(async (tx) => {
    await tx.insert(swarmRuns).values({
      projectId: chain.targetProjectId,
      userId,
      userPrompt: renderedPrompt,
      status: "pending",
      pipelineVersion: targetProject.pipelineTemplateId ? "custom-v2" : "cascade-v1",
      agentsUsed: [],
      runParams: {
        source: "execute",
        prompt: renderedPrompt,
        memoryMode: "balanced",
        chain: {
          targetProjectId: chain.targetProjectId,
          inputTemplate: chain.inputTemplate,
          depth: chain.depth + 1,
          lineage: [...chain.lineage, swarmRunId],
        },
      } as SwarmRunParams,
      batchId: batchId ?? null,
    });
    const [run] = await tx.select().from(swarmRuns)
      .where(eq(swarmRuns.userId, userId))
      .orderBy(desc(swarmRuns.id))
      .limit(1);
    chainedRunId = run.id;

    // If part of a batch, increment totalRuns
    if (batchId) {
      await tx.update(swarmBatches)
        .set({ totalRuns: sql`${swarmBatches.totalRuns} + 1` })
        .where(eq(swarmBatches.id, batchId));
    }
  });

  // Enqueue
  const { enqueueSwarmRun } = await import("../workers/swarmWorker");
  await enqueueSwarmRun(chainedRunId, userId);

  logger.info(`[CHAIN] Created chained run ${chainedRunId} from ${swarmRunId} -> project ${chain.targetProjectId}`, {
    depth: chain.depth + 1,
    lineage: [...chain.lineage, swarmRunId],
  });
}



// ═══════════════════════════════════════════════════════════════════
//  WORKER ENTRY POINT
// ═══════════════════════════════════════════════════════════════════

/**
 * Execute (or resume) a swarm run inside the worker.
 * Rehydrates everything from the DB: run_params holds the original request
 * (gitee token is master-key encrypted), execution_state holds the HITL state.
 * Errors from the pipeline itself are handled inside runPipelineAsync; this
 * function only throws for setup failures — the caller (worker) marks the run
 * failed in that case.
 */
export async function executeSwarmRun(
  args: { swarmRunId: number; userId: number },
  requeue?: (delayMs: number) => Promise<void>,
): Promise<void> {
  const { swarmRunId, userId } = args;
  const db = getDb();

  const [run] = await db.select().from(swarmRuns)
    .where(eq(swarmRuns.id, swarmRunId)).limit(1);
  if (!run) {
    logger.warn("[executeSwarmRun] Run not found — dropping job", { swarmRunId });
    return;
  }
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    logger.info("[executeSwarmRun] Run already terminal — dropping job", { swarmRunId, status: run.status });
    return;
  }

  const claimed = await claimRun(swarmRunId);
  if (!claimed) {
    logger.info("[executeSwarmRun] Run already claimed by another worker — dropping job", { swarmRunId });
    return;
  }

  try {
    // Mark running (crash-resumed runs are reset to "pending" by boot heal)
    if (run.status !== "running") {
      await db.update(swarmRuns)
        .set({ status: "running", startedAt: new Date() })
        .where(eq(swarmRuns.id, swarmRunId));
    }

    const [project] = await db.select().from(projects)
      .where(eq(projects.id, run.projectId)).limit(1);
    if (!project) throw new Error("Project not found");

    // Load user-level default provider — used as ultimate fallback when
    // neither the step nor the project has a configured provider.
    const [userRecord] = await db.select({ defaultProviderId: users.defaultProviderId })
      .from(users).where(eq(users.id, userId)).limit(1);
    const projectWithUserDefault = {
      ...project,
      defaultProviderId: project.defaultProviderId ?? userRecord?.defaultProviderId ?? null,
    };

    const params: SwarmRunParams = (run.runParams as SwarmRunParams | null) ?? { source: "execute", prompt: run.userPrompt ?? "" };
    const giteeToken = params.giteeTokenEnc
      ? decrypt(params.giteeTokenEnc, getMasterKey())
      : undefined;
    const memoryMode: MemoryMode = (params.memoryMode as MemoryMode) ?? "balanced";
    const autoApprove = params.autoApprove ?? false;

    // ─── V2 snapshot execution (offering redesign spec §5.3/§8.1) ───
    // When the run carries an immutable step snapshot, the engine executes
    // THAT definition with side effects disabled (no repo/memory writes —
    // the synthetic project below has no gitee wiring and memory loads are
    // gated on real project metadata). The mutable project steps are never
    // read or written on this path.
    if (params.snapshotVersionId) {
      const { loadVersionDefinition, resolveSnapshotSteps } = await import("./benchmark/versionService");
      const { version, definition } = await loadVersionDefinition(params.snapshotVersionId);
      let pipeline;
      if (version.ownerId === userId) {
        // The owner running their own version (durable design jobs, benchmarks).
        pipeline = resolveSnapshotSteps(definition);
      } else if (params.protectedRun) {
        // §8.1: a BUYER running a seller's published version. Authorized
        // through the protected context, re-checked against CURRENT rows —
        // the right is never inferred from the run_params blob alone, so a
        // grant revoked after queuing stops the run here.
        const { loadAuthorizedSnapshotSteps } = await import("./marketplaceExecutionService");
        pipeline = (await loadAuthorizedSnapshotSteps({
          runRow: run, callerId: userId, params: params.protectedRun, versionId: params.snapshotVersionId,
        })).steps;
      } else if (params.sharedRun) {
        // The same rule for a pipeline shared between two accounts: the
        // definition belongs to the grantor, the run belongs to the recipient,
        // and the grant row — not this blob — decides whether it proceeds.
        const { loadAuthorizedSharedSnapshotSteps } = await import("./pipelineSharing");
        pipeline = (await loadAuthorizedSharedSnapshotSteps({
          runRow: run, callerId: userId, params: params.sharedRun, versionId: params.snapshotVersionId,
        })).steps;
      } else {
        // Identical message either way: a caller must not learn that some other
        // user's workflow version exists (§10.1).
        throw new Error("Workflow version not found");
      }
      const syntheticProject = {
        ...project,
        giteeOwner: null, giteeRepo: null, githubOwner: null, githubRepo: null,
        localFolderName: null,
      } as typeof project;
      await runExecutePipeline({
        db, run, userId, swarmRunId,
        project: syntheticProject, projectWithUserDefault: syntheticProject,
        params, giteeToken: undefined, memoryMode: "conservative", autoApprove,
        pipeline, useLegacy: false, legacyAgents: [],
      });
      return;
    }

    const pipeline = await loadPipelineSteps(db, run.projectId);
    logger.info(`[executeSwarmRun] run=${swarmRunId} project=${run.projectId}: pipeline=${pipeline ? pipeline.length + " custom steps" : "null"} source=${params.source}`);

    // Fallback to legacy agents
    let useLegacy = false;
    let legacyAgents: typeof agents.$inferSelect[] = [];
    if (!pipeline) {
      useLegacy = true;
      legacyAgents = await db.select().from(agents)
        .where(and(eq(agents.projectId, run.projectId), eq(agents.isEnabled, true)))
        .orderBy(asc(agents.pipelineOrder));
      logger.info(`[executeSwarmRun] run=${swarmRunId}: using ${legacyAgents.length} legacy agents`);
    }

    // Record pipeline shape on the run row (used to be set by the mutation)
    await db.update(swarmRuns).set({
      pipelineVersion: pipeline ? "custom-v2" : "cascade-v1",
      agentsUsed: pipeline ? pipeline.map((s) => s.role) : legacyAgents.map((a) => a.role),
    }).where(eq(swarmRuns.id, swarmRunId));

    if (params.source === "resumePipeline") {
      await runResumedPipeline({
        db, run, userId, swarmRunId, project: projectWithUserDefault,
        giteeToken, memoryMode, pipeline,
      });
      return;
    }

    await runExecutePipeline({
      db, run, userId, swarmRunId, project, projectWithUserDefault,
      params, giteeToken, memoryMode, autoApprove, pipeline, useLegacy, legacyAgents,
    });
  } catch (err) {
    if (err instanceof RunThrottledError && requeue) {
      logger.warn(`[executeSwarmRun] Run ${swarmRunId} throttled, requeuing after ${err.retryAfterMs}ms`);
      await requeue(err.retryAfterMs);
      return;
    }
    if (err instanceof BatchPausedError) {
      logger.warn(`[executeSwarmRun] Run ${swarmRunId} batch paused (${err.reason})`);
      return;
    }
    // Safety net: setup failures (runPipelineAsync handles its own errors)
    const errorMsg = (err as Error).message;
    logger.error("[executeSwarmRun] Setup failed", { swarmRunId, error: errorMsg });
    try {
      await db.update(swarmRuns).set({
        status: "failed", completedAt: new Date(), executionState: null, error: safeError(errorMsg),
      }).where(eq(swarmRuns.id, swarmRunId));
      emitEvent(swarmRunId, { type: "pipeline_error", error: errorMsg, timestamp: new Date().toISOString() });
    } catch (dbErr) {
      logger.error("[executeSwarmRun] Failed to mark run as failed", { swarmRunId, error: (dbErr as Error).message });
    }
  } finally {
    await releaseRun(swarmRunId);
  }
}

// ─── execute source: fresh run or approval-resume (mirrors the old mutation body) ───
async function runExecutePipeline(opts: {
  db: ReturnType<typeof getDb>;
  run: typeof swarmRuns.$inferSelect;
  userId: number;
  swarmRunId: number;
  project: typeof projects.$inferSelect;
  projectWithUserDefault: typeof projects.$inferSelect;
  params: SwarmRunParams;
  giteeToken?: string;
  memoryMode: MemoryMode;
  autoApprove: boolean;
  pipeline: ResolvedStep[] | null;
  useLegacy: boolean;
  legacyAgents: typeof agents.$inferSelect[];
}) {
  const { db, run, userId, swarmRunId, project, projectWithUserDefault, params, giteeToken, memoryMode, autoApprove, pipeline, useLegacy, legacyAgents } = opts;
  const ctx = { user: { id: userId } };

  // ─── Resolve execution context (fresh or resume-from-approval) ───
  let execCtx: ExecCtx;
  let isResuming = false;

  if (run.executionState) {
    isResuming = true;
    execCtx = deserializeCtx(run.executionState);
    // Reload chain from DB
    const responses = await db.select().from(agentResponses)
      .where(eq(agentResponses.swarmRunId, swarmRunId))
      .orderBy(agentResponses.id);
    execCtx.chain = responses as typeof agentResponses.$inferSelect[];
    // Apply pending approval action
    if (run.executionState.pendingApproval) {
      const approval = run.executionState.pendingApproval;
      if (approval.action === "approve") {
        // Advance past the approval step so we don't pause again
        execCtx.currentIndex++;
      } else if (approval.action === "reject" || approval.action === "modify") {
        // Go back to previous agent step
        const prevAgentIdx = execCtx.currentIndex - 1;
        if (prevAgentIdx >= 0) {
          execCtx.currentIndex = prevAgentIdx;
          // Remove responses from that step onwards
          const keepCount = execCtx.chain.filter((_, i) => {
            // Keep responses before the current index's step
            return i < execCtx.chain.length - 1; // Rough: keep all but last
          }).length;
          execCtx.chain = execCtx.chain.slice(0, Math.max(1, keepCount));
        }
        if (approval.action === "modify" && approval.instructions) {
          execCtx.modifyInstructions = approval.instructions;
        }
      }
      // Clear the pending approval so it's not re-processed on next resume
      execCtx.pendingApproval = undefined;
    }
  } else {
    execCtx = makeFreshCtx();
  }

  logger.info(`[EXECUTE-TRACE] runId=${swarmRunId}, project=${run.projectId}, user=${userId}, isResuming=${isResuming}`);

  // ─── Smart Compression ───
  // When resuming (e.g., after human approval), prompt may be empty.
  // Use the stored userPrompt from the run record.
  let effectivePrompt = params.prompt;
  if (isResuming && (!effectivePrompt || effectivePrompt.trim() === "")) {
    effectivePrompt = run.userPrompt ?? "";
  }
  let builderPrompt = effectivePrompt;
  let state: ProjectState | null = null;
  let episodes: Episode[] = [];

  if (!isResuming) {
    if (project.giteeOwner && project.giteeRepo && giteeToken) {
      try {
        const loaded = await loadProjectState(giteeToken, project.giteeOwner, project.giteeRepo, project.name, project.giteeBranch ?? "master");
        state = loaded.state; episodes = loaded.episodes;
      } catch { /* ignore */ }
    }
    let lastOut: string | null = null;
    if (!params.stateless) {
      lastOut = await loadLastPolisherOutput(db, run.projectId, userId, swarmRunId);
      if (lastOut) builderPrompt = `[PREVIOUS WORK]\n${lastOut}\n\n[NEW REQUEST]\n${params.prompt}`;
    }

    if (state) {
      try {
        const relevant = retrieveEpisodes(params.prompt, episodes, 2);
        const { prompt: structured, estimatedTokens: est } = buildBuilderPrompt(state, relevant, lastOut, params.prompt, memoryMode);
        logger.debug(`[SmartCompression] Estimated: ${est} tokens (mode: ${memoryMode})`);
        if (est > 7000) {
          state = triggerCompressionIfNeeded(state, memoryMode);
          const rc = buildBuilderPrompt(state, relevant, lastOut, params.prompt, memoryMode);
          builderPrompt = rc.prompt;
        } else { builderPrompt = structured; }
      } catch (err) { logger.warn("[SmartCompression] Failed", { error: (err as Error).message }); }
    }
  }

  // ─── Inject Intelligence Card context ───
  if (params.includeProjectFiles && project.intelligenceCard) {
    const card = project.intelligenceCard;
    const cardContext = [
      "═══ PROJECT CONTEXT ═══",
      `Type: ${card.projectType} | Language: ${card.primaryLanguage} | Framework: ${card.framework}`,
      `Files: ${card.totalFiles} | Architecture: ${card.architecture}`,
      "",
      "┌─ FILE TREE",
      ...card.fileTree.slice(0, 50).map((f) =>
        ` ${f.isEntryPoint ? "▶" : " "} ${f.path} [${f.language}]${f.exports.length > 0 ? ` (${f.exports.slice(0, 5).join(", ")}${f.exports.length > 5 ? "..." : ""})` : ""}`
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
        ...card.apiEndpoints.slice(0, 15).map((r) => ` ${r.method} ${r.path}`),
        "",
      ] : []),
      ...(card.todos.length > 0 ? [
        "┌─ TODOs",
        ...card.todos.slice(0, 10).map((t) => ` • ${t}`),
        "",
      ] : []),
      "═══ END PROJECT CONTEXT ═══",
    ].join("\n");

    builderPrompt = `${cardContext}\n\n---\n\n${builderPrompt}`;
    logger.debug(`[IntelligenceCard] Injected metadata for ${card.totalFiles} files`);

    // ─── Phase 2: Fetch relevant file contents ───
    try {
      // Import the findRelevantFiles function
      const { findRelevantFiles: findRelevant } = await import("./projectIntelligence");
      const { readProjectFile } = await import("./projectFilesDisk");

      // Reconstruct a minimal card for relevance scoring
      const miniCard = {
        version: card.version || 1,
        generatedAt: card.generatedAt || "",
        projectType: (card.projectType as "code" | "business" | "mixed" | "data" | "unknown") || "unknown",
        primaryLanguage: card.primaryLanguage || "unknown",
        framework: card.framework || "custom",
        totalFiles: card.totalFiles || 0,
        totalSize: card.totalSize || 0,
        fileTree: card.fileTree.map((f: Record<string, unknown>) => ({
          path: String(f.path),
          name: String(f.name),
          size: Number(f.size),
          language: String(f.language),
          category: String(f.category || "unknown") as "code" | "document" | "data" | "config" | "image" | "binary",
          exports: Array.isArray(f.exports) ? f.exports as string[] : [],
          description: String(f.description || ""),
          isEntryPoint: Boolean(f.isEntryPoint),
        })),
        dependencyGraph: [],
        entities: (card.entities || []).map((e: Record<string, unknown>) => ({
          name: String(e.name),
          type: String(e.type || "other") as "person" | "company" | "product" | "technology" | "metric" | "date" | "location" | "other",
          context: String(e.context || ""),
        })),
        databaseTables: [],
        apiEndpoints: [],
        entryPoints: card.entryPoints || [],
        architecture: card.architecture || "flat",
        todos: card.todos || [],
        crossReferences: [],
        toLLMContext: () => "",
      };

      const relevantPaths = findRelevant(miniCard, effectivePrompt);

      if (relevantPaths.length > 0) {
        // Fetch contents from DISK (Hybrid Architecture)
        const matched: Array<{ path: string; content: string }> = [];
        for (const filePath of relevantPaths) {
          const content = await readProjectFile(run.projectId, filePath);
          if (content !== null) {
            matched.push({ path: filePath, content });
          }
        }

        if (matched.length > 0) {
          const fileContext = matched.map((c) =>
            `=== FILE: ${c.path} ===\n${c.content}\n=== END ${c.path} ===`
          ).join("\n\n");

          builderPrompt = `${fileContext}\n\n---\n\n${builderPrompt}`;
          logger.debug(`[IntelligenceCard] Phase 2: Injected ${matched.length}/${relevantPaths.length} relevant file contents (${fileContext.length} chars)`);
        }
      }
    } catch (err) {
      logger.warn("[IntelligenceCard] Phase 2 file fetch failed", { error: (err as Error).message });
      // Continue without file contents — card metadata still works
    }
  }

  // ─── Gitee setup ───
  let giteeConfig: { token: string; owner: string; repo: string; branch: string; basePath: string; promptNum: string } | null = null;
  if (giteeToken && project.giteeOwner && project.giteeRepo) {
    try {
      const tv = await validateToken(giteeToken);
      if (tv.valid && tv.user) {
        let to = project.giteeOwner, tr = project.giteeRepo;
        if (!to || !tr) {
          const repos = await listRepos(giteeToken, 1, 10);
          const existing = repos.find((r) => r.name === "swarm-studio");
          if (existing) { to = (existing.owner as { login: string }).login; tr = existing.name as string; }
          else { const nr = await createRepo(giteeToken, "swarm-studio", "AI Swarm Studio"); to = nr.owner.login; tr = nr.name; }
          await db.update(projects).set({ giteeOwner: to, giteeRepo: tr }).where(eq(projects.id, run.projectId));
        }
        const pr = await db.select({ count: sql<number>`count(*)` }).from(swarmRuns)
          .where(and(eq(swarmRuns.projectId, run.projectId), eq(swarmRuns.status, "completed")));
        giteeConfig = { token: giteeToken, owner: to!, repo: tr!, branch: project.giteeBranch ?? "master", basePath: (params.isTestRun ?? run.isTestRun) ? `test_data/${project.name}` : `responses/${project.name}`, promptNum: String((pr[0]?.count ?? 0) + 1).padStart(3, "0") };
      }
    } catch (err) { logger.error("[Gitee] Setup failed", { error: (err as Error).message }); }
  }

  await runPipelineAsync({
    db, ctx,
    input: {
      projectId: run.projectId,
      prompt: effectivePrompt,
      giteeToken,
      memoryMode,
      attachments: params.attachments,
      includeProjectFiles: params.includeProjectFiles,
      clientTraceId: params.clientTraceId,
      stateless: params.stateless,
    },
    swarmRunId, project: projectWithUserDefault, projectId: run.projectId, projectName: project.name,
    giteeConfig, memoryMode, useLegacy, legacyAgents, pipeline, builderPrompt, state, episodes,
    execCtx,
    autoApprove,
    batchId: run.batchId ?? undefined,
    chain: params.chain,
    // A `run_only` share is as restricted as a buyer run: the step prompts,
    // the context and the intermediates are the grantor's, and this run lives
    // under the RECIPIENT's project where any of their read surfaces could see
    // it. A `full` grantee is entitled to the definition, so their run keeps
    // the ordinary audit summary.
    restricted: Boolean(params.protectedRun) || params.sharedRun?.mode === "run_only",
  });
}

// ─── resumePipeline source (mirrors the old resumePipeline mutation body) ───
async function runResumedPipeline(opts: {
  db: ReturnType<typeof getDb>;
  run: typeof swarmRuns.$inferSelect;
  userId: number;
  swarmRunId: number;
  project: typeof projects.$inferSelect;
  giteeToken?: string;
  memoryMode: MemoryMode;
  pipeline: ResolvedStep[] | null;
}) {
  const { db, run, userId, swarmRunId, project, giteeToken, memoryMode, pipeline } = opts;
  const ctx = { user: { id: userId } };

  // Load execution state
  const execState = run.executionState as {
    currentIndex: number; chain: Array<{ id: number; content: string; agentRole: string; agentName: string }>;
    iterationCounts: Record<number, number>; modifyInstructions?: string;
  } | null;

  if (!execState) throw new Error("No execution state to resume");
  if (!pipeline || pipeline.length === 0) throw new Error("No pipeline configured");

  const execCtx: ExecCtx = {
    currentIndex: execState.currentIndex,
    chain: execState.chain as unknown as typeof agentResponses.$inferSelect[],
    iterationCounts: new Map(Object.entries(execState.iterationCounts ?? {}).map(([k, v]) => [parseInt(k), v as number])),
    visitCounts: new Map(),
    modifyInstructions: execState.modifyInstructions,
  };

  // State & memory
  let state: ProjectState | null = null;
  let episodes: Episode[] = [];

  if (giteeToken && project.giteeOwner && project.giteeRepo) {
    try {
      const loaded = await loadProjectState(giteeToken, project.giteeOwner, project.giteeRepo, project.name, project.giteeBranch ?? "master");
      state = loaded.state;
      episodes = loaded.episodes;
    } catch { /* ignore */ }
  }

  // Gitee config
  let giteeConfig: { token: string; owner: string; repo: string; branch: string; basePath: string; promptNum: string } | null = null;
  if (giteeToken && project.giteeOwner && project.giteeRepo) {
    try {
      const tv = await validateToken(giteeToken);
      if (tv.valid && tv.user) {
        giteeConfig = { token: giteeToken, owner: project.giteeOwner, repo: project.giteeRepo, branch: project.giteeBranch ?? "master", basePath: `swarm_studio/${project.name}`, promptNum: "" };
      }
    } catch (err) { logger.error("[Gitee] Resume setup failed", { error: (err as Error).message }); }
  }

  // Check for modify instructions
  const modifyInstructions = execState.modifyInstructions;

  // ─── Enrich builder prompt with project files for resume ───
  let resumeBuilderPrompt = modifyInstructions ?? (run.userPrompt ?? "");
  if (project.intelligenceCard) {
    try {
      const card = project.intelligenceCard as any;
      const cardContext = [
        "═══ PROJECT CONTEXT ═══",
        `Type: ${card.projectType} | Language: ${card.primaryLanguage} | Framework: ${card.framework ?? "none"}`,
        `Architecture: ${card.architecture ?? "unknown"}`,
        card.fileTree ? `\nFile Tree:\n${card.fileTree.slice(0, 30).map((f: any) => `  ${f.path} (${f.language ?? "?"}) — ${f.description ?? ""}`).join("\n")}` : "",
        card.entryPoints ? `\nEntry Points: ${card.entryPoints.join(", ")}` : "",
        card.databaseTables ? `\nDatabase: ${card.databaseTables.map((t: any) => t.name).join(", ")}` : "",
        "═══ END PROJECT CONTEXT ═══",
      ].filter(Boolean).join("\n");
      resumeBuilderPrompt = `${cardContext}\n\n---\n\n${resumeBuilderPrompt}`;

      // Phase 2: inject relevant file contents
      const { findRelevantFiles } = await import("./projectIntelligence");
      const { readProjectFile } = await import("./projectFilesDisk");
      const relevantPaths = findRelevantFiles(card, run.userPrompt ?? "");
      const matched: Array<{ path: string; content: string }> = [];
      for (const filePath of relevantPaths.slice(0, 5)) {
        const content = await readProjectFile(project.id, filePath);
        if (content) matched.push({ path: filePath, content: content.substring(0, 8000) });
      }
      if (matched.length > 0) {
        const fileContext = matched.map(c => `=== FILE: ${c.path} ===\n${c.content}\n=== END ${c.path} ===`).join("\n\n");
        resumeBuilderPrompt = `${fileContext}\n\n---\n\n${resumeBuilderPrompt}`;
      }
    } catch (err) {
      logger.warn("[Resume] Failed to inject project context", { error: (err as Error).message });
    }
  }

  await runPipelineAsync({
    db, ctx,
    input: { projectId: project.id, prompt: run.userPrompt ?? "", giteeToken, memoryMode, attachments: undefined, includeProjectFiles: true, clientTraceId: `resume-${Date.now()}` },
    swarmRunId, project, projectId: project.id, projectName: project.name,
    giteeConfig, memoryMode, useLegacy: false, legacyAgents: [], pipeline,
    builderPrompt: resumeBuilderPrompt, state, episodes, execCtx,
    batchId: run.batchId ?? undefined,
    chain: (run.runParams as SwarmRunParams | null)?.chain,
  });
}
