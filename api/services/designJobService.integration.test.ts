// Integration drill for durable design jobs (offering redesign v2, A03–A05).
// Requires the LOCAL docker stack (v2-mysql). Uses a THROWAWAY database
// (`swarm_v2test`, recreated per run and dropped after) — never the dev
// schema, never production. The provider call is faked via a module mock,
// so no external LLM traffic and no API keys are involved.
//
// Run standalone:  npm run check && docker compose -f docker-compose.v2.yml up -d

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";

const TEST_DB = "swarm_v2test";
const ROOT_MYSQL = process.env.MYSQL_ROOT_URL || "mysql://root:rootpass@localhost:3307";

// Control surface for the faked designer generation.
const ctrl = vi.hoisted(() => ({
  impl: null as null | (() => Promise<{ design: unknown; attempt: unknown; model: string }>),
}));

vi.mock("./designGenerationService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./designGenerationService")>();
  return {
    ...actual,
    generateDesignCandidate: async (opts: unknown) => {
      if (!ctrl.impl) throw new Error("test did not set ctrl.impl");
      return ctrl.impl();
    },
  };
});

let svc: typeof import("./designJobService");
let schema: typeof import("@db/schema");
let orm: typeof import("drizzle-orm");
let admin: mysql.Connection;

beforeAll(async () => {
  // Isolated DB + explicit env BEFORE loading any app module.
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

  svc = await import("./designJobService");
  schema = await import("@db/schema");
  orm = await import("drizzle-orm");
}, 240_000);

afterAll(async () => {
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    // Revoke ONLY the throwaway grant (mysql 8 keeps per-db partial_revokes;
    // never touch the user's grants on the dev schema).
    await admin.query(`REVOKE ALL PRIVILEGES ON \`${TEST_DB}\`.* FROM 'swarm'@'%'`);
    await admin.end();
  }
});

// Provision the throwaway schema via the same source of truth as `npm run db:push`.
async function pushSchema() {
  const { execFileSync } = await import("node:child_process");
  execFileSync("npx", ["drizzle-kit", "push", "--force"], {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    stdio: "ignore",
    timeout: 150_000,
  });
}

const validDesign = {
  agents: [
    { name: "Translator", role: "builder", systemPrompt: "translate x" },
    { name: "Editor", role: "refiner", systemPrompt: "refine x" },
  ],
  pipeline: [
    { name: "Translator", role: "builder", type: "agent" },
    { name: "Editor", role: "refiner", type: "agent" },
  ],
  explanation: "two-step translation",
};

async function seedFixture() {
  const db = (await import("../queries/connection")).getDb();
  const { users, projects, llmProviders, entitlements, pipelineSteps } = schema;
  const { eq } = orm;

  const [u] = await db.insert(users).values({ name: "Design Tester", email: `dt-${Date.now()}@example.test`, tier: "pro_auto" });
  const userId = Number((u as { insertId: number }).insertId);
  const [p] = await db.insert(projects).values({ userId, name: "Fixture Project" });
  const projectId = Number((p as { insertId: number }).insertId);
  const [prov] = await db.insert(llmProviders).values({
    userId, name: "fake", slug: "fake", baseUrl: "http://localhost:1", apiKeyRef: "dummy", defaultModel: "fake-model",
  });
  const providerId = Number((prov as { insertId: number }).insertId);
  await db.insert(entitlements).values({ subjectType: "user", subjectId: userId, capability: "pipeline:autodesign", source: "tier" });
  await db.insert(pipelineSteps).values([
    { projectId, stepOrder: 1, stepType: "agent", name: "Old Step", role: "builder", systemPrompt: "legacy prompt", isEnabled: true },
  ]);
  return { db, userId, projectId, providerId };
}

