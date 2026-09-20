// tRPC router: private evaluation benchmarks (offering redesign v2, spec
// §10.1). Thin procedures over benchmarkService — all authorization,
// provider ownership, plan-freeze and spend-approval logic lives in the
// shared service. Flag-gated by `v2Benchmarks`.

import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import { isFeatureEnabled } from "../plugins/featureFlags";
import { desc, eq } from "drizzle-orm";
import { benchmarks } from "@db/schema";
import { getDb } from "../queries/connection";
import {
  approveBenchmarkSpend, cancelBenchmark, createBenchmarkDraft, getBenchmarkProgress,
  prepareCasesDraft, prepareRubricDraft, quoteBenchmark, resumeBenchmark, startBenchmark,
  updateBenchmarkDraft,
} from "../services/benchmark/benchmarkService";
import { dispatchBenchmarkStart } from "../workers/benchmarkWorker";

async function assertV2(userId: number) {
  if (!(await isFeatureEnabled("v2Benchmarks", userId))) {
    throw new Error("Private evaluation (v2Benchmarks) is not enabled for this account yet.");
  }
}

const caseSchema = z.object({
  inputText: z.string().min(1).max(20000),
  origin: z.enum(["user", "generated", "paraphrase"]).default("user"),
  baseCaseId: z.string().max(60).optional(),
  expectedOutput: z.string().max(20000).optional(),
});

/** Mirrors the service RubricSpec (spec §6.3 weights + §7.1 anchors). */
const rubricDimensionSchema = z.object({
  dimension: z.string().min(1).max(60),
  lowerBound: z.number().default(0),
  upperBound: z.number().default(10),
  weight: z.number().min(0).max(1),
  anchor: z.string().max(500).default(""),
});
const rubricSchema = z.object({
  versionRef: z.string().min(1).max(120),
  dimensions: z.array(rubricDimensionSchema).min(1).max(6),
  normalizedWeights: z.array(z.number().min(0).max(1)).min(1).max(6),
});

const candidateSchema = z.object({
  label: z.string().min(1).max(60).optional(),
  overrideModel: z.string().max(120).optional(),
  overrideProviderId: z.number().int().positive().optional(),
  isFrontierSoloBaseline: z.boolean().optional(),
  baselinePrompt: z.string().max(20000).optional(),
  /** A01: grade this owned prior output instead of generating one. */
  existingResponseId: z.number().int().positive().optional(),
});

/** Validators are accepted only in their DISABLED form: this deployment has no
 *  isolated execution sandbox, so spec §7.1 forbids enabling them. */
const validatorSchema = z.object({
  kind: z.enum(["schema", "expected_value", "owner_test"]),
  enabled: z.literal(false),
  disabledReason: z.string().min(1).max(500),
});

const draftCore = {
  projectId: z.number().int().positive(),
  /** Grade-only is the Test journey default (spec §4.1, A01). */
  executionMode: z.enum(["grade_only", "compare_models", "compare_frontier_solo"]).default("grade_only"),
  cases: z.array(caseSchema).min(1).max(50),
  judges: z.array(z.object({ providerId: z.number().int().positive(), model: z.string().min(1).max(120) })).min(1).max(5),
  candidates: z.array(candidateSchema).max(4).optional(),
  generationRepeats: z.number().int().min(1).max(5).optional(),
  judgmentKind: z.enum(["rubric", "pairwise"]).optional(),
  pairedRepeatIndexes: z.array(z.number().int().min(1).max(5)).max(5).optional(),
  listingId: z.number().int().positive().nullish(),
};

