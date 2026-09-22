// D12 DB-backed drill: vendor resolution from the reviewed catalog, the
// creation/quote end of the disjointness gate, the 3×3=9-ratings cross product
// actually running, and a pre-D12 frozen plan still loading and re-quoting to
// its original hash. Own throwaway schema (`swarm_v2test_gate`) — never the
// dev `swarm` database, never production. Engine + judge calls are faked as in
// the execution drill; freeze, fan-out, judgment bookkeeping and the summary
// are the real code path.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";

const exec = vi.hoisted(() => ({ calls: [] as number[] }));
const judge = vi.hoisted(() => ({ seen: [] as Array<{ model: string; prompt: string }> }));

vi.mock("../swarmService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../swarmService")>();
  return {
    ...actual,
    executeSwarmRun: async (params: { swarmRunId: number }) => {
      const { getDb } = await import("../../queries/connection");
      const schema = await import("@db/schema");
      const { eq } = await import("drizzle-orm");
      const db = getDb();
      const [run] = await db.select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, params.swarmRunId)).limit(1);
      exec.calls.push(params.swarmRunId);
      const [ar] = await db.insert(schema.agentRuns).values({
        swarmRunId: params.swarmRunId, projectId: run.projectId, agentName: "Fake", agentRole: "builder",
        pipelineStep: 1, userPrompt: run.userPrompt, status: "completed",
      });
      const [resp] = await db.insert(schema.agentResponses).values({
        agentRunId: Number((ar as { insertId: number }).insertId), swarmRunId: params.swarmRunId,
        projectId: run.projectId, responseType: "final", content: `gate output for ${run.userPrompt}`,
        metadata: {
          model: "fake-model", provider: "fake", providerSlug: "fake",
          tokensUsed: { prompt: 10, completion: 5, total: 15 }, latencyMs: 5, temperature: 0.7, maxTokens: 1024,
          agentName: "Fake", agentRole: "builder", agentSlug: "fake", pipelineStep: 1, iteration: 1,
          buildMethod: "manual", sourceResponseIds: [],
        },
      });
      await db.update(schema.swarmRuns).set({
        status: "completed", finalResponseId: Number((resp as { insertId: number }).insertId), completedAt: new Date(),
      }).where(eq(schema.swarmRuns.id, params.swarmRunId));
    },
  };
});

// The real buildRubricJudgePrompt runs (the mock keeps it via importOriginal),
// so the variant framing text is what the fake "judge" actually sees — scores
// depend on judge × case × variant so the ICC matrix has real structure.
vi.mock("./judgeService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./judgeService")>();
  return {
    ...actual,
    generateJudgeCall: async (args: { judge: { model: string }; prompt: { messages: Array<{ content: string }> } }) => {
      const text = args.prompt.messages.map((m) => m.content).join("\n");
      judge.seen.push({ model: args.judge.model, prompt: text });
      const byModel = ["judge-ds", "judge-glm", "judge-llama", "fake-model"];
      const byCase = ["case one", "case two", "case three"];
      const byVariant = [text.includes("(comment_first)") ? 1 : 0, text.includes("(checklist_first)") ? 2 : 0];
      const mi = Math.max(0, byModel.indexOf(args.judge.model));
      const ci = Math.max(0, byCase.findIndex((c) => text.includes(c)));
      const variantIdx = Math.max(...byVariant);
      const s = Math.min(10, 1 + mi + ci + 0.5 * variantIdx);
      const scores = Object.fromEntries(["accuracy", "completeness", "instructionFit", "clarity"].map((d) => [d, s]));
      return { content: JSON.stringify({ scores, rationale: "gate-fake" }), model: args.judge.model, promptTokens: 40, completionTokens: 6 };
    },
  };
});

const TEST_DB = "swarm_v2test_gate";
const ROOT_MYSQL = process.env.MYSQL_ROOT_URL || "mysql://root:rootpass@localhost:3307";

let svc: typeof import("./benchmarkService");
let ev: typeof import("../evidenceService");
let catalog: typeof import("../modelCatalogService");
let schema: typeof import("@db/schema");
let eq: typeof import("drizzle-orm").eq;
let admin: mysql.Connection;

