// MCP tools: the private-evaluation workbench (offering redesign v2, spec
// §4/§9/§10.1). Owner decision D9 makes MCP the primary interface for the agent
// work, so these are the real way to run a benchmark — not a copy of the tRPC
// router. Every handler is a thin adapter over api/services/benchmark:
// authorization, provider ownership, plan hashing, spend approval and the
// ledger all live in the service, so a desktop client cannot bypass any of it.
//
// Money rule inherited from the service: nothing is spent until
// quote → approve → start completes with the SAME plan hash, and every provider
// call is appended to call_attempts.

import { z } from "zod";
import type { McpTool, McpAuthContext } from "../types";
import { JUDGE_PROMPT_VARIANTS } from "../../../contracts/offeringV2";
import {
  approveBenchmarkSpend, cancelBenchmark, createBenchmarkDraft, getBenchmarkProgress,
  listBenchmarkSummaries, prepareCasesDraft, prepareRubricDraft, quoteBenchmark, resumeBenchmark, startBenchmark,
  RUBRIC_PRESETS,
} from "../../services/benchmark/benchmarkService";
import { dispatchBenchmarkStart } from "../../workers/benchmarkWorker";

const RUBRIC_PRESET_NAMES = Object.keys(RUBRIC_PRESETS) as [string, ...string[]];

const idSchema = z.object({ benchmarkId: z.number().int().positive() });

const statusInputSchema = idSchema.extend({
  includePlan: z.boolean().default(false).describe("Return the entire frozen plan, case texts included. Off by default: the plan is already on `preview_evidence`, and a poll should not re-send it."),
});

const rubricDimensionSchema = z.object({
  dimension: z.string().min(1).max(60).describe("Dimension name, e.g. 'accuracy'"),
  weight: z.number().positive().max(100).describe("Relative weight; normalized to sum 1 server-side"),
  lowerBound: z.number().default(0).describe("Lowest score the judge may give"),
  upperBound: z.number().default(10).describe("Highest score the judge may give"),
  anchor: z.string().max(500).default("").describe("What the top and bottom scores mean"),
});

const caseSchema = z.object({
  inputText: z.string().min(1).max(20000).describe("An actual task input you would send this workflow"),
  expectedOutput: z.string().max(20000).optional().describe("Reference answer, if you have one (shown to the judge as reference material)"),
  origin: z.enum(["user", "generated", "paraphrase"]).default("user"),
  baseCaseId: z.string().max(60).optional(),
  stableCaseId: z.string().max(60).optional().describe("Keep the existing id when editing a case list so recorded attempts still line up"),
});

const candidateSchema = z.object({
  label: z.string().min(1).max(60).optional(),
  overrideModel: z.string().max(120).optional().describe("Run EVERY model-backed step of the frozen workflow on this model"),
  overrideProviderId: z.number().int().positive().optional(),
  isFrontierSoloBaseline: z.boolean().optional().describe("compare_frontier_solo: answer the task directly with one prompt, no workflow"),
  baselinePrompt: z.string().max(20000).optional(),
  existingResponseId: z.number().int().positive().optional().describe("Grade THIS owned prior output instead of regenerating (grade_only). Costs no generation call."),
});

const judgeSchema = z.object({
  providerId: z.number().int().positive().describe("A provider YOU own and have enabled"),
  model: z.string().min(1).max(120),
  /** D12: which of the three canonical judge prompt framings this slot carries. */
  variant: z.enum(JUDGE_PROMPT_VARIANTS).optional().describe("Prompt variant for this judge (D12). An evidence-grade panel needs 3 judges from 3 different model developers each declaring a DIFFERENT variant — every output is then rated 9 times (3 judges × 3 prompts). Omit for a private evaluation and the panel runs the original single prompt, quoted and billed exactly as before."),
});

const createInputSchema = z.object({
  projectId: z.number().int().positive().describe("The workflow you own that this evaluates"),
  executionMode: z.enum(["grade_only", "compare_models", "compare_frontier_solo"]).default("grade_only"),
  cases: z.array(caseSchema.omit({ stableCaseId: true })).min(1).max(50),
  judges: z.array(judgeSchema).min(1).max(5).describe("The judging panel; one judge is honest, five costs 5x. To publish the result as evidence (D12) it must be EXACTLY 3 judges from 3 different model developers with 3 different prompt variants, none sharing a developer with any generating model — anything less runs privately only, and quote_benchmark says which."),
  candidates: z.array(candidateSchema).max(4).optional(),
  generationRepeats: z.number().int().min(1).max(5).optional().describe("Independent repetitions per case (1 by default)"),
  judgmentKind: z.enum(["rubric", "pairwise"]).optional().describe("pairwise requires exactly two candidates"),
  pairedRepeatIndexes: z.array(z.number().int().min(1).max(5)).max(5).optional(),
  rubricPreset: z.enum(RUBRIC_PRESET_NAMES).optional().describe("Start from a local template; loading one makes no paid call"),
});

