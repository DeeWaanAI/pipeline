/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PLUGIN: Circuit Breaker
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Prevents runaway pipelines from burning excessive tokens/costs.
 * Checks limits BEFORE executing each pipeline step.
 *
 * Limits enforced:
 *   - maxTokens: total token budget per pipeline run (default: 50,000)
 *   - maxSpend: dollar limit per pipeline run (default: $5.00)
 *   - stepTimeout: seconds before a step is aborted (default: 60)
 *   - maxIterations: hard cap for WHILE loops (default: 5)
 *
 * This plugin is a SAFETY GUARD, not a billing system. It aborts the
 * pipeline with a clear error message when limits are exceeded.
 */

import { z } from "zod";
import { createRouter, authedQuery, adminQuery } from "../../middleware";
import type { PluginManifest } from "../registry";

// ─── Default limits ─────────────────────────────────────────────────
const DEFAULTS = {
  maxTokens: 50000,
  maxSpend: 5.0,     // USD
  stepTimeout: 60,   // seconds
  maxIterations: 5,  // WHILE loop cap
};

// ─── In-memory counter (per pipeline run) ───────────────────────────
// These are reset at the start of each pipeline execution.
interface RunCounters {
  totalTokens: number;
  totalCost: number;
  stepStartTime: number;
  whileIterations: Map<string, number>; // stepId -> count
}

const activeRuns = new Map<number, RunCounters>(); // runId -> counters

// ─── Public API ─────────────────────────────────────────────────────

export function startPipelineRun(runId: number, limits?: Partial<typeof DEFAULTS>) {
  activeRuns.set(runId, {
    totalTokens: 0,
    totalCost: 0,
    stepStartTime: Date.now(),
    whileIterations: new Map(),
  });
  return { ...DEFAULTS, ...limits };
}

export function endPipelineRun(runId: number) {
  activeRuns.delete(runId);
}

/**
 * Check if a step should be allowed to run.
 * Call this BEFORE each step execution.
 */
export function checkStep(
  runId: number,
  stepName: string,
  estimatedTokens: number,
  estimatedCost: number,
  limits: typeof DEFAULTS
): { allowed: true } | { allowed: false; reason: string } {
  const counters = activeRuns.get(runId);
  if (!counters) return { allowed: false, reason: "Pipeline run not initialized" };

  // Check token budget
  if (counters.totalTokens + estimatedTokens > limits.maxTokens) {
    return {
      allowed: false,
      reason: `Token limit exceeded: ${counters.totalTokens.toLocaleString()} + ${estimatedTokens.toLocaleString()} > ${limits.maxTokens.toLocaleString()} tokens. ` +
              `Pipeline aborted to prevent runaway costs.`,
    };
  }

  // Check spend budget
  if (counters.totalCost + estimatedCost > limits.maxSpend) {
    return {
      allowed: false,
      reason: `Cost limit exceeded: $${counters.totalCost.toFixed(2)} + $${estimatedCost.toFixed(2)} > $${limits.maxSpend.toFixed(2)}. ` +
              `Pipeline aborted to prevent runaway costs.`,
    };
  }

  // Check step timeout
  const elapsedMs = Date.now() - counters.stepStartTime;
  if (elapsedMs > limits.stepTimeout * 1000) {
    return {
      allowed: false,
      reason: `Step "${stepName}" timed out after ${(elapsedMs / 1000).toFixed(1)}s (limit: ${limits.stepTimeout}s).`,
    };
  }

  // Check WHILE loop iterations
  const currentCount = counters.whileIterations.get(stepName) || 0;
  if (currentCount >= limits.maxIterations) {
    return {
      allowed: false,
      reason: `WHILE loop "${stepName}" exceeded max iterations (${limits.maxIterations}). ` +
              `Possible infinite loop detected.`,
    };
  }

  return { allowed: true };
}

/**
 * Record actual token/cost usage after a step completes.
 */
export function recordStepUsage(
  runId: number,
  stepName: string,
  actualTokens: number,
  actualCost: number
) {
  const counters = activeRuns.get(runId);
  if (!counters) return;

  counters.totalTokens += actualTokens;
  counters.totalCost += actualCost;
  counters.stepStartTime = Date.now(); // Reset for next step

  // Increment WHILE counter
  const current = counters.whileIterations.get(stepName) || 0;
  counters.whileIterations.set(stepName, current + 1);
}

/**
 * Get current usage for a pipeline run.
 */
export function getRunUsage(runId: number) {
  const counters = activeRuns.get(runId);
  if (!counters) return null;
  return {
    totalTokens: counters.totalTokens,
    totalCost: counters.totalCost,
  };
}

// ─── tRPC Router ────────────────────────────────────────────────────

const circuitBreakerRouter = createRouter({
  /** Get current limits and usage for a pipeline run */
  getStatus: authedQuery
    .input(z.object({ runId: z.number() }))
    .query(async ({ input }) => {
      const usage = getRunUsage(input.runId);
      return {
        limits: DEFAULTS,
        usage: usage ?? { totalTokens: 0, totalCost: 0 },
      };
    }),

  /** Admin: update default limits (stored in feature flag metadata) */
  updateLimits: adminQuery
    .input(z.object({
      maxTokens: z.number().min(1000).max(500000).optional(),
      maxSpend: z.number().min(0.1).max(100).optional(),
      stepTimeout: z.number().min(5).max(300).optional(),
      maxIterations: z.number().min(1).max(50).optional(),
    }))
    .mutation(async ({ input }) => {
      if (input.maxTokens) DEFAULTS.maxTokens = input.maxTokens;
      if (input.maxSpend) DEFAULTS.maxSpend = input.maxSpend;
      if (input.stepTimeout) DEFAULTS.stepTimeout = input.stepTimeout;
      if (input.maxIterations) DEFAULTS.maxIterations = input.maxIterations;
      return { limits: DEFAULTS };
    }),
});

// ─── Plugin Manifest ────────────────────────────────────────────────

export const circuitBreakerPlugin: PluginManifest = {
  id: "circuit-breaker",
  name: "Circuit Breaker",
  description: "Prevents runaway pipelines with token/spend/timeout/iteration limits",
  version: "1.0.0",
  featureFlag: "circuit_breaker",
  router: circuitBreakerRouter,
};