beforeAll(async () => {
  if (process.env.NODE_ENV === "production") throw new Error("panel gate tests refuse production mode");
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
  ev = await import("../evidenceService");
  catalog = await import("../modelCatalogService");
  schema = await import("@db/schema");
  eq = (await import("drizzle-orm")).eq;
  {
    // The publication boundary checks the v2Publication flag before anything
    // else; this file needs the flag ON so the D12 refusal is the one a test
    // observes, not `publication_disabled`.
    const db = (await import("../../queries/connection")).getDb();
    await db.insert(schema.featureFlags).values({ key: "v2Publication", name: "V2 — Evidence Publication", description: "test", enabled: true, rolloutPercent: 0 });
    (await import("../../plugins/featureFlags")).resetFlagCache();
  }
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
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL }, stdio: "ignore", timeout: 150_000,
  });
}

async function connection() {
  return (await import("../../queries/connection")).getDb();
}

async function seedFixture() {
  const db = await connection();
  const stamp = `${Date.now()}-${Math.random()}`;
  const [u] = await db.insert(schema.users).values({ name: "Gater", email: `g-${stamp}@example.test`, tier: "pro_auto" });
  const userId = Number((u as { insertId: number }).insertId);
  const [p] = await db.insert(schema.projects).values({ userId, name: "Gated Project" });
  const projectId = Number((p as { insertId: number }).insertId);
  const [prov] = await db.insert(schema.llmProviders).values({
    userId, name: `fake-${stamp}`, slug: `fake-${stamp}`, baseUrl: "http://localhost:1", apiKeyRef: "dummy", defaultModel: "fake-model",
  });
  const providerId = Number((prov as { insertId: number }).insertId);
  await db.insert(schema.pipelineSteps).values([
    { projectId, stepOrder: 1, stepType: "agent", name: "Only step", role: "builder", systemPrompt: "go", isEnabled: true, providerId, model: "fake-model" },
  ]);
  // One hosting provider serving FOUR developers — the whole point of reading
  // the vendor from the catalog, not from whose key served the call.
  await db.insert(schema.modelCatalog).ignore().values([
    { provider: "fake-host", modelId: "fake-model", vendor: "qwen" },
    { provider: "fake-host", modelId: "judge-ds", vendor: "deepseek" },
    { provider: "fake-host", modelId: "judge-glm", vendor: "zhipu" },
    { provider: "fake-host", modelId: "judge-llama", vendor: "meta" },
  ]);
  return { db, userId, projectId, providerId };
}

async function seedListing(f: Awaited<ReturnType<typeof seedFixture>>) {
  const db = await connection();
  const [t] = await db.insert(schema.pipelineTemplates).values({
    userId: f.userId, name: `tpl-${Date.now()}`, steps: [{ name: "Only", role: "builder", systemPrompt: "x" }], sourceProjectId: f.projectId,
  });
  const [l] = await db.insert(schema.marketplaceListings).values({
    creatorId: f.userId, templateId: Number((t as { insertId: number }).insertId), title: "Gated listing", price: "1.00", status: "draft",
  });
  return Number((l as { insertId: number }).insertId);
}

const evidencePanel = (f: { providerId: number }) => [
  { providerId: f.providerId, model: "judge-ds", variant: "anchored_scale" as const },
  { providerId: f.providerId, model: "judge-glm", variant: "comment_first" as const },
  { providerId: f.providerId, model: "judge-llama", variant: "checklist_first" as const },
];

async function runToCompletion(input: Parameters<typeof svc.createBenchmarkDraft>[0]) {
  const benchmarkId = await svc.createBenchmarkDraft(input);
  const quote = await svc.quoteBenchmark({ userId: input.userId, benchmarkId });
  expect(quote.blockingErrors).toEqual([]);
  const approval = await svc.approveBenchmarkSpend({ userId: input.userId, benchmarkId, planHash: quote.planHash });
  const started = await svc.startBenchmark({ userId: input.userId, benchmarkId, planHash: quote.planHash, spendApprovalId: approval });
  expect(started.ok).toBe(true);
  const lease = await svc.acquireBenchmark(benchmarkId);
  await svc.executeBenchmark({ benchmarkId, leaseToken: lease! });
  const db = await connection();
  const [bench] = await db.select().from(schema.benchmarks).where(eq(schema.benchmarks.id, benchmarkId)).limit(1);
  return { benchmarkId, quote, bench };
}