const quoteToolResult = (quote: Awaited<ReturnType<typeof quoteBenchmark>>) => ({
  ...quote,
  howToReadThis: "planHash binds the approval: change anything (cases, candidates, judges including their D12 prompt variants, rubric, limits, repeats) and start is refused until you re-quote and re-approve. generationCalls counts provider LLM calls; with declared variants each output is judged once per judge per variant (a 3-judge × 3-variant panel = 9 ratings per output, and judgingCalls reflects that). blockingErrors must be empty before approval is possible. panel.evidenceGrade tells you whether this result could ever be published as evidence: false means it is a PRIVATE evaluation (quote.warnings names the exact panel rule it misses — publishing it later is refused). Unknown prices are shown as unknown, never zero. rates[] tells you what the estimate used: source provider_list is the host's own published price as of pricingAsOf, price_vector is our fallback table — neither sees promotional, committed-use or cached-input discounts, so the real bill can be lower. The estimate assumes 2,000/1,200 tokens per generation and 3,000/300 per judging call; long answers cost more than quoted.",
});

export const createBenchmarkTool: McpTool = {
  name: "create_benchmark",
  description:
    "Create a PRIVATE evaluation draft for one of your workflows (nothing publishes and nothing is spent yet). Default mode grade_only scores the workflow as configured — pass candidates[].existingResponseId to grade an output you already have instead of regenerating it. compare_models runs the same frozen workflow on each model you name; compare_frontier_solo adds a direct-answer baseline. Then: prepare_benchmark_rubric / prepare_benchmark_cases to adjust, quote_benchmark, approve_benchmark_spend, start_benchmark.",
  inputSchema: createInputSchema,
  requiredScopes: ["mcp:write"],
  featureFlag: "v2Benchmarks",
  annotations: { readOnlyHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const parsed = createInputSchema.parse(args);
    const benchmarkId = await createBenchmarkDraft({
      userId: ctx.userId,
      projectId: parsed.projectId,
      executionMode: parsed.executionMode,
      cases: parsed.cases,
      judges: parsed.judges,
      candidates: parsed.candidates,
      generationRepeats: parsed.generationRepeats,
      judgmentKind: parsed.judgmentKind,
      pairedRepeatIndexes: parsed.pairedRepeatIndexes,
    });

    let rubric = "preset-generic-v1 (default)";
    if (parsed.rubricPreset) {
      const prepared = await prepareRubricDraft({ userId: ctx.userId, benchmarkId, preset: parsed.rubricPreset });
      if (!prepared.ok) throw new Error(prepared.error);
      rubric = prepared.rubric.versionRef;
    }
    return {
      benchmarkId,
      executionMode: parsed.executionMode,
      rubric,
      cases: parsed.cases.length,
      judges: parsed.judges.length,
      next: "quote_benchmark → approve_benchmark_spend(planHash) → start_benchmark(planHash, spendApprovalId)",
    };
  },
};

const prepareRubricInputSchema = z.object({
  benchmarkId: z.number().int().positive(),
  preset: z.enum(RUBRIC_PRESET_NAMES).optional(),
  dimensions: z.array(rubricDimensionSchema).min(1).max(6).optional(),
});

export const prepareBenchmarkRubricTool: McpTool = {
  name: "prepare_benchmark_rubric",
  description:
    "Set or normalize a draft's rubric: load a local preset (generic / translation / code) or supply your own dimensions. Weights are normalized server-side to sum to 1 and every judgment records the bounds and weights used. Makes NO provider call. Templates are starting points, not validated domain expertise. Changing the rubric invalidates an earlier spend approval, which is intended.",
  inputSchema: prepareRubricInputSchema,
  requiredScopes: ["mcp:write"],
  featureFlag: "v2Benchmarks",
  annotations: { readOnlyHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = prepareRubricInputSchema.parse(args);
    const res = await prepareRubricDraft({ userId: ctx.userId, ...input });
    if (!res.ok) throw new Error(res.error);
    return {
      rubricVersionRef: res.rubric.versionRef,
      dimensions: res.rubric.dimensions.map((d) => ({
        dimension: d.dimension, range: `${d.lowerBound}-${d.upperBound}`, weight: Number(d.weight.toFixed(6)),
      })),
      next: "Re-quote: the plan hash covers the rubric.",
    };
  },
};

