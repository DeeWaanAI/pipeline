// DB-backed drill for the private-evaluation golden path (offering redesign
// v2, P2b: spec §4.1/§9, A06). Requires the LOCAL docker stack
// (docker compose -f docker-compose.v2.yml up -d). Uses a THROWAWAY database
// (`swarm_v2test`, recreated per run and dropped after) — never the dev
// schema, never production.
//
// No provider call happens in these tests: start only FREEZES and fans out
// queued children, so any recorded spend here would be a bug.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";

// Its own throwaway schema: designJobService.integration.test.ts owns
// `swarm_v2test`, and vitest runs files in parallel — sharing a name makes one
// file's afterAll DROP/REVOKE pull the schema out from under the other.
const TEST_DB = "swarm_v2test_bench";
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
}, 240_000);

afterAll(async () => {
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    // Revoke ONLY this test's own grant on the throwaway schema.
    await admin.query(`REVOKE ALL PRIVILEGES ON \`${TEST_DB}\`.* FROM 'swarm'@'%'`);
    await admin.end();
  }
});

// Provision the throwaway schema from the same source of truth as `npm run db:push`.
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

const benchmarkRow = async (id: number) => {
  const db = await connection();
  const [row] = await db.select().from(schema.benchmarks).where(eq(schema.benchmarks.id, id)).limit(1);
  return row;
};

/** A user owning one provider and an N-step workflow. */
async function seedFixture(opts: { steps?: number } = {}) {
  const db = await connection();
  const { users, projects, llmProviders, pipelineSteps } = schema;
  const stepCount = opts.steps ?? 2;

  const [u] = await db.insert(users).values({ name: "Eval Tester", email: `et-${Date.now()}-${Math.random()}@example.test`, tier: "pro_auto" });
  const userId = Number((u as { insertId: number }).insertId);
  const [p] = await db.insert(projects).values({ userId, name: "Eval Project" });
  const projectId = Number((p as { insertId: number }).insertId);
  const [prov] = await db.insert(llmProviders).values({
    userId, name: "fake", slug: `fake-${userId}`, baseUrl: "http://localhost:1", apiKeyRef: "dummy", defaultModel: "fake-model",
  });
  const providerId = Number((prov as { insertId: number }).insertId);
  await db.insert(pipelineSteps).values(
    Array.from({ length: stepCount }, (_, i) => ({
      projectId, stepOrder: i + 1, stepType: "agent", name: `Step ${i + 1}`, role: "builder",
      systemPrompt: `prompt ${i + 1}`, isEnabled: true, providerId, model: "fake-model",
    })),
  );
  return { db, userId, projectId, providerId };
}

const createInput = (f: { userId: number; projectId: number; providerId: number }, cases = 3) => ({
  userId: f.userId,
  projectId: f.projectId,
  cases: Array.from({ length: cases }, (_, i) => ({ inputText: `task ${i + 1}` })),
  judges: [{ providerId: f.providerId, model: "fake-model" }],
});

