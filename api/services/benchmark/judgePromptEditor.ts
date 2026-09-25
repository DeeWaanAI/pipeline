import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { benchmarks } from "@db/schema";
import { JudgePromptOverridesSchema, type JudgePromptOverrides } from "../../../contracts/offeringV2";
import { getDb } from "../../queries/connection";
import type { BenchmarkCallPlan } from "./benchmarkTypes";
import { previewJudgePrompts } from "./judgeService";

const revisionOf = (plan: string) => createHash("sha256").update(plan).digest("hex");

async function loadOwned(userId: number, benchmarkId: number) {
  const [benchmark] = await getDb().select().from(benchmarks)
    .where(and(eq(benchmarks.id, benchmarkId), eq(benchmarks.ownerId, userId))).limit(1);
  if (!benchmark) throw new Error("Benchmark not found");
  if (!benchmark.plan) throw new Error("This benchmark has no saved judging plan");
  return { benchmark, plan: JSON.parse(benchmark.plan) as BenchmarkCallPlan };
}

export async function getJudgePromptEditor(opts: {
  userId: number; benchmarkId: number; overrides?: JudgePromptOverrides;
}) {
  const { benchmark, plan } = await loadOwned(opts.userId, opts.benchmarkId);
  const overrides = opts.overrides === undefined
    ? plan.judgePromptOverrides ?? {}
    : JudgePromptOverridesSchema.parse(opts.overrides);
  return {
    benchmarkId: benchmark.id,
    state: benchmark.state,
    editable: benchmark.state === "draft",
    revision: revisionOf(benchmark.plan!),
    judgmentKind: plan.judgmentKind,
    rubric: plan.rubric,
    judges: plan.judges,
    overrides,
    defaults: previewJudgePrompts({ ...plan, judgePromptOverrides: undefined }),
    prompts: previewJudgePrompts({ ...plan, judgePromptOverrides: overrides }),
  };
}

export async function saveJudgePromptEditor(opts: {
  userId: number; benchmarkId: number; expectedRevision: string; overrides: JudgePromptOverrides;
}) {
  const overrides = JudgePromptOverridesSchema.parse(opts.overrides);
  const { benchmark, plan } = await loadOwned(opts.userId, opts.benchmarkId);
  if (benchmark.state !== "draft") throw new Error("Started plans are immutable; create a new benchmark to change its judging prompts");
  if (revisionOf(benchmark.plan!) !== opts.expectedRevision) throw new Error("The judging plan changed. Reload before saving; your edits were not applied.");
  if (Object.keys(overrides).length) plan.judgePromptOverrides = overrides;
  else delete plan.judgePromptOverrides;
  const [result] = await getDb().update(benchmarks).set({ plan: JSON.stringify(plan) })
    .where(and(eq(benchmarks.id, benchmark.id), eq(benchmarks.ownerId, opts.userId),
      eq(benchmarks.state, "draft"), sql`BINARY ${benchmarks.plan} = BINARY ${benchmark.plan!}`));
  if (result.affectedRows !== 1) throw new Error("The judging plan changed or started. Reload before saving; your edits were not applied.");
  return getJudgePromptEditor({ userId: opts.userId, benchmarkId: opts.benchmarkId });
}