const prepareCasesInputSchema = z.object({
  benchmarkId: z.number().int().positive(),
  cases: z.array(caseSchema).min(1).max(50),
});

export const prepareBenchmarkCasesTool: McpTool = {
  name: "prepare_benchmark_cases",
  description:
    "Replace a draft's case list with your own task inputs: trimmed, duplicates dropped, capped at 50, with stable ids preserved when you edit an existing case so a later resume still matches recorded attempts. Anything dropped is reported, never silently discarded. Makes NO provider call — generated or paraphrased variants cost money and would need their own approval.",
  inputSchema: prepareCasesInputSchema,
  requiredScopes: ["mcp:write"],
  featureFlag: "v2Benchmarks",
  annotations: { readOnlyHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = prepareCasesInputSchema.parse(args);
    const res = await prepareCasesDraft({ userId: ctx.userId, ...input });
    if (!res.ok) throw new Error(res.error);
    return {
      cases: res.cases.map((c) => ({ stableCaseId: c.stableCaseId, inputText: c.inputText.slice(0, 160) })),
      dropped: res.dropped,
      next: "Re-quote: the call plan is cases × candidates × repeats.",
    };
  },
};

export const quoteBenchmarkTool: McpTool = {
  name: "quote_benchmark",
  description:
    "The honest cost preflight before any spend: planned provider calls broken down per candidate, estimated costs (unknown where a model has no approved price entry — never zero), disclosed upper-bound assumptions, and blockingErrors that must be empty before approval is possible. Read-only: it writes nothing. Returns the planHash used by approve_benchmark_spend and start_benchmark. Show this table to the user before asking them to approve.",
  inputSchema: idSchema,
  requiredScopes: ["mcp:read"],
  featureFlag: "v2Benchmarks",
  annotations: { readOnlyHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const { benchmarkId } = idSchema.parse(args);
    return quoteToolResult(await quoteBenchmark({ userId: ctx.userId, benchmarkId }));
  },
};

const approveInputSchema = z.object({
  benchmarkId: z.number().int().positive(),
  planHash: z.string().length(64).describe("planHash exactly as quote_benchmark returned it"),
  ceilingUsd: z.number().positive().max(1000).optional().describe("Optional spend ceiling; best-effort where billing data is incomplete"),
});

export const approveBenchmarkSpendTool: McpTool = {
  name: "approve_benchmark_spend",
  description:
    "Authorize spending on the exact plan whose hash the user was quoted, using THEIR OWN enabled provider credentials (owner-funded private evaluation). The hash is recomputed server-side, so approving a plan the caller never saw is not possible. Approvals expire and are consumed exactly once; any later edit invalidates them.",
  inputSchema: approveInputSchema,
  requiredScopes: ["mcp:write"],
  featureFlag: "v2Benchmarks",
  annotations: { readOnlyHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = approveInputSchema.parse(args);
    const spendApprovalId = await approveBenchmarkSpend({ userId: ctx.userId, ...input });
    return { spendApprovalId, next: "start_benchmark with the same planHash and this spendApprovalId." };
  },
};

const startInputSchema = z.object({
  benchmarkId: z.number().int().positive(),
  planHash: z.string().length(64),
  spendApprovalId: z.number().int().positive(),
  idempotencyKey: z.string().min(1).max(120).optional().describe("Retrying with the same key returns the existing started plan"),
});

export const startBenchmarkTool: McpTool = {
  name: "start_benchmark",
  description:
    "Freeze the approved plan and queue it: your workflow is captured as an immutable version, every candidate runs against that snapshot (never your mutable project), and one child is planned per case × candidate × repeat. If anything changed since the quote this is REFUSED with plan_changed — re-quote and re-approve. Progress via benchmark_status; completion never publishes anything.",
  inputSchema: startInputSchema,
  requiredScopes: ["mcp:write"],
  featureFlag: "v2Benchmarks",
  annotations: { readOnlyHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = startInputSchema.parse(args);
    const res = await startBenchmark({ userId: ctx.userId, ...input });
    if (!res.ok) throw new Error(res.error);
    await dispatchBenchmarkStart(input.benchmarkId).catch(() => { /* reconciler re-dispatches queued rows */ });
    return { benchmarkId: input.benchmarkId, state: res.state, next: "Poll benchmark_status. Results stay private until you publish them." };
  },
};