describe("D12 vendor resolution from the reviewed catalog", () => {
  it("reads the developer, not the host; unknown and disputed rows resolve to null", async () => {
    const f = await seedFixture();
    const db = await connection();
    await db.insert(schema.modelCatalog).ignore().values([
      // Same model id under two hosts agreeing on the developer → resolves.
      { provider: "other-host", modelId: "judge-ds", vendor: "DeepSeek" },
      // Same model id with DISPUTED developers → unknown, never a coin flip.
      { provider: "host-a", modelId: "disputed-model", vendor: "meta" },
      { provider: "host-b", modelId: "disputed-model", vendor: "mistral" },
      // Catalogued without a vendor (pre-031 row) → unknown.
      { provider: "fake-host", modelId: "no-vendor-model", vendor: null },
    ]);
    const vendors = await catalog.resolveModelVendors(["judge-ds", "JUDGE-DS", "disputed-model", "no-vendor-model", "never-catalogued", "judge-glm"]);
    expect(vendors).toMatchObject({
      "judge-ds": "deepseek", // case-insensitive match, lowercased developer
      "JUDGE-DS": "deepseek",
      "judge-glm": "zhipu",
      "disputed-model": null,
      "no-vendor-model": null,
      "never-catalogued": null,
    });
    void f;
  });
});

describe("D12 gate at create/quote", () => {
  it("refuses a listing-attached draft whose panel is not evidence-grade, with actionable text", async () => {
    const f = await seedFixture();
    const listingId = await seedListing(f);
    await expect(svc.createBenchmarkDraft({
      userId: f.userId, projectId: f.projectId, listingId,
      cases: [{ inputText: "case one" }],
      judges: [{ providerId: f.providerId, model: "fake-model" }], // self-graded, one judge
    })).rejects.toThrow(/panel_not_evidence_grade: panel_needs_three_judges[\s\S]*panel_judge_generator_vendor_overlap: judge fake-model is built by qwen, the same developer as generating model fake-model/);
  });

  it("accepts a listing-attached evidence-grade panel and quotes nine ratings per output with no blocking errors", async () => {
    const f = await seedFixture();
    const listingId = await seedListing(f);
    const benchmarkId = await svc.createBenchmarkDraft({
      userId: f.userId, projectId: f.projectId, listingId,
      cases: [{ inputText: "case one" }, { inputText: "case two" }, { inputText: "case three" }],
      judges: evidencePanel(f),
    });
    const quote = await svc.quoteBenchmark({ userId: f.userId, benchmarkId });
    expect(quote.blockingErrors).toEqual([]);
    expect(quote.panel.evidenceGrade).toBe(true);
    expect(quote.panel.issues).toEqual([]);
    expect(quote.counts.judgingCalls).toBe(27); // 3 cases × 1 candidate × 1 repeat × 3 judges × 3 variants
    expect(quote.counts.judgingPromptVariants).toBe(3);
  });

  it("a private self-graded panel still quotes and starts — with the consequence stated, not silent", async () => {
    const f = await seedFixture();
    const benchmarkId = await svc.createBenchmarkDraft({
      userId: f.userId, projectId: f.projectId,
      cases: [{ inputText: "case one" }],
      judges: [{ providerId: f.providerId, model: "fake-model" }],
    });
    const quote = await svc.quoteBenchmark({ userId: f.userId, benchmarkId });
    expect(quote.blockingErrors).toEqual([]); // private evaluation: allowed
    expect(quote.panel.evidenceGrade).toBe(false);
    expect(quote.warnings.join(" ")).toContain("private-only panel (D12)");
    expect(quote.warnings.join(" ")).toContain("cannot be published as evidence");
  });
});

