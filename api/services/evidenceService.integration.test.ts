// DB-backed evidence-publication drill (offering redesign v2, P3: spec §7.3,
// §6.2, §10.2; acceptance tests A09/A10/A13 and the publication half of the
// A12 leakage check). Own throwaway schema (`swarm_v2test_evidence`) so it
// never collides with the other parallel integration files.
//
// Engine + judge are faked exactly as in the execution drill; freeze, ledger,
// manifest, hashing, publication and withdrawal are the real code.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";

const exec = vi.hoisted(() => ({ calls: [] as number[] }));

vi.mock("./swarmService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./swarmService")>();
  return {
    ...actual,
    executeSwarmRun: async (params: { swarmRunId: number }) => {
      const { getDb } = await import("../queries/connection");
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
        projectId: run.projectId, responseType: "final", content: `public-looking output for ${run.userPrompt}`,
        metadata: {
          model: "fake-model", provider: "fake", providerSlug: "fake",
          tokensUsed: { prompt: 100, completion: 20, total: 120 }, latencyMs: 5, temperature: 0.7, maxTokens: 1024,
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

vi.mock("./benchmark/judgeService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./benchmark/judgeService")>();
  return {
    ...actual,
    generateJudgeCall: async () => ({
      content: JSON.stringify({
        scores: { accuracy: 8, completeness: 7, instructionFit: 9, clarity: 6 },
        rationale: "solid but terse",
      }),
      model: "judge-model", promptTokens: 400, completionTokens: 60,
    }),
  };
});

const TEST_DB = "swarm_v2test_evidence";
const ROOT_MYSQL = process.env.MYSQL_ROOT_URL || "mysql://root:rootpass@localhost:3307";

let svc: typeof import("./benchmark/benchmarkService");
let ev: typeof import("./evidenceService");
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
  svc = await import("./benchmark/benchmarkService");
  ev = await import("./evidenceService");
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
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL }, stdio: "ignore", timeout: 150_000,
  });
}

async function connection() {
  return (await import("../queries/connection")).getDb();
}

const SECRET_PROMPT = "Translate the clause. Internal note: use customer PII from /vault and the key sk-ABCDEFGHIJKL1234567890.";

async function seedFixture() {
  const db = await connection();
  const stamp = `${Date.now()}-${Math.random()}`;
  const [u] = await db.insert(schema.users).values({ name: "Publisher", email: `p-${stamp}@example.test`, tier: "pro_auto" });
  const userId = Number((u as { insertId: number }).insertId);
  const [p] = await db.insert(schema.projects).values({ userId, name: "Publisher Project" });
  const projectId = Number((p as { insertId: number }).insertId);
  const [prov] = await db.insert(schema.llmProviders).values({
    userId, name: `fake-${stamp}`, slug: `fake-${stamp}`, baseUrl: "http://localhost:1", apiKeyRef: "dummy", defaultModel: "fake-model",
  });
  const providerId = Number((prov as { insertId: number }).insertId);
  await db.insert(schema.pipelineSteps).values([
    { projectId, stepOrder: 1, stepType: "agent", name: "Draft", role: "builder", systemPrompt: SECRET_PROMPT, isEnabled: true, providerId, model: "fake-model" },
    { projectId, stepOrder: 2, stepType: "agent", name: "Polish", role: "polisher", systemPrompt: "polish it", isEnabled: true, providerId, model: "fake-model" },
  ]);
  return { db, userId, projectId, providerId };
}

/** A completed benchmark whose children were really executed by the plan. */
async function completedBenchmark(f: Awaited<ReturnType<typeof seedFixture>>) {
  const benchmarkId = await svc.createBenchmarkDraft({
    userId: f.userId, projectId: f.projectId,
    cases: [{ inputText: "clause one" }, { inputText: "clause two" }],
    judges: [{ providerId: f.providerId, model: "judge-model" }],
  });
  const quote = await svc.quoteBenchmark({ userId: f.userId, benchmarkId });
  const approval = await svc.approveBenchmarkSpend({ userId: f.userId, benchmarkId, planHash: quote.planHash });
  const started = await svc.startBenchmark({ userId: f.userId, benchmarkId, planHash: quote.planHash, spendApprovalId: approval });
  expect(started.ok).toBe(true);
  const lease = await svc.acquireBenchmark(benchmarkId);
  await svc.executeBenchmark({ benchmarkId, leaseToken: lease! });
  const db = await connection();
  const [bench] = await db.select().from(schema.benchmarks).where(eq(schema.benchmarks.id, benchmarkId)).limit(1);
  return { benchmarkId, bench };
}

