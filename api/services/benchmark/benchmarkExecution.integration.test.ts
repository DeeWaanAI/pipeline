// DB-backed execution drills for private evaluation (offering redesign v2,
// P2b gate: A01, A02, A06-resume, A07 wording, A08 ledger reconciliation).
// Requires the LOCAL docker stack. Uses its own throwaway schema
// (`swarm_v2test_exec`) because the other integration files run in parallel
// and each one drops + revokes its own database.
//
// The pipeline engine and the judge calls are the only fakes, so no external
// LLM traffic and no API keys are involved. Freeze, fan-out, ledger, judgment
// bookkeeping, summary, finalizer and resume are all the real code path.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";

/** What the fakes observed / how they misbehave, per test. */
const exec = vi.hoisted(() => ({
  calls: [] as Array<{ swarmRunId: number; versionId: number | undefined; stepModels: Array<string | null> }>,
  /** Case inputs whose generation should fail, to exercise partial + resume. */
  failInputs: new Set<string>(),
  /** Flip to false to make the adapter behave like a host that reports no usage. */
  reportUsage: true,
}));
const judge = vi.hoisted(() => ({ calls: 0, score: 7, reportUsage: true }));

vi.mock("../swarmService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../swarmService")>();
  return {
    ...actual,
    executeSwarmRun: async (params: { swarmRunId: number; userId: number }) => {
      const { getDb } = await import("../../queries/connection");
      const schema = await import("@db/schema");
      const { eq } = await import("drizzle-orm");
      const { loadVersionDefinition } = await import("./versionService");
      const db = getDb();
      const [run] = await db.select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, params.swarmRunId)).limit(1);
      const versionId = run.runParams?.snapshotVersionId;
      const { definition } = await loadVersionDefinition(versionId!);
      exec.calls.push({ swarmRunId: params.swarmRunId, versionId, stepModels: definition.steps.map((s) => s.model) });

      if (exec.failInputs.has(run.userPrompt)) {
        await db.update(schema.swarmRuns)
          .set({ status: "failed", error: "fake provider outage", completedAt: new Date() })
          .where(eq(schema.swarmRuns.id, params.swarmRunId));
        return;
      }
      // Model attribution belongs on the run row as well as the response metadata.
      let finalResponseId = 0;
      let totalTokens = 0;
      for (const step of definition.steps) {
        const stepOrder = Number(step.stepOrder ?? 1);
        // What the real adapters hand back when the host reports no usage at
        // all: zeros carrying `complete: false`, never a bare 0.
        const usage = exec.reportUsage
          ? { prompt: 120, completion: 30, total: 150, complete: true }
          : { prompt: 0, completion: 0, total: 0, complete: false };
        const [ar] = await db.insert(schema.agentRuns).values({
          swarmRunId: params.swarmRunId, projectId: run.projectId, agentName: "Fake", agentRole: step.role ?? "builder",
          pipelineStep: stepOrder, userPrompt: run.userPrompt, status: "completed",
          modelUsed: step.model ?? null,
        });
        const [resp] = await db.insert(schema.agentResponses).values({
          agentRunId: Number((ar as { insertId: number }).insertId), swarmRunId: params.swarmRunId,
          projectId: run.projectId, responseType: "final", content: `output for: ${run.userPrompt}`,
          metadata: {
            model: step.model ?? "unknown", provider: "fake", providerSlug: "fake",
            tokensUsed: usage, latencyMs: 5, temperature: 0.7,
            maxTokens: 1024, agentName: "Fake", agentRole: step.role ?? "builder", agentSlug: "fake",
            pipelineStep: stepOrder, iteration: 1, buildMethod: "fake", sourceResponseIds: [],
          },
        });
        finalResponseId = Number((resp as { insertId: number }).insertId);
        totalTokens += usage.total;
      }
      await db.update(schema.swarmRuns).set({
        status: "completed", finalResponseId,
        totalTokensUsed: totalTokens, completedAt: new Date(),
      }).where(eq(schema.swarmRuns.id, params.swarmRunId));
    },
  };
});

vi.mock("./judgeService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./judgeService")>();
  return {
    ...actual,
    generateJudgeCall: async (args: { judge: { model: string } }) => {
      judge.calls += 1;
      const scores = Object.fromEntries(["accuracy", "completeness", "instructionFit", "clarity"].map((d) => [d, judge.score]));
      return {
        content: JSON.stringify({ scores, rationale: "fake verdict" }),
        model: args.judge.model,
        // Same shape `generateJudgeCall` returns: counts plus whether the host
        // actually reported them.
        promptTokens: judge.reportUsage ? 400 : 0, completionTokens: judge.reportUsage ? 60 : 0,
        usageComplete: judge.reportUsage,
      };
    },
  };
});

const TEST_DB = "swarm_v2test_exec";
const ROOT_MYSQL = process.env.MYSQL_ROOT_URL || "mysql://root:rootpass@localhost:3307";

let svc: typeof import("./benchmarkService");
let schema: typeof import("@db/schema");
let eq: typeof import("drizzle-orm").eq;
let admin: mysql.Connection;