export const benchmarkStatusTool: McpTool = {
  name: "benchmark_status",
  description:
    "One benchmark: state, child progress, the SHAPE of the frozen plan it runs (counts, judges, rubric, planHash — not every case text; pass includePlan:true for the full plan), observed cost with its completeness, and the descriptive summary once final. 'completed' means every planned output and judgment exists — it is NOT a quality verdict, and no confidence interval, ranking or certification language is produced. Grade-only results carry no winning-model field at all.",
  inputSchema: statusInputSchema,
  requiredScopes: ["mcp:read"],
  featureFlag: "v2Benchmarks",
  annotations: { readOnlyHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const { benchmarkId, includePlan } = statusInputSchema.parse(args);
    const progress = await getBenchmarkProgress({ userId: ctx.userId, benchmarkId, includePlan });
    if (!progress) throw new Error("not_found_or_not_authorized");
    return progress;
  },
};

const listInputSchema = z.object({ limit: z.number().int().min(1).max(50).default(20) });

export const listBenchmarksTool: McpTool = {
  name: "list_benchmarks",
  description: "Your own benchmarks, newest first: state, evidence availability, child progress (completed/failed/pending/running of the planned children), the best descriptive score under its own rubric, and observed cost with its completeness — so 'how is it going and what has it cost' has one cheap answer. Private to you.",
  inputSchema: listInputSchema,
  requiredScopes: ["mcp:read"],
  featureFlag: "v2Benchmarks",
  annotations: { readOnlyHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const { limit } = listInputSchema.parse(args);
    return listBenchmarkSummaries({ userId: ctx.userId, limit });
  },
};

export const cancelBenchmarkTool: McpTool = {
  name: "cancel_benchmark",
  description:
    "Cancel a draft, queued or running benchmark. Running plans stop dispatching new work at the next checkpoint; provider calls already incurred stay recorded in the attempt ledger and are not refunded. Finished children, judgments and cost records are retained — nothing is deleted, and a cancelled plan can be resumed later.",
  inputSchema: idSchema,
  requiredScopes: ["mcp:write"],
  featureFlag: "v2Benchmarks",
  annotations: { readOnlyHint: false, destructiveHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const { benchmarkId } = idSchema.parse(args);
    return cancelBenchmark({ userId: ctx.userId, benchmarkId });
  },
};

const resumeInputSchema = z.object({
  benchmarkId: z.number().int().positive(),
  spendApprovalId: z.number().int().positive().describe("A FRESH approval for the frozen planHash — resuming spends again"),
  retryFailed: z.boolean().optional().describe("Set only to re-run children that failed; unfinished children always continue"),
});

export const resumeBenchmarkTool: McpTool = {
  name: "resume_benchmark",
  description:
    "Continue a cancelled/partial/failed benchmark under its FROZEN plan. Completed children and recorded judgments are never re-run and call_attempts are never rewritten — a retry APPENDS a new attempt. Because resuming spends again it needs a fresh approval for the same planHash (quote_benchmark → approve_benchmark_spend). Refuses with nothing_left_to_do rather than consuming an approval.",
  inputSchema: resumeInputSchema,
  requiredScopes: ["mcp:write"],
  featureFlag: "v2Benchmarks",
  annotations: { readOnlyHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = resumeInputSchema.parse(args);
    const res = await resumeBenchmark({ userId: ctx.userId, ...input });
    if (!res.ok) throw new Error(res.error);
    await dispatchBenchmarkStart(input.benchmarkId).catch(() => { /* reconciler retries */ });
    return res;
  },
};

export const BENCHMARK_TOOLS: McpTool[] = [
  createBenchmarkTool,
  prepareBenchmarkRubricTool,
  prepareBenchmarkCasesTool,
  quoteBenchmarkTool,
  approveBenchmarkSpendTool,
  startBenchmarkTool,
  benchmarkStatusTool,
  listBenchmarksTool,
  cancelBenchmarkTool,
  resumeBenchmarkTool,
];