const publicationRow = async (id: number) => {
  const db = await connection();
  const [row] = await db.select().from(schema.evidencePublications).where(eq(schema.evidencePublications.id, id)).limit(1);
  return row;
};

describe("evidence publication (DB-backed)", () => {
  it("builds a manifest that satisfies the frozen public contract and repeats byte-for-byte", async () => {
    const f = await seedFixture();
    const { benchmarkId } = await completedBenchmark(f);

    const first = await ev.buildEvidencePreview({ userId: f.userId, benchmarkId, publicationKind: "seller", consentVersion: "consent-v1" });
    const second = await ev.buildEvidencePreview({ userId: f.userId, benchmarkId, publicationKind: "seller", consentVersion: "consent-v1" });

    expect(first.previewHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.previewHash).toBe(first.previewHash);
    expect(first.eligibilityIssues).toEqual([]);
    expect(first.secretFindings).toEqual([]);
    expect(first.manifest.versionIdentity.includesPrivateDefinition).toBe(false);
    expect(first.manifest.judging.judgments.length).toBe(2);
    expect(first.manifest.attempts.planned.judgments).toBe(2);
    expect(first.manifest.attempts.completed.judgments).toBe(2);
    expect(first.manifest.attempts.allSelectedPlanAttemptsDisclosed).toBe(true);
  });

  it("discloses the things a reader needs and never the private workflow definition (A12 publication half)", async () => {
    const f = await seedFixture();
    const { benchmarkId } = await completedBenchmark(f);
    const { manifest } = await ev.buildEvidencePreview({ userId: f.userId, benchmarkId, publicationKind: "seller", consentVersion: "consent-v1" });
    const flat = JSON.stringify(manifest);

    // The seller's step prompt carries a fake secret; it must not leak.
    expect(flat).not.toContain("/vault");
    expect(flat).not.toContain("sk-ABCDEFGHIJKL1234567890");
    expect(flat).not.toContain("Internal note");

    // What §7.3 does require, explicitly.
    expect(flat).toContain("judge-v1");
    expect(flat).toContain("{{CANDIDATE_OUTPUT}}");           // exact judging template
    expect(flat).toContain("not_exposed_by_provider");        // revision stated, not inferred
    expect(manifest.judging.rubric.dimensions.reduce((a, d) => a + Number(d.weight), 0)).toBeCloseTo(1, 9);
    expect(manifest.attempts.reproducibilityLimitations.join(" ")).toContain("validators were disabled");
    expect(manifest.costs.designCostUsd).toBe("unknown");     // unknown, never zero
    expect(manifest.costs.missingItems.length).toBeGreaterThan(0);
    expect(manifest.judging.resolvedJudgeInputs.every((i) => i.hiddenSellerInstructionsIncluded === false)).toBe(true);
  });

  it("publishes only after an explicit preview hash + consent, is idempotent, and never re-dates the test", async () => {
    const f = await seedFixture();
    const { benchmarkId, bench } = await completedBenchmark(f);
    const preview = await ev.buildEvidencePreview({ userId: f.userId, benchmarkId, publicationKind: "seller", consentVersion: "consent-v1" });

    await expect(ev.publishEvidence({
      userId: f.userId, benchmarkId, previewHash: "0".repeat(64), consentVersion: "consent-v1",
    })).rejects.toThrow(/preview_changed/);

    const published = await ev.publishEvidence({
      userId: f.userId, benchmarkId, previewHash: preview.previewHash, consentVersion: "consent-v1",
    });
    expect(published.reused).toBe(false);
    const row = await publicationRow(published.publicationId);
    expect(row.state).toBe("published");
    expect(row.manifestHash).toBe(preview.previewHash);
    // testedAt is the benchmark's own completion time, not the publish time.
    expect(new Date(row.testedAt).getTime()).toBe(new Date(bench.finishedAt!).getTime());
    expect(new Date(row.publishedAt!).getTime()).toBeGreaterThanOrEqual(new Date(row.testedAt).getTime());

    const again = await ev.publishEvidence({
      userId: f.userId, benchmarkId, previewHash: preview.previewHash, consentVersion: "consent-v1",
    });
    expect(again.publicationId).toBe(published.publicationId);
    expect(again.reused).toBe(true);
  });

  it("a stranger cannot publish someone else's benchmark, and cannot read its manifest", async () => {
    const owner = await seedFixture();
    const intruder = await seedFixture();
    const { benchmarkId } = await completedBenchmark(owner);
    await expect(ev.buildEvidencePreview({
      userId: intruder.userId, benchmarkId, publicationKind: "seller", consentVersion: "consent-v1",
    })).rejects.toThrow(/not_found_or_not_authorized/);
  });

  it("refuses a seller publication whose evidence is graded from existing outputs only (§4.3)", async () => {
    const f = await seedFixture();
    const db = await connection();
    // Prior owned output to import.
    const [run] = await db.insert(schema.swarmRuns).values({ projectId: f.projectId, userId: f.userId, userPrompt: "earlier", status: "completed" });
    const swarmRunId = Number((run as { insertId: number }).insertId);
    const [ar] = await db.insert(schema.agentRuns).values({
      swarmRunId, projectId: f.projectId, agentName: "Earlier", agentRole: "builder", pipelineStep: 1, userPrompt: "earlier", status: "completed",
    });
    const [resp] = await db.insert(schema.agentResponses).values({
      agentRunId: Number((ar as { insertId: number }).insertId), swarmRunId, projectId: f.projectId,
      responseType: "final", content: "a result from last week",
      metadata: {
        model: "older-model", provider: "fake", providerSlug: "fake",
        tokensUsed: { prompt: 1, completion: 1, total: 2 }, latencyMs: 1, temperature: 0.7, maxTokens: 512,
        agentName: "Earlier", agentRole: "builder", agentSlug: "earlier", pipelineStep: 1, iteration: 1,
        buildMethod: "manual", sourceResponseIds: [],
      },
    });

    const benchmarkId = await svc.createBenchmarkDraft({
      userId: f.userId, projectId: f.projectId,
      cases: [{ inputText: "clause one" }],
      judges: [{ providerId: f.providerId, model: "judge-model" }],
      candidates: [{ label: "last-week", existingResponseId: Number((resp as { insertId: number }).insertId) }],
    });
    const quote = await svc.quoteBenchmark({ userId: f.userId, benchmarkId });
    const approval = await svc.approveBenchmarkSpend({ userId: f.userId, benchmarkId, planHash: quote.planHash });
    await svc.startBenchmark({ userId: f.userId, benchmarkId, planHash: quote.planHash, spendApprovalId: approval });
    const lease = await svc.acquireBenchmark(benchmarkId);
    await svc.executeBenchmark({ benchmarkId, leaseToken: lease! });

    // There is no manifest to disclose at all: without an executed version
    // the §4.3 gate is a refusal, not an empty preview.
    await expect(ev.buildEvidencePreview({ userId: f.userId, benchmarkId, publicationKind: "seller", consentVersion: "consent-v1" }))
      .rejects.toThrow(/not_publishable/);
    await expect(ev.publishEvidence({
      userId: f.userId, benchmarkId, previewHash: "0".repeat(64), consentVersion: "consent-v1",
    })).rejects.toThrow(/not_publishable/);
  });

  it("refuses to publish a manifest that would leak a credential, and offers the limited path instead", async () => {
    const f = await seedFixture();
    const benchmarkId = await svc.createBenchmarkDraft({
      userId: f.userId, projectId: f.projectId,
      // The secret is in the TEST INPUT this time, which is published material.
      cases: [{ inputText: "translate this; token sk-ABCDEFGHIJKL1234567890 attached" }],
      judges: [{ providerId: f.providerId, model: "judge-model" }],
    });
    const quote = await svc.quoteBenchmark({ userId: f.userId, benchmarkId });
    const approval = await svc.approveBenchmarkSpend({ userId: f.userId, benchmarkId, planHash: quote.planHash });
    await svc.startBenchmark({ userId: f.userId, benchmarkId, planHash: quote.planHash, spendApprovalId: approval });
    const lease = await svc.acquireBenchmark(benchmarkId);
    await svc.executeBenchmark({ benchmarkId, leaseToken: lease! });

    const preview = await ev.buildEvidencePreview({ userId: f.userId, benchmarkId, publicationKind: "seller", consentVersion: "consent-v1" });
    expect(preview.secretFindings).toContain("api-key-shaped token");
    await expect(ev.publishEvidence({
      userId: f.userId, benchmarkId, previewHash: preview.previewHash, consentVersion: "consent-v1",
    })).rejects.toThrow(/api-key-shaped token/);

    // Withholding the inputs is allowed, but the resulting limited report can
    // never BE the seller's qualifying evidence — refused with the §7.3 reason.
    await expect(ev.buildEvidencePreview({
      userId: f.userId, benchmarkId, publicationKind: "seller", consentVersion: "consent-v1",
      withholdInputs: true, withheldReason: "case text contains a customer token",
    })).rejects.toThrow(/limited-disclosure report cannot satisfy the v2 seller gate/);

    // As community evidence the same withheld report is honest and publishable.
    const limited = await ev.buildEvidencePreview({
      userId: f.userId, benchmarkId, publicationKind: "community", consentVersion: "consent-v1",
      withholdInputs: true, withheldReason: "case text contains a customer token",
    });
    expect(limited.disclosureClass).toBe("limited");
    expect(limited.secretFindings).toEqual([]);
    expect(limited.manifest.cases.every((c) => c.inputText === null)).toBe(true);
    const community = await ev.publishEvidence({
      userId: f.userId, benchmarkId, previewHash: limited.previewHash, consentVersion: "consent-v1", publicationKind: "community",
      withholdInputs: true, withheldReason: "case text contains a customer token",
    });
    expect(community.publicationId).toBeGreaterThan(0);
    const stored = await publicationRow(community.publicationId);
    expect(stored.provenance).toBe("platform_recorded");
    expect(JSON.parse(String(stored.publicManifest)).costs.currency).toBe("USD");
  });

  it("withdrawal and replacement are separate immutable rows; testedAt never moves", async () => {
    const f = await seedFixture();
    const { benchmarkId } = await completedBenchmark(f);
    const preview = await ev.buildEvidencePreview({ userId: f.userId, benchmarkId, publicationKind: "seller", consentVersion: "consent-v1" });
    const first = await ev.publishEvidence({ userId: f.userId, benchmarkId, previewHash: preview.previewHash, consentVersion: "consent-v1" });
    const firstRow = await publicationRow(first.publicationId);

    // consentVersion is part of the disclosed document, so the replacement must
    // be previewed UNDER consent-v2 — otherwise the hash legitimately differs.
    const v2Preview = await ev.buildEvidencePreview({ userId: f.userId, benchmarkId, publicationKind: "seller", consentVersion: "consent-v2" });
    const replaced = await ev.supersedePublication({
      userId: f.userId, supersededPublicationId: first.publicationId, benchmarkId, previewHash: v2Preview.previewHash, consentVersion: "consent-v2",
    });
    expect(replaced.publicationId).not.toBe(first.publicationId);
    const oldRow = await publicationRow(first.publicationId);
    const newRow = await publicationRow(replaced.publicationId);
    expect(oldRow.state).toBe("withdrawn");
    expect(oldRow.withdrawalReason).toContain("superseded by");
    expect(newRow.state).toBe("published");
    expect(newRow.supersedesPublicationId).toBe(first.publicationId);
    expect(newRow.consentVersion).toBe("consent-v2");
    // Same test, same test date — only the publication date is new.
    expect(new Date(newRow.testedAt).getTime()).toBe(new Date(firstRow.testedAt).getTime());

    const withdrawn = await ev.withdrawPublication({ userId: f.userId, publicationId: replaced.publicationId, reason: "seller withdrew" });
    expect(withdrawn.ok).toBe(true);
    expect((await publicationRow(replaced.publicationId)).state).toBe("withdrawn");
  });
});