export const benchmarkRouter = createRouter({
  create: authedQuery
    .input(z.object(draftCore))
    .mutation(async ({ input, ctx }) => {
      await assertV2(ctx.user.id);
      const id = await createBenchmarkDraft({ userId: ctx.user.id, ...input });
      return { benchmarkId: id };
    }),

  updateDraft: authedQuery
    .input(z.object({
      benchmarkId: z.number().int().positive(),
      draft: z.object({
        schemaVersion: z.literal(1),
        executionMode: z.enum(["grade_only", "compare_models", "compare_frontier_solo"]),
        cases: z.array(caseSchema).min(1).max(50),
        candidates: z.array(z.object({
          stableCandidateId: z.string().min(1).max(60),
          strategy: z.enum(["pipeline", "solo_baseline", "imported_output"]),
          baseVersionId: z.number().int().optional(),
          overrideModel: z.string().max(120).optional(),
          overrideProviderId: z.number().int().positive().optional(),
          baselinePrompt: z.string().max(20000).optional(),
          importedResponseId: z.number().int().positive().optional(),
          decoding: z.object({ temperature: z.number().optional(), maxTokens: z.number().optional() }),
        })).max(4),
        judges: z.array(z.object({ slot: z.number().int().min(1), providerId: z.number().int().positive(), model: z.string().min(1).max(120) })).min(1).max(5),
        rubric: rubricSchema,
        validators: z.array(validatorSchema).max(4).default([]),
        generationRepeats: z.number().int().min(1).max(5),
        judgmentKind: z.enum(["rubric", "pairwise"]),
        limits: z.object({ maxConcurrency: z.number().int().min(1).max(10), deadlineMs: z.number().int().min(10_000).max(3_600_000), maxTokensPerCall: z.number().int().min(1) }),
      }),
    }))
    .mutation(async ({ input, ctx }) => {
      await assertV2(ctx.user.id);
      return updateBenchmarkDraft({
        userId: ctx.user.id, benchmarkId: input.benchmarkId,
        draft: input.draft as unknown as Parameters<typeof updateBenchmarkDraft>[0]["draft"],
      });
    }),

  quote: authedQuery
    .input(z.object({ benchmarkId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      await assertV2(ctx.user.id);
      return quoteBenchmark({ userId: ctx.user.id, benchmarkId: input.benchmarkId });
    }),

  /** Draft-stage rubric prep. Presets and manual dimensions are local only —
   *  this procedure makes no provider call (spec §10.1). */
  prepareRubric: authedQuery
    .input(z.object({
      benchmarkId: z.number().int().positive(),
      preset: z.string().min(1).max(40).optional(),
      dimensions: z.array(rubricDimensionSchema.extend({ weight: z.number().positive().max(1) })).min(1).max(6).optional(),
      llmAssist: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      await assertV2(ctx.user.id);
      return prepareRubricDraft({ userId: ctx.user.id, ...input });
    }),

  /** Draft-stage case-list normalization (trim, dedupe, stable IDs). Local
   *  only; LLM-generated variants would need their own spend approval. */
  prepareCases: authedQuery
    .input(z.object({
      benchmarkId: z.number().int().positive(),
      cases: z.array(caseSchema.extend({ stableCaseId: z.string().max(60).optional() })).min(1).max(50),
      llmExpand: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      await assertV2(ctx.user.id);
      return prepareCasesDraft({ userId: ctx.user.id, ...input });
    }),

  approveSpend: authedQuery
    .input(z.object({
      benchmarkId: z.number().int().positive(),
      planHash: z.string().length(64),
      ceilingUsd: z.number().positive().max(1000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      await assertV2(ctx.user.id);
      const id = await approveBenchmarkSpend({ userId: ctx.user.id, benchmarkId: input.benchmarkId, planHash: input.planHash, ceilingUsd: input.ceilingUsd });
      return { spendApprovalId: id };
    }),

  start: authedQuery
    .input(z.object({
      benchmarkId: z.number().int().positive(),
      planHash: z.string().length(64),
      spendApprovalId: z.number().int().positive(),
      idempotencyKey: z.string().min(1).max(120).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      await assertV2(ctx.user.id);
      const res = await startBenchmark({ userId: ctx.user.id, ...input });
      if (res.ok) await dispatchBenchmarkStart(input.benchmarkId);
      return res;
    }),

  get: authedQuery
    .input(z.object({ benchmarkId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      await assertV2(ctx.user.id);
      return await getBenchmarkProgress({ userId: ctx.user.id, benchmarkId: input.benchmarkId });
    }),

  cancel: authedQuery
    .input(z.object({ benchmarkId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      await assertV2(ctx.user.id);
      return cancelBenchmark({ userId: ctx.user.id, benchmarkId: input.benchmarkId });
    }),

  /** Continue a cancelled/interrupted plan under its frozen hash. Needs a
   *  fresh spend approval because resuming spends again; completed children
   *  and recorded attempts are never re-run (A06). */
  resume: authedQuery
    .input(z.object({
      benchmarkId: z.number().int().positive(),
      spendApprovalId: z.number().int().positive(),
      retryFailed: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      await assertV2(ctx.user.id);
      const res = await resumeBenchmark({ userId: ctx.user.id, ...input });
      if (res.ok) await dispatchBenchmarkStart(input.benchmarkId);
      return res;
    }),

  list: authedQuery
    .input(z.object({ limit: z.number().int().min(1).max(50).default(20) }))
    .query(async ({ ctx, input }) => {
      await assertV2(ctx.user.id);
      const db = getDb();
      return db.select({
        id: benchmarks.id, executionMode: benchmarks.executionMode, state: benchmarks.state,
        aggregateAvailability: benchmarks.aggregateAvailability,
        createdAt: benchmarks.createdAt, finishedAt: benchmarks.finishedAt,
      }).from(benchmarks).where(eq(benchmarks.ownerId, ctx.user.id)).orderBy(desc(benchmarks.id)).limit(input.limit);
    }),
});