beforeAll(async () => {
  admin = await mysql.createConnection(ROOT_MYSQL);
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.query(`GRANT ALL PRIVILEGES ON \`${TEST_DB}\`.* TO 'swarm'@'%'`);
  await admin.query("FLUSH PRIVILEGES");
  process.env.DATABASE_URL = `mysql://swarm:swarmpass@localhost:3307/${TEST_DB}`;
  process.env.REDIS_URL = "";
  process.env.NODE_ENV = "development";
  process.env.APP_SECRET ||= "1".repeat(64);
  process.env.AI_SWARM_MASTER_KEY ||= "2".repeat(64);
  process.env.MARKETPLACE_MASTER_KEY ||= "3".repeat(64);
  await pushSchema();
  svc = await import("./benchmarkService");
  schema = await import("@db/schema");
  eq = (await import("drizzle-orm")).eq;
}, 300_000);

afterAll(async () => {
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.query(`REVOKE ALL PRIVILEGES ON \`${TEST_DB}\`.* FROM 'swarm'@'%'`);
    await admin.end();
  }
});

async function pushSchema() {
  const { execFileSync } = await import("node:child_process");
  execFileSync("npx", ["drizzle-kit", "push", "--force"], {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    stdio: "ignore",
    timeout: 150_000,
  });
}

async function connection() {
  return (await import("../../queries/connection")).getDb();
}

function resetFakes() {
  exec.calls = [];
  exec.failInputs.clear();
  judge.calls = 0;
  judge.score = 7;
  exec.reportUsage = true;
  judge.reportUsage = true;
}

/** Owner + provider + workflow. `gated` adds an if-step so A02 can prove the
 *  override reaches gate calls as well as agent steps. */
async function seedFixture(opts: { gated?: boolean; stepModel?: string; stepModels?: string[] } = {}) {
  const db = await connection();
  const stamp = `${Date.now()}-${Math.random()}`;
  const [u] = await db.insert(schema.users).values({ name: "Runner", email: `r-${stamp}@example.test`, tier: "pro_auto" });
  const userId = Number((u as { insertId: number }).insertId);
  const [p] = await db.insert(schema.projects).values({ userId, name: "Runner Project" });
  const projectId = Number((p as { insertId: number }).insertId);
  const [prov] = await db.insert(schema.llmProviders).values({
    userId, name: `fake-${stamp}`, slug: `fake-${stamp}`, baseUrl: "http://localhost:1", apiKeyRef: "dummy", defaultModel: "base-model",
  });
  const providerId = Number((prov as { insertId: number }).insertId);
  const modelAt = (stepOrder: number) => opts.stepModels?.[stepOrder - 1] ?? opts.stepModel ?? "base-model";
  const plain = (stepOrder: number, name: string, role: string, stepType = "agent") => ({
    projectId, stepOrder, stepType, name, role, systemPrompt: `${name} prompt`, isEnabled: true, providerId, model: modelAt(stepOrder),
  });
  await db.insert(schema.pipelineSteps).values(opts.gated
    ? [
      plain(1, "Draft", "builder"),
      { ...plain(2, "Quality gate", "critic", "if"), ifConfig: { options: ["pass", "revise"], mappings: { pass: 3, revise: 1 } } },
      plain(3, "Polish", "polisher"),
    ]
    : [plain(1, "Draft", "builder"), plain(2, "Polish", "polisher")]);
  return { db, userId, projectId, providerId };
}

/** A prior completed run of this owner, whose output can be graded (A01). */
async function seedPriorOutput(f: { userId: number; projectId: number }, content: string) {
  const db = await connection();
  const [run] = await db.insert(schema.swarmRuns).values({
    projectId: f.projectId, userId: f.userId, userPrompt: "an earlier task", status: "completed",
  });
  const swarmRunId = Number((run as { insertId: number }).insertId);
  const [ar] = await db.insert(schema.agentRuns).values({
    swarmRunId, projectId: f.projectId, agentName: "Earlier", agentRole: "builder",
    pipelineStep: 1, userPrompt: "an earlier task", status: "completed",
  });
  const [resp] = await db.insert(schema.agentResponses).values({
    agentRunId: Number((ar as { insertId: number }).insertId), swarmRunId, projectId: f.projectId,
    responseType: "final", content,
    metadata: {
      model: "model-of-yesterday", provider: "fake", providerSlug: "fake",
      tokensUsed: { prompt: 1, completion: 1, total: 2 }, latencyMs: 1, temperature: 0.7, maxTokens: 512,
      agentName: "Earlier", agentRole: "builder", agentSlug: "earlier", pipelineStep: 1, iteration: 1,
      buildMethod: "manual", sourceResponseIds: [],
    },
  });
  const responseId = Number((resp as { insertId: number }).insertId);
  await db.update(schema.swarmRuns).set({ finalResponseId: responseId }).where(eq(schema.swarmRuns.id, swarmRunId));
  return { swarmRunId, responseId };
}