describe("MCP manual pipeline provider routing (DB-backed)", () => {
  it("round-trips owned per-step providers through create, get, update and templates", async () => {
    const { db, userId, providerId } = await seedFixture();
    const [second] = await db.insert(schema.llmProviders).values({
      userId, name: "second", slug: "fake", baseUrl: "http://localhost:1", apiKeyRef: "dummy", defaultModel: "model-b",
    });
    const secondId = Number(second.insertId);
    const { createPipeline } = await import("../mcp/tools/createPipeline");
    const { updatePipeline } = await import("../mcp/tools/updatePipeline");
    const { getPipeline } = await import("../mcp/tools/getPipeline");
    const ctx = { userId, scopes: new Set(["mcp:read", "mcp:write"]), clientId: "test", requestId: "test", locale: "en" as const };
    const steps = [
      { name: "Route A", role: "builder", systemPrompt: "Draft", model: "model-a", providerId },
      { name: "Route B", role: "refiner", systemPrompt: "Review", model: "model-b", providerId: secondId },
      { name: "Default", role: "critic", systemPrompt: "Check" },
    ];
    const created = await createPipeline.handler({ name: "Multi-provider", defaultProviderId: providerId, steps }, ctx) as { id: number };
    expect(await getPipeline.handler({ id: created.id }, ctx)).toMatchObject({
      defaultProviderId: providerId,
      steps: [{ providerId, model: "model-a" }, { providerId: secondId, model: "model-b" }, { providerId: null }],
    });
    const [template] = await db.select().from(schema.pipelineTemplates)
      .where(orm.eq(schema.pipelineTemplates.sourceProjectId, created.id));
    expect(template.steps).toMatchObject([{ providerId }, { providerId: secondId }, { providerId: null }]);
    await updatePipeline.handler({ id: created.id, steps: [{ ...steps[0], providerId: secondId }] }, ctx);
    expect(await getPipeline.handler({ id: created.id }, ctx)).toMatchObject({
      defaultProviderId: providerId, steps: [{ providerId: secondId }],
    });
    await updatePipeline.handler({ id: created.id, steps: [{ ...steps[0], providerId: null }] }, ctx);
    expect(await getPipeline.handler({ id: created.id }, ctx)).toMatchObject({
      defaultProviderId: providerId, steps: [{ providerId: null }],
    });
  });

  it("refuses foreign step and default providers before any create or update writes", async () => {
    const owner = await seedFixture();
    const foreign = await seedFixture();
    const { db, userId, projectId } = owner;
    const { createPipeline } = await import("../mcp/tools/createPipeline");
    const { updatePipeline } = await import("../mcp/tools/updatePipeline");
    const ctx = { userId, scopes: new Set(["mcp:read", "mcp:write"]), clientId: "test", requestId: "test", locale: "en" as const };
    const before = {
      projects: await db.select().from(schema.projects),
      steps: await db.select().from(schema.pipelineSteps),
      agents: await db.select().from(schema.customAgents),
      templates: await db.select().from(schema.pipelineTemplates),
    };
    const step = { name: "Forbidden", role: "builder", systemPrompt: "Draft", providerId: foreign.providerId };
    for (const patch of [{ steps: [step] }, { defaultProviderId: foreign.providerId }]) {
      await expect(createPipeline.handler({ name: "Must not exist", ...patch }, ctx)).rejects.toThrow(/not one of your configured providers/);
      await expect(updatePipeline.handler({ id: projectId, name: "Must not rename", ...patch }, ctx)).rejects.toThrow(/not one of your configured providers/);
    }
    expect({
      projects: await db.select().from(schema.projects),
      steps: await db.select().from(schema.pipelineSteps),
      agents: await db.select().from(schema.customAgents),
      templates: await db.select().from(schema.pipelineTemplates),
    }).toEqual(before);
  });
});