describe("judging prompt editor (DB-backed)", () => {
  it("previews without writes, saves with revision checks, invalidates approvals and freezes at start", async () => {
    const f = await seedFixture();
    const outsider = await seedFixture();
    const benchmarkId = await svc.createBenchmarkDraft(createInput(f, 1));
    const { getJudgePromptEditor, saveJudgePromptEditor } = await import("./judgePromptEditor");
    const opts = { userId: f.userId, benchmarkId };
    const before = await getJudgePromptEditor(opts);
    const quote = await svc.quoteBenchmark(opts);
    const spendApprovalId = await svc.approveBenchmarkSpend({ ...opts, planHash: quote.planHash });
    const overrides = { default: { system: "Evaluate for a business reader.", preface: "Check actionable advice before scoring." } };
    const preview = await getJudgePromptEditor({ ...opts, overrides });
    expect(preview.prompts[0].messages[0].content).toContain(overrides.default.system);
    expect((await getJudgePromptEditor(opts)).revision).toBe(before.revision);
    await expect(getJudgePromptEditor({ ...opts, userId: outsider.userId })).rejects.toThrow("Benchmark not found");
    await expect(saveJudgePromptEditor({ ...opts, userId: outsider.userId, expectedRevision: before.revision, overrides })).rejects.toThrow("Benchmark not found");
    const saved = await saveJudgePromptEditor({ ...opts, expectedRevision: before.revision, overrides });
    expect(saved.overrides).toEqual(overrides);
    expect(saved.prompts[0].promptVersion).not.toBe(before.prompts[0].promptVersion);
    expect(saved.revision).not.toBe(before.revision);
    const currentQuote = await svc.quoteBenchmark(opts);
    expect(currentQuote.planHash).not.toBe(quote.planHash);
    expect(await svc.startBenchmark({ ...opts, planHash: quote.planHash, spendApprovalId })).toMatchObject({ ok: false });
    await expect(saveJudgePromptEditor({ ...opts, expectedRevision: before.revision, overrides: {} })).rejects.toThrow("changed");
    const newApproval = await svc.approveBenchmarkSpend({ ...opts, planHash: currentQuote.planHash });
    expect(await svc.startBenchmark({ ...opts, planHash: currentQuote.planHash, spendApprovalId: newApproval })).toMatchObject({ ok: true });
    const started = await getJudgePromptEditor(opts);
    expect(started.editable).toBe(false);
    expect(started.prompts).toEqual(saved.prompts);
    await expect(saveJudgePromptEditor({ ...opts, expectedRevision: started.revision, overrides: {} })).rejects.toThrow("immutable");
    expect((await getJudgePromptEditor(opts)).overrides).toEqual(overrides);
  });

  it("allows only one concurrent save from a revision and can restore defaults", async () => {
    const f = await seedFixture();
    const benchmarkId = await svc.createBenchmarkDraft(createInput(f, 1));
    const { getJudgePromptEditor, saveJudgePromptEditor } = await import("./judgePromptEditor");
    const opts = { userId: f.userId, benchmarkId };
    const before = await getJudgePromptEditor(opts);
    const results = await Promise.allSettled(["UPPER", "upper"].map((system) => saveJudgePromptEditor({
      ...opts, expectedRevision: before.revision, overrides: { default: { system, preface: "Score" } },
    })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const current = await getJudgePromptEditor(opts);
    const reset = await saveJudgePromptEditor({ ...opts, expectedRevision: current.revision, overrides: {} });
    expect(reset.prompts).toEqual(before.prompts);
    expect(JSON.parse((await benchmarkRow(benchmarkId)).plan!)).not.toHaveProperty("judgePromptOverrides");
  });
});

describe("private evaluation golden path (DB-backed)", () => {
  it("create stores a draft with NO frozen version yet (pipeline_version_id is NULL)", async () => {
    const f = await seedFixture();
    const benchmarkId = await svc.createBenchmarkDraft(createInput(f));
    expect(benchmarkId).toBeGreaterThan(0);

    const row = await benchmarkRow(benchmarkId);
    expect(row.state).toBe("draft");
    expect(row.pipelineVersionId).toBeNull();
    expect(row.sourceProjectId).toBe(f.projectId);
    // The Test journey default: grade the workflow as configured (A01).
    expect(row.executionMode).toBe("grade_only");
  });

  it("quote is read-only: it counts and prices without writing a version", async () => {
    const f = await seedFixture();
    const benchmarkId = await svc.createBenchmarkDraft(createInput(f));
    const versionsBefore = (await f.db.select({ id: schema.pipelineVersions.id }).from(schema.pipelineVersions)).length;

    const quote = await svc.quoteBenchmark({ userId: f.userId, benchmarkId });
    const versionsAfter = (await f.db.select({ id: schema.pipelineVersions.id }).from(schema.pipelineVersions)).length;

    expect(versionsAfter).toBe(versionsBefore);
    // 3 cases x 1 candidate x 1 repeat x 2 steps; 1 judge → 3 judgments.
    expect(quote.counts).toMatchObject({
      cases: 3, candidates: 1, generationRepeats: 1, judges: 1, stepsPerGeneration: 2,
      generationCalls: 6, judgingCalls: 3,
    });
    expect(quote.planHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("create → quote → approve → start completes, and nothing is spent", async () => {
    const f = await seedFixture();
    const benchmarkId = await svc.createBenchmarkDraft(createInput(f));
    const quote = await svc.quoteBenchmark({ userId: f.userId, benchmarkId });
    expect(quote.blockingErrors).toEqual([]);

    const approvalId = await svc.approveBenchmarkSpend({ userId: f.userId, benchmarkId, planHash: quote.planHash });
    const started = await svc.startBenchmark({ userId: f.userId, benchmarkId, planHash: quote.planHash, spendApprovalId: approvalId });
    expect(started).toEqual({ ok: true, state: "queued" });

    const bench = await benchmarkRow(benchmarkId);
    expect(bench.state).toBe("queued");
    expect(bench.planHash).toBe(quote.planHash);
    expect(Number(bench.pipelineVersionId)).toBeGreaterThan(0); // frozen at start

    // One child per case x candidate x repeat, bound to a real version.
    const children = await f.db.select().from(schema.benchmarkRuns).where(eq(schema.benchmarkRuns.benchmarkId, benchmarkId));
    expect(children).toHaveLength(3);
    expect(children.every((r) => r.status === "pending")).toBe(true);
    const candidates = await f.db.select().from(schema.benchmarkCandidates).where(eq(schema.benchmarkCandidates.benchmarkId, benchmarkId));
    expect(candidates).toHaveLength(1);
    expect(Number(candidates[0].workflowVersionId)).toBe(Number(bench.pipelineVersionId));

    const frozen = JSON.parse(String(bench.plan)) as { candidates: Array<{ stableCandidateId: string; baseVersionId: number }> };
    expect(frozen.candidates[0].stableCandidateId).toBe("pipeline-as-configured");
    expect(frozen.candidates[0].baseVersionId).toBe(Number(bench.pipelineVersionId));

    // The approval is consumed exactly once, and NO provider call happened.
    const [approval] = await f.db.select().from(schema.spendApprovals).where(eq(schema.spendApprovals.id, approvalId));
    expect(approval.status).toBe("consumed");
    const attempts = await f.db.select().from(schema.callAttempts).where(eq(schema.callAttempts.benchmarkId, benchmarkId));
    expect(attempts).toHaveLength(0);
  });

  it("A06: a plan edited after approval refuses to start and keeps its approval unspent", async () => {
    const f = await seedFixture();
    const benchmarkId = await svc.createBenchmarkDraft(createInput(f));
    const quote = await svc.quoteBenchmark({ userId: f.userId, benchmarkId });
    const approvalId = await svc.approveBenchmarkSpend({ userId: f.userId, benchmarkId, planHash: quote.planHash });

    const prepared = await svc.prepareCasesDraft({
      userId: f.userId, benchmarkId,
      cases: [{ inputText: "task 1" }, { inputText: "task 2" }, { inputText: "task 3" }, { inputText: "task 4" }],
    });
    expect(prepared.ok).toBe(true);

    const refused = await svc.startBenchmark({ userId: f.userId, benchmarkId, planHash: quote.planHash, spendApprovalId: approvalId });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toContain("plan_changed");

    const bench = await benchmarkRow(benchmarkId);
    expect(bench.state).toBe("draft");
    const [approval] = await f.db.select().from(schema.spendApprovals).where(eq(schema.spendApprovals.id, approvalId));
    expect(approval.status).toBe("active");
  });

  it("A06: a rubric change invalidates the approval; re-quote + re-approve starts", async () => {
    const f = await seedFixture();
    const benchmarkId = await svc.createBenchmarkDraft(createInput(f));
    const quote = await svc.quoteBenchmark({ userId: f.userId, benchmarkId });
    const approvalId = await svc.approveBenchmarkSpend({ userId: f.userId, benchmarkId, planHash: quote.planHash });

    const rubric = await svc.prepareRubricDraft({ userId: f.userId, benchmarkId, preset: "translation" });
    expect(rubric.ok).toBe(true);
    expect((await svc.startBenchmark({ userId: f.userId, benchmarkId, planHash: quote.planHash, spendApprovalId: approvalId })).ok).toBe(false);

    const second = await svc.quoteBenchmark({ userId: f.userId, benchmarkId });
    expect(second.planHash).not.toBe(quote.planHash);
    expect(second.blockingErrors).toEqual([]);
    const approval2 = await svc.approveBenchmarkSpend({ userId: f.userId, benchmarkId, planHash: second.planHash });
    expect((await svc.startBenchmark({ userId: f.userId, benchmarkId, planHash: second.planHash, spendApprovalId: approval2 })).ok).toBe(true);
  });

  it("preflight: a workflow with a human approval step cannot be approved for spend", async () => {
    const f = await seedFixture({ steps: 1 });
    await f.db.insert(schema.pipelineSteps).values({
      projectId: f.projectId, stepOrder: 2, stepType: "approval", name: "Human gate", role: "reviewer",
      systemPrompt: "needs a person", isEnabled: true,
    });
    const benchmarkId = await svc.createBenchmarkDraft(createInput(f));
    const quote = await svc.quoteBenchmark({ userId: f.userId, benchmarkId });
    expect(quote.blockingErrors.join("\n")).toContain("approval (human-in-the-loop) steps");
    await expect(svc.approveBenchmarkSpend({ userId: f.userId, benchmarkId, planHash: quote.planHash })).rejects.toThrow(/plan_not_executable/);
  });

  it("authorization: another user cannot quote, approve or start someone else's plan", async () => {
    const owner = await seedFixture();
    const intruder = await seedFixture();
    const benchmarkId = await svc.createBenchmarkDraft(createInput(owner));
    await expect(svc.quoteBenchmark({ userId: intruder.userId, benchmarkId })).rejects.toThrow(/not_found_or_not_authorized/);
    const quote = await svc.quoteBenchmark({ userId: owner.userId, benchmarkId });
    await expect(svc.approveBenchmarkSpend({ userId: intruder.userId, benchmarkId, planHash: quote.planHash })).rejects.toThrow(/not_found_or_not_authorized/);
    expect((await svc.startBenchmark({ userId: intruder.userId, benchmarkId, planHash: quote.planHash, spendApprovalId: 1 })).ok).toBe(false);
    expect((await benchmarkRow(benchmarkId)).state).toBe("draft");
  });
});