const benchmark = async (id: number) => {
  const db = await connection();
  const [row] = await db.select().from(schema.benchmarks).where(eq(schema.benchmarks.id, id)).limit(1);
  return row;
};
const childrenOf = async (id: number) => {
  const db = await connection();
  return db.select().from(schema.benchmarkRuns).where(eq(schema.benchmarkRuns.benchmarkId, id));
};
const attemptsOf = async (id: number, kind: "generation" | "judgment") => {
  const db = await connection();
  const rows = await db.select().from(schema.callAttempts).where(eq(schema.callAttempts.benchmarkId, id));
  return rows.filter((r) => r.operationKind === kind);
};
const approval = async (id: number) => {
  const db = await connection();
  const [row] = await db.select().from(schema.spendApprovals).where(eq(schema.spendApprovals.id, id)).limit(1);
  return row;
};

/** draft → quote → approve → start → worker pass, all the real code. */
async function startAndExecute(input: Parameters<typeof svc.createBenchmarkDraft>[0]) {
  const benchmarkId = await svc.createBenchmarkDraft(input);
  const quote = await svc.quoteBenchmark({ userId: input.userId, benchmarkId });
  expect(quote.blockingErrors).toEqual([]);
  const spendApprovalId = await svc.approveBenchmarkSpend({ userId: input.userId, benchmarkId, planHash: quote.planHash });
  const started = await svc.startBenchmark({ userId: input.userId, benchmarkId, planHash: quote.planHash, spendApprovalId });
  expect(started.ok).toBe(true);
  const lease = await svc.acquireBenchmark(benchmarkId);
  expect(lease).toBeTruthy();
  await svc.executeBenchmark({ benchmarkId, leaseToken: lease! });
  return { benchmarkId, quote, spendApprovalId, bench: await benchmark(benchmarkId) };
}