describe("durable design jobs (DB-backed)", () => {
  it("A04/§5.3: start is idempotent per actor key and writes job+outbox atomically", async () => {
    const { userId, projectId, providerId } = await seedFixture();
    const r1 = await svc.startDesignJob({ userId, projectId, task: "translate docs", providerId, idempotencyKey: "k1" });
    const r2 = await svc.startDesignJob({ userId, projectId, task: "translate docs", providerId, idempotencyKey: "k1" });
    expect(r2.job.id).toBe(r1.job.id);
    expect(r2.reused).toBe(true);
    const { applyDesignJobTool } = await import("../mcp/tools/designJobStatus");
    expect(await applyDesignJobTool.handler({ jobId: r1.job.id }, {
      userId, scopes: new Set(["mcp:write"]), clientId: "test", requestId: "test", locale: "en",
    })).toMatchObject({ ok: false, state: "not_ready" });

    const db = (await import("../queries/connection")).getDb();
    const outbox = await db.select().from(schema.jobOutbox).where(orm.eq(schema.jobOutbox.resourceId, r1.job.id));
    expect(outbox).toHaveLength(1);
    expect(outbox[0].eventKey).toBe(`design-job:${r1.job.id}:start`);
  });

  it("§5.2 shared authz: a provider owned by someone else is rejected before enqueue", async () => {
    const a = await seedFixture();
    const b = await seedFixture();
    await expect(
      svc.authorizeDesignRequest(a.userId, a.projectId, b.providerId),
    ).rejects.toThrow(/not owned/);
  });

  it("A03: success retains a candidate version; project untouched until applied; apply is revision-checked", async () => {
    const { db, userId, projectId, providerId } = await seedFixture();
    const { job } = await svc.startDesignJob({ userId, projectId, task: "t", providerId });

    ctrl.impl = async () => ({
      design: validDesign,
      attempt: { attemptIndex: 1, outcome: "success", model: "fake-model", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() },
      model: "fake-model",
    });

    const lease = await svc.acquireDesignJob(job.id);
    expect(lease).toBeTruthy();
    await svc.runDesignJobGeneration(job.id, lease!);

    const [done] = await db.select().from(schema.designJobs).where(orm.eq(schema.designJobs.id, job.id));
    expect(done.errorMessage ?? done.state, `state=${done.state}`).toBe("succeeded");
    expect(done.applyState).toBe("not_applied");
    expect(done.candidateVersionId).toBeTruthy();

    // Project steps are still the legacy single step — generation never writes live projects.
    let steps = await db.select().from(schema.pipelineSteps).where(orm.eq(schema.pipelineSteps.projectId, projectId));
    expect(steps).toHaveLength(1);
    expect(steps[0].name).toBe("Old Step");

    const { applyDesignJobTool } = await import("../mcp/tools/designJobStatus");
    const ctx = { userId, scopes: new Set(["mcp:write"]), clientId: "test", requestId: "test", locale: "en" as const };
    const outsider = await seedFixture();
    expect(await applyDesignJobTool.handler({ jobId: job.id }, { ...ctx, userId: outsider.userId }))
      .toEqual({ ok: false, state: "not_ready", message: "Job not found" });
    expect(await db.select().from(schema.pipelineSteps).where(orm.eq(schema.pipelineSteps.projectId, projectId))).toEqual(steps);
    const applied = await applyDesignJobTool.handler({ jobId: job.id }, ctx);
    expect(applied).toMatchObject({ ok: true, state: "applied" });
    expect(await applyDesignJobTool.handler({ jobId: job.id }, ctx))
      .toEqual({ ok: true, state: "applied", message: "Already applied" });
    steps = await db.select().from(schema.pipelineSteps).where(orm.eq(schema.pipelineSteps.projectId, projectId));
    expect(steps).toHaveLength(2);
    expect(steps.map((s) => s.role)).toEqual(["builder", "refiner"]);
  });

  it("A03: a project edited while the job ran yields a retained candidate + revision_conflict, NOT an overwrite", async () => {
    const { db, userId, projectId, providerId } = await seedFixture();
    const { job } = await svc.startDesignJob({ userId, projectId, task: "t", providerId });

    ctrl.impl = async () => ({
      design: validDesign,
      attempt: { attemptIndex: 1, outcome: "success", model: "fake-model", startedAt: new Date().toISOString() },
      model: "fake-model",
    });
    const lease = await svc.acquireDesignJob(job.id);
    await svc.runDesignJobGeneration(job.id, lease!);

    // Owner edits the project in the legacy editor (no v2 counter bump):
    await db.update(schema.pipelineSteps).set({ systemPrompt: "owner edited this" })
      .where(orm.eq(schema.pipelineSteps.projectId, projectId));

    const { applyDesignJobTool } = await import("../mcp/tools/designJobStatus");
    const res = await applyDesignJobTool.handler({ jobId: job.id }, {
      userId, scopes: new Set(["mcp:write"]), clientId: "test", requestId: "test", locale: "en",
    });
    expect(res).toMatchObject({ state: "revision_conflict", ok: false });

    // Existing steps preserved (the edit survives) and the candidate is retained.
    const steps = await db.select().from(schema.pipelineSteps).where(orm.eq(schema.pipelineSteps.projectId, projectId));
    expect(steps).toHaveLength(1);
    expect(steps[0].systemPrompt).toBe("owner edited this");
    const [j] = await db.select().from(schema.designJobs).where(orm.eq(schema.designJobs.id, job.id));
    expect(j.candidateDefinition).toBeTruthy();
    expect(j.applyState).toBe("revision_conflict");
  });

  it("A03: an invalid graph fails the job WITHOUT deleting existing steps", async () => {
    const { db, userId, projectId, providerId } = await seedFixture();
    const { job } = await svc.startDesignJob({ userId, projectId, task: "t", providerId });

    ctrl.impl = async () => ({
      design: {
        ...validDesign,
        pipeline: [
          { name: "Gate", role: "critic", type: "if", ifOptions: ["revise"], ifMappings: { revise: 42 } },
          { name: "B", role: "builder", type: "agent" },
        ],
      },
      attempt: { attemptIndex: 1, outcome: "success", model: "fake-model", startedAt: new Date().toISOString() },
      model: "fake-model",
    });

    const lease = await svc.acquireDesignJob(job.id);
    await svc.runDesignJobGeneration(job.id, lease!);

    const [failed] = await db.select().from(schema.designJobs).where(orm.eq(schema.designJobs.id, job.id));
    expect(failed.state).toBe("failed");
    expect(failed.errorCode).toBe("invalid_graph");
    expect(failed.errorMessage).toMatch(/nonexistent step/);
    const steps = await db.select().from(schema.pipelineSteps).where(orm.eq(schema.pipelineSteps.projectId, projectId));
    expect(steps).toHaveLength(1); // untouched
  });

  it("A05: duplicate workers cannot both own the job (lease semantics)", async () => {
    const { userId, projectId, providerId } = await seedFixture();
    const { job } = await svc.startDesignJob({ userId, projectId, task: "t", providerId });
    const lease1 = await svc.acquireDesignJob(job.id);
    const lease2 = await svc.acquireDesignJob(job.id);
    expect(lease1).toBeTruthy();
    expect(lease2).toBeNull();
  });

  it("A05: crashed runs (expired lease) are healed back to queued with attempt history", async () => {
    const { db, userId, projectId, providerId } = await seedFixture();
    const { job } = await svc.startDesignJob({ userId, projectId, task: "t", providerId });
    // Simulate a worker that died holding the lease.
    await db.update(schema.designJobs)
      .set({ state: "running", leaseToken: "dead-worker", leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(orm.eq(schema.designJobs.id, job.id));

    const flagged = await svc.healStaleDesignJobs();
    expect(flagged).toBeGreaterThanOrEqual(1);
    const [healed] = await db.select().from(schema.designJobs).where(orm.eq(schema.designJobs.id, job.id));
    expect(healed.state).toBe("queued");
    expect(healed.attemptCount).toBe(1);
  });

  it("§5.3: cancellation while running finalizes as cancelled, not succeeded", async () => {
    const { db, userId, projectId, providerId } = await seedFixture();
    const { job } = await svc.startDesignJob({ userId, projectId, task: "t", providerId });
    const lease = await svc.acquireDesignJob(job.id);
    await svc.cancelDesignJob({ userId, jobId: job.id }); // running → sets cancelRequestedAt

    ctrl.impl = async () => ({
      design: validDesign,
      attempt: { attemptIndex: 1, outcome: "success", model: "fake-model", startedAt: new Date().toISOString() },
      model: "fake-model",
    });
    await svc.runDesignJobGeneration(job.id, lease!);

    const [done] = await db.select().from(schema.designJobs).where(orm.eq(schema.designJobs.id, job.id));
    expect(done.state).toBe("cancelled");
    expect(done.candidateVersionId).toBeTruthy(); // work paid for is retained
  });
});