describe("D12 execution and ICC", () => {
  it("runs the full 3×3 cross product — 9 judgment rows per output, one per (slot, variant)", async () => {
    judge.seen = [];
    const f = await seedFixture();
    const { benchmarkId, bench } = await runToCompletion({
      userId: f.userId, projectId: f.projectId,
      cases: [{ inputText: "case one" }, { inputText: "case two" }, { inputText: "case three" }],
      judges: evidencePanel(f),
    });
    const db = await connection();
    const judgments = await db.select().from(schema.benchmarkJudgments).where(eq(schema.benchmarkJudgments.benchmarkId, benchmarkId));
    expect(judgments).toHaveLength(27); // quote.counts.judgingCalls reconciled below
    const keys = new Set(judgments.map((j) => `${j.runId}|${j.judgeSlot}|${j.judgePromptVersion}`));
    expect(keys.size).toBe(27);
    // The money rule: exactly what the approved quote arithmetic promised ran.
    const attempts = await db.select({ id: schema.callAttempts.id }).from(schema.callAttempts)
      .where(eq(schema.callAttempts.benchmarkId, benchmarkId));
    expect(attempts.length).toBe(3 /* generation */ + 27);
    // Every variant's framing text really reached the judge.
    expect(judge.seen.filter((s) => s.prompt.includes("SCORING PROCEDURE (comment_first)")).length).toBe(9);
    expect(judge.seen.filter((s) => s.prompt.includes("SCORING PROCEDURE (checklist_first)")).length).toBe(9);
    expect(judge.seen.filter((s) => s.prompt.includes("SCORING PROCEDURE (anchored_scale)")).length).toBe(9);
    expect(bench.state).toBe("completed");

    const summary = JSON.parse(String(bench.summary)) as {
      judgeAgreement: { icc: { icc31SingleJudge: number | null; icc3kPanelMean: number | null; ratingColumns: number; completeCaseRows: number; note: string } };
    };
    const icc = summary.judgeAgreement.icc;
    expect(icc.ratingColumns).toBe(9);
    expect(icc.completeCaseRows).toBe(3);
    expect(icc.icc31SingleJudge).not.toBeNull();
    expect(icc.icc3kPanelMean).not.toBeNull();
    expect(icc.icc31SingleJudge!).toBeGreaterThan(0);
    expect(icc.icc31SingleJudge!).toBeLessThanOrEqual(1);
    expect(icc.icc3kPanelMean!).toBeGreaterThanOrEqual(icc.icc31SingleJudge!);
    // A reliability coefficient is stated as what it is NOT — the A07 wording
    // guard applies to this whole summary JSON too.
    const flat = JSON.stringify(summary).toLowerCase();
    for (const forbidden of ["confidence interval", "significan", "equivalent quality", "certified", "statistically"]) {
      expect(flat).not.toContain(forbidden);
    }
    expect(icc.note).toContain("not a validity claim");
  });

  it("a 1-judge private design reports ICC as null, naming the condition", async () => {
    const f = await seedFixture();
    const { bench } = await runToCompletion({
      userId: f.userId, projectId: f.projectId,
      cases: [{ inputText: "case one" }, { inputText: "case two" }],
      judges: [{ providerId: f.providerId, model: "judge-ds" }],
    });
    const summary = JSON.parse(String(bench.summary)) as { judgeAgreement: { icc: { icc31SingleJudge: unknown; note: string } } };
    expect(summary.judgeAgreement.icc.icc31SingleJudge).toBeNull();
    expect(summary.judgeAgreement.icc.note).toContain("fewer than 3 judges is degenerate");
    expect(summary.judgeAgreement.icc.note).toContain("No number is invented");
  });

  it("publication of that private result is refused by the re-check, quoting the same reason codes", async () => {
    const f = await seedFixture();
    const { benchmarkId } = await runToCompletion({
      userId: f.userId, projectId: f.projectId,
      cases: [{ inputText: "case one" }, { inputText: "case two" }],
      judges: [{ providerId: f.providerId, model: "judge-ds" }],
    });
    const preview = await ev.buildEvidencePreview({ userId: f.userId, benchmarkId, publicationKind: "community", consentVersion: "consent-v1" });
    expect(preview.evidenceGradePanel).toBe(false);
    expect(preview.panelIssues.join(" ")).toContain("panel_needs_three_judges");
    await expect(ev.publishCommunityEvidence({
      userId: f.userId, benchmarkId, previewHash: preview.previewHash, consentVersion: "consent-v1",
    })).rejects.toThrow(/not evidence-grade \(decision D12\)[\s\S]*or keep this result private/);
  });
});

describe("pre-D12 stored plans survive the change", () => {
  it("a frozen plan with no variant keys re-quotes to its original hash and kept the original prompt version", async () => {
    const f = await seedFixture();
    const { benchmarkId, quote } = await runToCompletion({
      userId: f.userId, projectId: f.projectId,
      cases: [{ inputText: "case one" }, { inputText: "case two" }],
      judges: [{ providerId: f.providerId, model: "judge-ds" }],
    });
    const db = await connection();
    const [bench] = await db.select().from(schema.benchmarks).where(eq(schema.benchmarks.id, benchmarkId)).limit(1);
    // The frozen plan is exactly the pre-D12 shape and its stored hash still
    // matches a fresh derivation (resume/re-approval depends on this).
    expect(String(bench.plan)).not.toContain("variant");
    expect(quote.counts.judgingPromptVariants).toBeUndefined();
    const again = await svc.quoteBenchmark({ userId: f.userId, benchmarkId });
    expect(again.planHash).toBe(String(bench.planHash));
    const judgments = await db.select({ v: schema.benchmarkJudgments.judgePromptVersion }).from(schema.benchmarkJudgments)
      .where(eq(schema.benchmarkJudgments.benchmarkId, benchmarkId));
    expect(judgments.map((j) => j.v)).toEqual(["judge-v1", "judge-v1"]);
    void ev;
  });
});