describe("private evaluation execution (DB-backed)", () => {
  it("A01: grades an existing owned output — no regeneration, no generation spend", async () => {
    resetFakes();
    const f = await seedFixture();
    const prior = await seedPriorOutput(f, "the answer I already had");

    const { benchmarkId, quote, bench } = await startAndExecute({
      userId: f.userId, projectId: f.projectId,
      cases: [{ inputText: "task one" }, { inputText: "task two" }],
      judges: [{ providerId: f.providerId, model: "judge-model" }],
      candidates: [{ label: "prior-output", existingResponseId: prior.responseId }],
    });

    expect(quote.counts.generationCalls).toBe(0);
    expect(quote.counts.judgingCalls).toBe(2); // C × M × R × J = 2 × 1 × 1 × 1
    expect(quote.warnings.join("\n")).toContain("EXISTING output graded without regeneration");
    expect(quote.warnings.join("\n")).toContain("validators: DISABLED");

    expect(exec.calls).toHaveLength(0); // the engine was never invoked
    const children = await childrenOf(benchmarkId);
    expect(children).toHaveLength(2);
    expect(children.every((c) => c.status === "completed")).toBe(true);
    expect(children.every((c) => c.outputText === "the answer I already had")).toBe(true);
    expect(children.every((c) => c.linkedSwarmRunId == null)).toBe(true);
    expect(children.every((c) => (c.importedProvenance as { kind?: string })?.kind === "owned_run")).toBe(true);

    // The ledger reports what actually happened: judging was charged, nothing was generated.
    expect(await attemptsOf(benchmarkId, "generation")).toHaveLength(0);
    expect(await attemptsOf(benchmarkId, "judgment")).toHaveLength(2);
    const db = await connection();
    const [cand] = await db.select().from(schema.benchmarkCandidates).where(eq(schema.benchmarkCandidates.benchmarkId, benchmarkId));
    expect(cand.workflowVersionId).toBeNull();
    expect(bench.pipelineVersionId).toBeNull(); // no snapshot frozen for a plan that runs nothing
    expect(bench.state).toBe("completed");

    const summary = JSON.parse(String(bench.summary)) as { perCandidate: Array<{ provenance: string }> };
    expect(summary.perCandidate[0].provenance).toBe("graded_existing_output__not_executed_by_this_plan");
  });

  it("A02 + A08: one override reaches every model-backed step including gates, and the ledger reconciles", async () => {
    resetFakes();
    const f = await seedFixture({ gated: true });

    const { benchmarkId, quote, bench } = await startAndExecute({
      userId: f.userId, projectId: f.projectId, executionMode: "compare_models",
      cases: [{ inputText: "task one" }, { inputText: "task two" }],
      judges: [{ providerId: f.providerId, model: "judge-model" }],
      candidates: [
        { label: "cheap", overrideModel: "cheap-model", overrideProviderId: f.providerId },
        { label: "frontier", overrideModel: "frontier-model", overrideProviderId: f.providerId },
      ],
    });

    // Three steps with an if-gate: the widest path counts the gate twice → 6
    // calls per generation, summed over the two candidates.
    expect(quote.counts.generationCalls).toBe(24);
    expect(quote.counts.judgingCalls).toBe(4);
    expect(quote.counts.generationPerCandidate.map((c) => c.calls)).toEqual([12, 12]);

    expect(exec.calls).toHaveLength(4);
    const modelsPerVersion = new Map<number, Set<string | null>>();
    for (const call of exec.calls) {
      expect(call.stepModels).toHaveLength(3);
      modelsPerVersion.set(call.versionId!, new Set([...(modelsPerVersion.get(call.versionId!) ?? []), ...call.stepModels]));
    }
    // A02: each candidate ran ITS OWN version whose every step — gate included
    // — carries the single overridden model. Nothing silently stayed on base.
    const distinctModels = new Set<string>();
    for (const [, models] of modelsPerVersion) {
      expect(models.size).toBe(1);
      expect([...models]).not.toContain("base-model");
      [...models].forEach((m) => m && distinctModels.add(m));
    }
    expect([...distinctModels].sort()).toEqual(["cheap-model", "frontier-model"]);
    expect(modelsPerVersion.size).toBe(2);

    // A08 reconciliation, stated in its own units: the plan quoted provider
    // CALLS (24 generation calls over 4 logical generations), the ledger holds
    // one row per logical operation carrying that operation's summed usage —
    // here 3 steps × 120 prompt tokens per child, as the fake reports per step.
    const generationAttempts = await attemptsOf(benchmarkId, "generation");
    expect(generationAttempts).toHaveLength(4);
    expect(generationAttempts.reduce((a, r) => a + (r.promptTokens ?? 0), 0)).toBe(4 * 3 * 120);
    expect((await attemptsOf(benchmarkId, "judgment")).length).toBe(quote.counts.judgingCalls);
    expect(bench.state).toBe("completed");
    expect(bench.aggregateAvailability).toBe("complete");

    // A07: comparison output stays descriptive, with no certification wording,
    // and the unit difference between plan and ledger is disclosed.
    const summary = JSON.parse(String(bench.summary)) as Record<string, unknown>;
    expect(summary.descriptiveOnly).toBe(true);
    expect(summary.highestObservedScope).toBe("highest observed score among these tested conditions only");
    const cost = (summary.costObserved ?? {}) as Record<string, unknown>;
    expect(cost.plannedCalls).toEqual({ generation: 24, judging: 4 });
    expect(cost.observedOperations).toEqual({ generation: 4, judgment: 4 });
    expect(String(cost.unitNote)).toContain("not one-to-one comparable");
    const flat = JSON.stringify(summary).toLowerCase();
    for (const forbidden of ["confidence interval", "significan", "equivalent quality", "certified", "statistically"]) {
      expect(flat).not.toContain(forbidden);
    }
  });

  it("028: ledger actuals are priced from the rates the quote used; an unpriceable model stays UNKNOWN, never 0", async () => {
    resetFakes();
    const prevVector = process.env.V2_PRICE_VECTOR_JSON;
    process.env.V2_PRICE_VECTOR_JSON = JSON.stringify({
      "base-model": { in: 0.2, out: 0.6 },
      "judge-model": { in: 1, out: 2 },
    });
    const pricing = await import("./modelPricing");
    const { benchmarkLedgerTotals } = await import("./benchmarkLedger");
    pricing.resetPricingCache();
    try {
      const f = await seedFixture();
      const { benchmarkId, quote } = await startAndExecute({
        userId: f.userId, projectId: f.projectId,
        cases: [{ inputText: "task one" }],
        judges: [{ providerId: f.providerId, model: "judge-model" }],
      });
      // The seeded host is unreachable, so quote and ledger fall back together —
      // which is exactly the point: they must never diverge on the SOURCE.
      expect(quote.pricingBasis).toBe("price_vector");
      expect(quote.estimatedTotalCostUsd).not.toBeNull();

      // The fake returns one 120/30 response per STEP of a generation child, and
      // the default fixture has two steps, so the child's own usage is 240/60.
      const [gen] = await attemptsOf(benchmarkId, "generation");
      expect(Number(gen.estimatedCostUsd)).toBeCloseTo((240 / 1000) * 0.2 + (60 / 1000) * 0.6, 10);
      expect(gen.costBasis).toBe("price_vector");
      expect(gen.costCompleteness).toBe("complete");
      expect(gen.costPricingAsOf).toBeNull(); // a vector is versioned, not timestamped
      expect(gen.priceVectorVersion).toBe("pv-2026-09");
      // Pricing read the candidate's route; the billing column keeps its meaning
      // of "one credential", which a multi-step aggregate does not have.
      expect(gen.providerRefId).toBeNull();

      const [jud] = await attemptsOf(benchmarkId, "judgment");
      expect(Number(jud.estimatedCostUsd)).toBeCloseTo((400 / 1000) * 1 + (60 / 1000) * 2, 10);
      expect(jud.costBasis).toBe("price_vector");
      expect(jud.costCompleteness).toBe("complete");
      expect(jud.providerRefId).toBe(f.providerId);

      const totals = await benchmarkLedgerTotals(benchmarkId);
      expect(totals.costCompleteness).toBe("complete");
      expect(Number(totals.knownCostUsd)).toBeCloseTo(0.084 + 0.52, 10);
      expect(totals.pricingBases).toEqual(["price_vector"]);

      // A model no source knows must produce UNKNOWN on its own row and drag the
      // benchmark to `partial` — never a silently-absent or zero cost.
      const f2 = await seedFixture({ stepModel: "model-nobody-lists" });
      const { benchmarkId: id2 } = await startAndExecute({
        userId: f2.userId, projectId: f2.projectId,
        cases: [{ inputText: "task one" }],
        judges: [{ providerId: f2.providerId, model: "judge-model" }],
      });
      const [gen2] = await attemptsOf(id2, "generation");
      expect(gen2.estimatedCostUsd).toBeNull();
      expect(gen2.costBasis).toBeNull();
      expect(gen2.costCompleteness).toBe("unknown");
      const t2 = await benchmarkLedgerTotals(id2);
      expect(t2.costCompleteness).toBe("partial");
      expect(Number(t2.knownCostUsd)).toBeCloseTo(0.52, 10); // judging still priced
      expect(t2.pricingBases).toEqual(["price_vector"]);

      // Distinct rates make a single-route estimate observably wrong.
      process.env.V2_PRICE_VECTOR_JSON = JSON.stringify({
        "model-a": { in: 0.2, out: 0.6 },
        "model-b": { in: 1, out: 2 },
        "judge-model": { in: 1, out: 2 },
      });
      pricing.resetPricingCache();
      const f3 = await seedFixture({ stepModels: ["model-a", "model-b"] });
      const { benchmarkId: id3 } = await startAndExecute({
        userId: f3.userId, projectId: f3.projectId,
        cases: [{ inputText: "task one" }],
        judges: [{ providerId: f3.providerId, model: "judge-model" }],
      });
      const [gen3] = await attemptsOf(id3, "generation");
      expect(Number(gen3.estimatedCostUsd)).toBeCloseTo(
        ((120 / 1000) * 0.2 + (30 / 1000) * 0.6) + ((120 / 1000) * 1 + (30 / 1000) * 2), 10);
      expect(gen3.costBasis).toBe("price_vector");
      expect(gen3.costCompleteness).toBe("complete");
      expect(gen3.providerRefId).toBeNull();
      expect(gen3.promptTokens).toBe(240);
      expect(gen3.completionTokens).toBe(60);
      const t3 = await benchmarkLedgerTotals(id3);
      expect(t3.costCompleteness).toBe("complete");
      expect(Number(t3.knownCostUsd)).toBeCloseTo(0.222 + 0.52, 10);

      // A known subtotal must not masquerade as the whole generation cost.
      process.env.V2_PRICE_VECTOR_JSON = JSON.stringify({
        "model-a": { in: 0.2, out: 0.6 },
        "judge-model": { in: 1, out: 2 },
      });
      pricing.resetPricingCache();
      const f4 = await seedFixture({ stepModels: ["model-a", "model-nobody-lists"] });
      const { benchmarkId: id4 } = await startAndExecute({
        userId: f4.userId, projectId: f4.projectId,
        cases: [{ inputText: "task one" }],
        judges: [{ providerId: f4.providerId, model: "judge-model" }],
      });
      const [gen4] = await attemptsOf(id4, "generation");
      expect(gen4.estimatedCostUsd).toBeNull();
      expect(gen4.costBasis).toBeNull();
      expect(gen4.costCompleteness).toBe("unknown");
      const t4 = await benchmarkLedgerTotals(id4);
      expect(t4.costCompleteness).toBe("partial");
      expect(Number(t4.knownCostUsd)).toBeCloseTo(0.52, 10);
    } finally {
      if (prevVector === undefined) delete process.env.V2_PRICE_VECTOR_JSON;
      else process.env.V2_PRICE_VECTOR_JSON = prevVector;
      pricing.resetPricingCache();
    }
  });

  it("prices from an owner-declared rate only where nothing published knows the model, and a declared 0 as a real zero", async () => {
    const f = await seedFixture();
    const db = await connection();
    const [benchmark] = await db.insert(schema.benchmarks).values({
      ownerId: f.userId, sourceProjectId: f.projectId, executionMode: "grade_only", state: "completed",
    });
    const benchmarkId = Number((benchmark as { insertId: number }).insertId);
    const ledger = await import("./benchmarkLedger");
    const pricing = await import("./modelPricing");
    const previous = process.env.V2_PRICE_VECTOR_JSON;
    process.env.V2_PRICE_VECTOR_JSON = JSON.stringify({ "published-model": { in: 1, out: 2 } });
    pricing.resetPricingCache();
    try {
      for (const [modelId, input, output] of [
        ["local-model", 0, 0], ["obscure-model", 3, 12], ["published-model", 1000, 2000],
      ] as const) {
        await db.insert(schema.declaredModelPrices).values({
          providerRefId: f.providerId, modelId, createdBy: f.userId,
          inputUsdPerMillion: input.toFixed(8), outputUsdPerMillion: output.toFixed(8),
        });
      }

      // Entered per 1M, resolved per 1k — the unit the ledger and the adapters
      // share. Whitespace and case must not defeat the owner's own entry.
      expect(await pricing.rateForAttempt(f.providerId, " Local-Model ")).toMatchObject({
        basis: "declared", rates: { in: 0, out: 0 },
      });
      expect(await pricing.rateForAttempt(f.providerId, "obscure-model")).toMatchObject({
        basis: "declared", rates: { in: 0.003, out: 0.012 },
      });
      // A declaration is the LAST source: it may end an UNKNOWN, never overwrite
      // a price the host or the platform actually states.
      expect((await pricing.rateForAttempt(f.providerId, "published-model"))?.basis).toBe("price_vector");

      // Quote and actual must consult the same sources in the same order, or an
      // approved plan hash binds different numbers than the ones billed.
      const quoted = await pricing.resolveModelPricing({
        providerIds: [f.providerId], models: ["obscure-model", "local-model", "published-model"],
      });
      expect(quoted.sourceByModel).toEqual({
        "obscure-model": "declared", "local-model": "declared", "published-model": "price_vector",
      });
      expect(quoted.missing).toEqual([]);

      const id = await ledger.recordCallAttempt({
        operationKind: "judgment", operationId: 910_001, benchmarkId, purpose: "private_evaluation",
        actorId: f.userId, payerId: f.userId, providerRefId: f.providerId, requestedModel: "local-model",
        outcome: "success", promptTokens: 1200, completionTokens: 300,
      });
      const [row] = await db.select().from(schema.callAttempts).where(eq(schema.callAttempts.id, id));
      // Zero from a declaration is complete, not unknown: the disclosure can
      // say so because the basis is its own value.
      expect(row).toMatchObject({
        estimatedCostUsd: "0.00000000", costBasis: "declared", costCompleteness: "complete",
      });
      const [other] = await db.select().from(schema.callAttempts).where(eq(schema.callAttempts.id,
        await ledger.recordCallAttempt({
          operationKind: "judgment", operationId: 910_002, benchmarkId, purpose: "private_evaluation",
          actorId: f.userId, payerId: f.userId, providerRefId: f.providerId, requestedModel: "obscure-model",
          outcome: "success", promptTokens: 1000, completionTokens: 1000,
        })));
      expect(Number(other.estimatedCostUsd)).toBeCloseTo(0.015, 8);
      const disclosure = ledger.costDisclosure(await ledger.benchmarkLedgerTotals(benchmarkId));
      expect(disclosure.pricingBases).toContain("declared");
    } finally {
      if (previous === undefined) delete process.env.V2_PRICE_VECTOR_JSON;
      else process.env.V2_PRICE_VECTOR_JSON = previous;
    }
  });

  it("keeps missing ledger usage unpriced even at known rates, while measured zero remains a real zero", async () => {
    const f = await seedFixture();
    const db = await connection();
    const [benchmark] = await db.insert(schema.benchmarks).values({
      ownerId: f.userId, sourceProjectId: f.projectId, executionMode: "grade_only", state: "completed",
    });
    const benchmarkId = Number((benchmark as { insertId: number }).insertId);
    const ledger = await import("./benchmarkLedger");
    const pricing = await import("./modelPricing");
    const previous = process.env.V2_PRICE_VECTOR_JSON;
    process.env.V2_PRICE_VECTOR_JSON = JSON.stringify({ "known-usage-model": { in: 1, out: 2 } });
    pricing.resetPricingCache();
    try {
      let operationId = 900_000;
      const base = {
        operationKind: "judgment" as const, benchmarkId, purpose: "private_evaluation" as const,
        actorId: f.userId, payerId: f.userId, providerRefId: null, requestedModel: "known-usage-model",
      };
      for (const outcome of ["success", "failed", "uncertain"] as const) {
        for (const usage of [{}, { promptTokens: 10 }, { completionTokens: 20 }, { promptTokens: null, completionTokens: null }]) {
          const id = await ledger.recordCallAttempt({ ...base, operationId: operationId++, outcome, ...usage });
          const [row] = await db.select().from(schema.callAttempts).where(eq(schema.callAttempts.id, id));
          expect(row).toMatchObject({ estimatedCostUsd: null, costBasis: null, costCompleteness: "unknown" });
        }
      }
      const aggregateId = await ledger.recordCallAttempt({
        ...base, operationId: operationId++, operationKind: "generation", outcome: "success",
        pricingSegments: [{ model: "known-usage-model", providerRefId: null, promptTokens: 10, completionTokens: 20 }],
      });
      const [aggregate] = await db.select().from(schema.callAttempts).where(eq(schema.callAttempts.id, aggregateId));
      expect(aggregate).toMatchObject({ estimatedCostUsd: null, costCompleteness: "unknown" });
      for (const outcome of ["success", "failed"] as const) {
        const zeroId = await ledger.recordCallAttempt({ ...base, operationId: operationId++, outcome, promptTokens: 0, completionTokens: 0 });
        const [zero] = await db.select().from(schema.callAttempts).where(eq(schema.callAttempts.id, zeroId));
        expect(zero).toMatchObject({ costCompleteness: "complete", costBasis: "price_vector", promptTokens: 0, completionTokens: 0 });
        expect(Number(zero.estimatedCostUsd)).toBe(0);
      }
      const measuredId = await ledger.recordCallAttempt({ ...base, operationId: operationId++, outcome: "success", promptTokens: 10, completionTokens: 20 });
      const [measured] = await db.select().from(schema.callAttempts).where(eq(schema.callAttempts.id, measuredId));
      expect(Number(measured.estimatedCostUsd)).toBeCloseTo(0.05, 8);
      const disclosure = ledger.costDisclosure(await ledger.benchmarkLedgerTotals(benchmarkId));
      expect(disclosure.knownUsd).toBeNull();
      expect(disclosure.pricedSoFarUsd).toBe("0.05000000");
      expect(disclosure.unpricedOperations).toBe(13);
      expect(disclosure.display).toContain("FLOOR and not the total owed");
    } finally {
      if (previous === undefined) delete process.env.V2_PRICE_VECTOR_JSON;
      else process.env.V2_PRICE_VECTOR_JSON = previous;
      pricing.resetPricingCache();
    }
  });

  it("a host that reports no usage leaves the run UNKNOWN rather than a free 0-token run", async () => {
    resetFakes();
    exec.reportUsage = false;
    judge.reportUsage = false;
    const prevVector = process.env.V2_PRICE_VECTOR_JSON;
    process.env.V2_PRICE_VECTOR_JSON = JSON.stringify({
      "base-model": { in: 0.2, out: 0.6 },
      "judge-model": { in: 1, out: 2 },
    });
    const pricing = await import("./modelPricing");
    const { benchmarkLedgerTotals, costDisclosure } = await import("./benchmarkLedger");
    pricing.resetPricingCache();
    try {
      const f = await seedFixture();
      const { benchmarkId, bench } = await startAndExecute({
        userId: f.userId, projectId: f.projectId,
        cases: [{ inputText: "task one" }],
        judges: [{ providerId: f.providerId, model: "judge-model" }],
      });
      // The WORK succeeded and is still recorded; only its cost is unprovable.
      expect(bench.state).toBe("completed");
      for (const kind of ["generation", "judgment"] as const) {
        const [row] = await attemptsOf(benchmarkId, kind);
        expect(row.promptTokens).toBeNull();
        expect(row.completionTokens).toBeNull();
        expect(row.estimatedCostUsd).toBeNull();
        expect(row.costBasis).toBeNull();
        expect(row.costCompleteness).toBe("unknown");
      }
      const totals = await benchmarkLedgerTotals(benchmarkId);
      // "partial" is the aggregate's word for NOT EVERY ROW IS PRICED, which is
      // what an all-unknown ledger is; the anti-lie lives in the disclosure,
      // which must refuse to name a bill (the D9 finding-1 pin).
      expect(totals.costCompleteness).toBe("partial");
      expect(totals.pricedOperations).toBe(0);
      const disclosure = costDisclosure(totals);
      expect(disclosure.knownUsd).toBeNull();
      expect(disclosure.unpricedOperations).toBe(2);
      expect(disclosure.display).toMatch(/FLOOR and not the total owed/);
      expect(JSON.stringify(disclosure)).not.toMatch(/"knownUsd":"0\.00000000"/);
    } finally {
      if (prevVector === undefined) delete process.env.V2_PRICE_VECTOR_JSON;
      else process.env.V2_PRICE_VECTOR_JSON = prevVector;
      pricing.resetPricingCache();
      resetFakes();
    }
  });

  it("grade_only carries no ranking field at all (spec §4.1 step 7)", async () => {
    resetFakes();
    const f = await seedFixture();
    const { bench } = await startAndExecute({
      userId: f.userId, projectId: f.projectId,
      cases: [{ inputText: "task one" }],
      judges: [{ providerId: f.providerId, model: "judge-model" }],
    });
    const summary = JSON.parse(String(bench.summary)) as Record<string, unknown>;
    expect(summary).not.toHaveProperty("highestObserved");
    expect(summary).not.toHaveProperty("pairwiseTally");
  });

  it("A06: a failed child makes the plan partial, and resume re-runs ONLY that child", async () => {
    resetFakes();
    const f = await seedFixture();
    exec.failInputs.add("task two");
    const benchmarkId = await svc.createBenchmarkDraft({
      userId: f.userId, projectId: f.projectId,
      cases: [{ inputText: "task one" }, { inputText: "task two" }],
      judges: [{ providerId: f.providerId, model: "judge-model" }],
    });
    const quote = await svc.quoteBenchmark({ userId: f.userId, benchmarkId });
    const approval1 = await svc.approveBenchmarkSpend({ userId: f.userId, benchmarkId, planHash: quote.planHash });
    expect((await svc.startBenchmark({ userId: f.userId, benchmarkId, planHash: quote.planHash, spendApprovalId: approval1 })).ok).toBe(true);
    const lease = await svc.acquireBenchmark(benchmarkId);
    await svc.executeBenchmark({ benchmarkId, leaseToken: lease! });

    let children = await childrenOf(benchmarkId);
    expect(children.filter((c) => c.status === "completed")).toHaveLength(1);
    expect(children.filter((c) => c.status === "failed")).toHaveLength(1);
    // §10.2: judging the survivor is NOT a completed plan.
    let bench = await benchmark(benchmarkId);
    expect(bench.state).toBe("partial");
    expect(bench.aggregateAvailability).toBe("incomplete");
    const attemptsBefore = await attemptsOf(benchmarkId, "generation");
    expect(attemptsBefore).toHaveLength(2); // one success + one failure, both visible
    expect((await attemptsOf(benchmarkId, "judgment")).length).toBe(1);

    // Resume without asking to retry failures: nothing is left unfinished.
    const refusalApproval = await svc.approveBenchmarkSpend({ userId: f.userId, benchmarkId, planHash: String(bench.planHash) });
    const refused = await svc.resumeBenchmark({ userId: f.userId, benchmarkId, spendApprovalId: refusalApproval });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toContain("nothing_left_to_do");
    expect((await approval(refusalApproval)).status).toBe("active"); // a refusal never consumes spend

    // Wrong approval for this plan's hash is rejected outright.
    await expect(svc.resumeBenchmark({ userId: f.userId, benchmarkId, spendApprovalId: 999999 }))
      .resolves.toMatchObject({ ok: false });

    // Explicit retry of the failed child, with a fresh approval.
    const resumeApproval = await svc.approveBenchmarkSpend({ userId: f.userId, benchmarkId, planHash: String(bench.planHash) });
    const resumed = await svc.resumeBenchmark({ userId: f.userId, benchmarkId, spendApprovalId: resumeApproval, retryFailed: true });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error("resume should succeed");
    expect(resumed.requeued).toBe(1);
    expect((await approval(resumeApproval)).status).toBe("consumed");
    bench = await benchmark(benchmarkId);
    expect(bench.state).toBe("queued");

    exec.failInputs.clear();
    const beforeRetry = exec.calls.length;
    const lease2 = await svc.acquireBenchmark(benchmarkId);
    await svc.executeBenchmark({ benchmarkId, leaseToken: lease2! });

    // Only the unfinished child ran again; the completed one was left alone.
    expect(exec.calls.length - beforeRetry).toBe(1);
    children = await childrenOf(benchmarkId);
    expect(children.every((c) => c.status === "completed")).toBe(true);
    const attemptsAfter = await attemptsOf(benchmarkId, "generation");
    // Append-only: the earlier success and failure rows are still there, and
    // the retry added exactly one more attempt.
    expect(attemptsAfter.length).toBe(attemptsBefore.length + 1);
    const perAttemptIndex = attemptsAfter.filter((a) => a.operationId === attemptsBefore[0].operationId).length;
    expect(perAttemptIndex).toBeGreaterThanOrEqual(1);
    bench = await benchmark(benchmarkId);
    expect(bench.state).toBe("completed");
    expect(bench.aggregateAvailability).toBe("complete");
  });

  it("durable-job drill: an expired lease heals to queued, and cancellation stops work without re-running anything", async () => {
    resetFakes();
    const f = await seedFixture();
    const { benchmarkId } = await startAndExecute({
      userId: f.userId, projectId: f.projectId,
      cases: [{ inputText: "task one" }, { inputText: "task two" }],
      judges: [{ providerId: f.providerId, model: "judge-model" }],
    });
    const callsAfterFirstPass = exec.calls.length;
    expect(callsAfterFirstPass).toBe(2);

    // Simulate a worker that died while holding the lease: the row says
    // `running` with an expiry in the past and no one left to finish it.
    const db = await connection();
    await db.update(schema.benchmarks)
      .set({ state: "running", leaseToken: "dead-worker", leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.benchmarks.id, benchmarkId));
    expect(await svc.healStaleBenchmarks()).toBe(1);
    expect((await benchmark(benchmarkId)).state).toBe("queued");
    // Heal never re-dispatches work into a live execution: attempts are intact.
    expect((await attemptsOf(benchmarkId, "generation")).length).toBe(2);

    // Cancel a queued plan: the next worker pass must finalize it as
    // cancelled and start no new generation.
    await db.update(schema.benchmarks).set({ state: "queued" }).where(eq(schema.benchmarks.id, benchmarkId));
    const cancelled = await svc.cancelBenchmark({ userId: f.userId, benchmarkId });
    expect(cancelled.ok).toBe(true);
    const lease = await svc.acquireBenchmark(benchmarkId);
    expect(lease).toBeTruthy();
    await svc.executeBenchmark({ benchmarkId, leaseToken: lease! });
    expect(exec.calls).toHaveLength(callsAfterFirstPass);
    expect((await benchmark(benchmarkId)).state).toBe("cancelled");

    // Completed evidence survives cancellation: earlier children stay done
    // and their attempt rows are untouched (cancellation stops dispatch only).
    const children = await childrenOf(benchmarkId);
    expect(children.filter((c) => c.status === "completed")).toHaveLength(2);
    expect((await attemptsOf(benchmarkId, "generation")).length).toBe(2);
  });

  it("A01 guard: another tenant's output cannot be imported into my plan", async () => {
    resetFakes();
    const owner = await seedFixture();
    const intruder = await seedFixture();
    const stolen = await seedPriorOutput(intruder, "not yours to grade");
    await expect(svc.createBenchmarkDraft({
      userId: owner.userId, projectId: owner.projectId,
      cases: [{ inputText: "t" }],
      judges: [{ providerId: owner.providerId, model: "judge-model" }],
      candidates: [{ existingResponseId: stolen.responseId }],
    })).rejects.toThrow(/not_found_or_not_authorized/);
  });
});
