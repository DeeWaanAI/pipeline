// D14 — deliver work data, then sweep the server copy: DB-backed integration
// battery.
//
// Six claims, all measured against real rows (NO LLM CALL ANYWHERE — nothing
// here dispatches a run; the shared run is created by the real
// `pipelineSharing.startSharedRun` with a no-op dispatcher):
//   1. a delivered bundle for the caller's own project carries the run's prompt
//      and output text, and its sha256 is recomputable from the bundle it
//      returned; two deliveries of unchanged data return the SAME hash while
//      their `deliveredAt` differs (a client must be able to tell it just
//      re-wrote identical bytes);
//   2. after a confirmed sweep the content columns are gone, while the
//      `swarm_runs` / `agent_runs` / `agent_responses` ROWS still exist with
//      their ids, token counts, timestamps and `run_params` keys — and a second
//      sweep on the now-stale receipt is refused;
//   3. the never-swept invariant is ASSERTED by counting `pipeline_versions`,
//      `evidence_publications`, `marketplace_purchases`, `execution_grants`,
//      `call_attempts`, `spend_approvals` (and consent) before and after and
//      requiring identical numbers — every one of those counts is non-zero in
//      this fixture, so the equality is not a vacuous 0 === 0; the ledger's
//      dollar and token totals must not move either;
//   4. a sweep with no receipt, with the wrong confirmation, or with a forged
//      receipt is refused and deletes nothing;
//   5. a protected buyer run and a shared run (`run_only` AND `full`) are
//      refused with a reason that names the other account's interest, leak
//      neither its prompts nor its identity, and keep their server content
//      through a sweep of everything around them;
//   6. a second account cannot deliver or sweep the first account's work and
//      learns nothing about whether it exists.
//
// Own throwaway schema (`swarm_v2test_delivery`) + GET_LOCK, built by
// `drizzle-kit push --force` against db/schema.ts, exactly like
// pipelineSharing.integration.test.ts: vitest runs these files serially on
// purpose, and no suite here may touch the local `swarm` database.

import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import { count, eq, sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import * as schema from "@db/schema";
import * as relations from "@db/relations";

const TEST_DB = "swarm_v2test_delivery";

/** Distinctive fragments, so a leak can never be a false positive on common
 *  words, and so "the content is gone" is a real test rather than "it was
 *  always empty". */
const OWNER_PROMPT = "OWNER WORK INPUT: translate the harvest contract id=HC-4471-alpha";
const OWNER_STEP_PROMPT = "OWNER STEP SYSTEM PROMPT: use the glossary at /vault/glossary-HC and key sk-OWNERSTEP-9d21";
const OWNER_CONTEXT = "OWNER CONTEXT INPUT: previous clause list from /vault/clauses-HC";
const OWNER_OUTPUT = "OWNER STEP OUTPUT: the contract, rendered in French, batch 4471-alpha.";
const OWNER_FINAL = "OWNER FINAL OUTPUT: presentation-ready French translation of HC-4471-alpha.";
const OWNER_NOTES = "OWNER HUMAN NOTES: check the term for 'harvest' against the glossary.";
const CASE_INPUT = "PRIVATE BENCHMARK CASE INPUT: translate annex 12 of HC-4471-alpha";
const CASE_EXPECTED = "PRIVATE BENCHMARK EXPECTED OUTPUT: annex 12 in French";
const CASE_NOTES = "PRIVATE BENCHMARK PROVENANCE NOTES: taken from the owner's own contract folder";
const BASELINE_PROMPT = "PRIVATE BENCHMARK BASELINE PROMPT: translate this, plainly";
const BENCHMARK_OUTPUT = "PRIVATE BENCHMARK RUN OUTPUT: annex 12, machine translation";
const JUDGE_RATIONALE = "PRIVATE BENCHMARK JUDGE RATIONALE: terminology accurate, register slightly formal";
const SELLER_PROMPT = "SELLER PROTECTED STEP PROMPT: follow /vault/seller-method and sign sk-SELLER-44b7";
const GRANTOR_PROMPT = "GRANTOR SHARED STEP PROMPT: /vault/grantor-method with sk-GRANTOR-77c3";
const SWEEP_MARKER = /swept by D14 delivery/;

const isolated = vi.hoisted(() => ({ db: null as MySql2Database<typeof schema & typeof relations> | null }));
vi.mock("../queries/connection", () => ({
  getDb: () => {
    if (!isolated.db) throw new Error("D14 delivery test database is not initialized");
    return isolated.db;
  },
}));

let delivery: typeof import("./dataDelivery");
let share: typeof import("./pipelineSharing");
let canonicalJson: typeof import("./auditExport").canonicalJson;
let appMod: typeof import("../router");
let admin: mysql.Connection | undefined;
let pool: mysql.Pool | undefined;
let ownsDatabase = false;

beforeAll(async () => {
  if (process.env.NODE_ENV === "production") throw new Error("D14 delivery tests refuse production mode");
  process.env.NODE_ENV = "development";
  process.env.REDIS_URL = "";
  // The receipt is an HMAC capability: without a secret it must fail closed
  // rather than sign with an empty key.
  process.env.APP_SECRET ||= "1".repeat(64);
  process.env.AI_SWARM_MASTER_KEY ||= "2".repeat(64);
  process.env.MARKETPLACE_MASTER_KEY ||= "3".repeat(64);

  const url = new URL(process.env.MYSQL_ROOT_URL || "mysql://root:rootpass@localhost:3307");
  const connection = {
    host: url.hostname, port: Number(url.port || 3307),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
  };
  admin = await mysql.createConnection(connection);
  const [lock] = await admin.query<mysql.RowDataPacket[]>("SELECT GET_LOCK(?, 0) AS acquired", [TEST_DB]);
  if (lock[0].acquired !== 1) throw new Error("Another D14 delivery fixture is running");
  ownsDatabase = true;
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin.query(`CREATE DATABASE ${TEST_DB} CHARACTER SET utf8mb4`);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const pushUrl = new URL(`mysql://${connection.user}@${connection.host}:${connection.port}/${TEST_DB}`);
  pushUrl.password = connection.password;
  execFileSync(process.execPath,
    [fileURLToPath(new URL("../../node_modules/drizzle-kit/bin.cjs", import.meta.url)), "push", "--force"], {
    cwd: root,
    env: { PATH: process.env.PATH, NODE_ENV: "test", DATABASE_URL: pushUrl.toString(), DOTENV_CONFIG_PATH: "/dev/null" },
    stdio: "pipe", timeout: 200_000,
  });
  pool = mysql.createPool({ ...connection, database: TEST_DB, connectionLimit: 4 });
  isolated.db = drizzle(pool, { schema: { ...schema, ...relations }, mode: "default" });

  delivery = await import("./dataDelivery");
  share = await import("./pipelineSharing");
  canonicalJson = (await import("./auditExport")).canonicalJson;
  appMod = await import("../router");
}, 300_000);

afterAll(async () => {
  isolated.db = null;
  await pool?.end();
  if (admin) {
    try {
      if (ownsDatabase) {
        await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
        await admin.query("SELECT RELEASE_LOCK(?)", [TEST_DB]);
      }
    } finally {
      await admin.end();
    }
  }
});

const db = () => isolated.db!;
const insertId = (res: unknown) => Number((res as { insertId: number }).insertId);

let seq = 0;
async function mkUser(label: string): Promise<schema.User> {
  seq += 1;
  const [res] = await db().insert(schema.users).values({
    name: `${label}-${seq}`, email: `${label.toLowerCase().replace(/\s+/g, "-")}${seq}@delivery.test`,
    tier: "standard",
  });
  const [row] = await db().select().from(schema.users).where(eq(schema.users.id, insertId(res))).limit(1);
  // A consent row for every account: the sweep must leave these alone, and a
  // count of zero would make that assertion worthless.
  await db().insert(schema.userPrivacyConsent).values({ userId: row.id, allowPromptStorage: true });
  return row;
}

async function mkProvider(userId: number, name: string) {
  const [res] = await db().insert(schema.llmProviders).values({
    userId, name, slug: "openai", baseUrl: `https://api.${name}.test/v1`,
    apiKeyRef: "salt:iv:tag:not-real-ciphertext", defaultModel: `${name}-model`, isEnabled: true,
  });
  return insertId(res);
}

/** The caller's own project + one finished run: 2 steps, 3 responses, and the
 *  prompt text stored in every place the platform really stores it (including
 *  the `run_params.prompt` duplicate). */
async function mkRunOwnedByProject(user: schema.User, projectId: number, providerId: number) {
  const [run] = await db().insert(schema.swarmRuns).values({
    projectId, userId: user.id, userPrompt: OWNER_PROMPT, status: "completed",
    currentStep: "done", pipelineVersion: "custom-v2", agentsUsed: ["builder", "polisher"],
    totalTokensUsed: 1234, totalLatencyMs: 4321, finalResponseId: null,
    startedAt: new Date("2026-09-01T08:00:00Z"), completedAt: new Date("2026-09-01T08:02:00Z"),
    error: `OWNER RUN ERROR TEXT: retried once because of ${OWNER_PROMPT.slice(0, 20)}`,
    executionState: {
      currentIndex: 2,
      chain: [{ id: 1, content: OWNER_OUTPUT, agentRole: "builder", agentName: "Builder" }],
      iterationCounts: { 1: 1 },
      pendingApproval: { stepOrder: 2, lastOutput: OWNER_FINAL, action: "modify", instructions: OWNER_NOTES },
    },
    runParams: { source: "execute", prompt: OWNER_PROMPT, memoryMode: "balanced", includeProjectFiles: false },
  });
  const swarmRunId = insertId(run);

  const stepRows: number[] = [];
  for (const [stepOrder, name, role, output] of [
    [1, "Builder", "builder", OWNER_OUTPUT],
    [2, "Polisher", "polisher", OWNER_FINAL],
  ] as const) {
    const [agentRun] = await db().insert(schema.agentRuns).values({
      swarmRunId, projectId, agentName: name, agentRole: role, pipelineStep: stepOrder,
      iteration: 1, systemPrompt: OWNER_STEP_PROMPT, userPrompt: `${OWNER_PROMPT} (step ${stepOrder})`,
      contextInput: OWNER_CONTEXT, status: "completed", tokensUsed: 617, latencyMs: 2160,
      modelUsed: `${providerId}-model`, providerUsed: "openai",
    });
    const agentRunId = insertId(agentRun);
    stepRows.push(agentRunId);
    const [resp] = await db().insert(schema.agentResponses).values({
      agentRunId, swarmRunId, projectId, responseType: stepOrder === 2 ? "final" : "raw",
      content: output, humanNotes: stepOrder === 2 ? OWNER_NOTES : null, humanReviewed: stepOrder === 2,
      metadata: {
        model: "model-x", provider: "OpenAI", providerSlug: "openai",
        tokensUsed: { prompt: 400, completion: 217, total: 617 }, latencyMs: 2160,
        temperature: 0.7, maxTokens: 4096, agentName: name, agentRole: role,
        agentSlug: name.toLowerCase(), pipelineStep: stepOrder, iteration: 1,
        buildMethod: "llm", sourceResponseIds: [],
      },
    });
    if (stepOrder === 2) {
      await db().update(schema.swarmRuns).set({ finalResponseId: insertId(resp) })
        .where(eq(schema.swarmRuns.id, swarmRunId));
    }
  }
  // One intermediate that is not a step output, so the response count is not a
  // coincidence of the step count.
  const [extra] = await db().insert(schema.agentResponses).values({
    agentRunId: stepRows[0], swarmRunId, projectId, responseType: "iteration",
    content: `${OWNER_OUTPUT} (draft 1)`,
    metadata: {
      model: "model-x", provider: "OpenAI", providerSlug: "openai",
      tokensUsed: { prompt: 100, completion: 50, total: 150 }, latencyMs: 300,
      temperature: 0.7, maxTokens: 4096, agentName: "Builder", agentRole: "builder",
      agentSlug: "builder", pipelineStep: 1, iteration: 2, buildMethod: "llm", sourceResponseIds: [],
    },
  });
  return { swarmRunId, stepRows, extraResponseId: insertId(extra) };
}

/** The caller's private benchmark, with a body in every content column the
 *  sweep claims to clear. */
async function mkBenchmarkOwnedBy(user: schema.User, projectId: number) {
  const [bm] = await db().insert(schema.benchmarks).values({
    ownerId: user.id, executionMode: "grade_only", state: "completed", sourceProjectId: projectId,
    planHash: "a".repeat(64), rubricRef: "rubric/v1", totalEstimatedCost: "0.00250000",
    totalObservedCost: "0.00120000", costCompleteness: "complete",
  });
  const benchmarkId = insertId(bm);
  const [caseRow] = await db().insert(schema.benchmarkCases).values({
    benchmarkId, stableCaseId: "case-1", caseOrder: 1, inputText: CASE_INPUT,
    expectedOutput: CASE_EXPECTED, provenanceNotes: CASE_NOTES,
    contentHash: createHash("sha256").update(CASE_INPUT).digest("hex"), origin: "user",
  });
  const [candidate] = await db().insert(schema.benchmarkCandidates).values({
    benchmarkId, stableCandidateId: "solo-1", strategy: "solo_baseline",
    baselinePrompt: BASELINE_PROMPT, baselinePromptVersion: "v1", requestedModel: "model-x",
  });
  const [bRun] = await db().insert(schema.benchmarkRuns).values({
    benchmarkId, caseId: insertId(caseRow), candidateId: insertId(candidate),
    logicalExecutionId: `lx-${benchmarkId}-1`, replicationIndex: 1, status: "completed",
    outputText: BENCHMARK_OUTPUT, outputHash: createHash("sha256").update(BENCHMARK_OUTPUT).digest("hex"),
    usageSummary: { promptTokens: 300, completionTokens: 120 },
  });
  await db().insert(schema.benchmarkJudgments).values({
    benchmarkId, runId: insertId(bRun), judgeSlot: 1, kind: "rubric",
    rubricVersionRef: "rubric/v1", judgePromptVersion: "jp-v1", judgeModel: "judge-x",
    rationale: JUDGE_RATIONALE, status: "completed",
    rawAggregate: "8.5000", normalizedAggregate: "0.850000",
    dimensionScores: [{ dimension: "accuracy", rawScore: "8.5000", lowerBound: "0", upperBound: "10", weight: "1.0000" }],
  });
  await db().insert(schema.callAttempts).values({
    operationKind: "generation", operationId: insertId(bRun), benchmarkId,
    purpose: "private_evaluation", actorId: user.id, payerId: user.id, providerRefId: null,
    requestedModel: "model-x", returnedModel: "model-x", attemptIndex: 1, outcome: "success",
    promptTokens: 300, completionTokens: 120, estimatedCostUsd: "0.00120000",
    costBasis: "price_vector", costCompleteness: "complete",
  });
  return { benchmarkId, caseId: insertId(caseRow), runId: insertId(bRun) };
}

/** Rows in every never-swept table, so the before/after counts are non-zero. */
async function mkServerAuthoritativeRecords(user: schema.User, seller: schema.User, benchmarkId: number) {
  const [template] = await db().insert(schema.pipelineTemplates).values({
    userId: seller.id, name: `seller-template-${seller.id}`,
    steps: [{ name: "Draft", role: "builder", systemPrompt: SELLER_PROMPT }],
  });
  const templateId = insertId(template);
  const [listing] = await db().insert(schema.marketplaceListings).values({
    creatorId: seller.id, templateId, title: "Certified contract translator",
    price: "19.00", status: "published", category: "translation",
  });
  const listingId = insertId(listing);
  const [purchase] = await db().insert(schema.marketplacePurchases).values({
    buyerId: user.id, listingId, amountPaid: "19.00", platformFee: "4.75", creatorEarnings: "14.25",
    status: "active",
  });
  await db().insert(schema.executionGrants).values({
    subjectType: "user", subjectId: user.id, listingId, source: "purchase",
    sourceRef: `purchase:${insertId(purchase)}`, state: "active", policyVersion: "v2-p3-exec-1",
  });
  const [approval] = await db().insert(schema.spendApprovals).values({
    actorId: user.id, payerId: user.id, purpose: "private_evaluation",
    planHash: "b".repeat(64), planSnapshot: JSON.stringify({ calls: 1, frozen: true }),
    bindings: [{ providerId: 1, model: "model-x" }], policyVersion: "v2-consent-1",
    spendCeilingUsd: "5.00", status: "consumed",
  });
  const [version] = await db().insert(schema.pipelineVersions).values({
    ownerId: user.id, versionNumber: 1, definition: JSON.stringify({ schemaVersion: 1, steps: [] }),
    definitionHash: createHash("sha256").update("v1").digest("hex"),
    designerMethod: "manual",
  });
  await db().insert(schema.evidencePublications).values({
    authorId: user.id, benchmarkId, listingId, publicationKind: "seller",
    provenance: "platform_recorded", publicManifest: JSON.stringify({ claim: "8.5/10 on 1 case" }),
    manifestHash: createHash("sha256").update("manifest").digest("hex"),
    consentVersion: "v2-consent-1", state: "published", testedAt: new Date("2026-09-02T10:00:00Z"),
    publishedAt: new Date("2026-09-02T11:00:00Z"),
    listingWorkflowVersionId: insertId(version),
  });
  return { listingId, approvalId: insertId(approval), versionId: insertId(version) };
}

async function neverSweptCounts() {
  const [pv] = await db().select({ total: count() }).from(schema.pipelineVersions);
  const [ep] = await db().select({ total: count() }).from(schema.evidencePublications);
  const [mp] = await db().select({ total: count() }).from(schema.marketplacePurchases);
  const [eg] = await db().select({ total: count() }).from(schema.executionGrants);
  const [ca] = await db().select({ total: count() }).from(schema.callAttempts);
  const [sa] = await db().select({ total: count() }).from(schema.spendApprovals);
  const [up] = await db().select({ total: count() }).from(schema.userPrivacyConsent);
  const [ledger] = await db().select({
    usd: sql<string>`COALESCE(SUM(estimated_cost_usd), 0)`,
    tokens: sql<string>`COALESCE(SUM(prompt_tokens) + SUM(completion_tokens), 0)`,
  }).from(schema.callAttempts);
  return {
    pipeline_versions: Number(pv.total), evidence_publications: Number(ep.total),
    marketplace_purchases: Number(mp.total), execution_grants: Number(eg.total),
    call_attempts: Number(ca.total), spend_approvals: Number(sa.total),
    user_privacy_consent: Number(up.total),
    ledgerUsd: String(ledger.usd), ledgerTokens: String(ledger.tokens),
  };
}

/** Everything the platform stores about one run, as one string: used to prove
 *  both "the sweep really removed it" and "the refusal really did not print
 *  it". */
async function storedTextOf(swarmRunId: number): Promise<string> {
  const d = db();
  const [run] = await d.select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, swarmRunId));
  const steps = await d.select().from(schema.agentRuns).where(eq(schema.agentRuns.swarmRunId, swarmRunId));
  const responses = await d.select().from(schema.agentResponses).where(eq(schema.agentResponses.swarmRunId, swarmRunId));
  return JSON.stringify({ run, steps, responses });
}

type Caller = ReturnType<typeof appMod.appRouter.createCaller>;
function callerAs(user: schema.User): Caller {
  return appMod.appRouter.createCaller({
    req: new Request("http://localhost"), resHeaders: new Headers(),
    user, requestId: `delivery-${user.id}`,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any) as unknown as Caller;
}
type DeliveryProcedures = Caller["dataDelivery"];

/** An account with its own project, a finished run, a private benchmark, and
 *  the server-authoritative records that must survive everything. */
async function workFixture() {
  const owner = await mkUser("Work owner");
  const seller = await mkUser("Seller");
  const outsider = await mkUser("Outsider");
  const providerId = await mkProvider(owner.id, `owner-${owner.id}`);
  const [project] = await db().insert(schema.projects).values({ userId: owner.id, name: `Harvest work ${owner.id}` });
  const projectId = insertId(project);
  const run = await mkRunOwnedByProject(owner, projectId, providerId);
  const benchmark = await mkBenchmarkOwnedBy(owner, projectId);
  const records = await mkServerAuthoritativeRecords(owner, seller, benchmark.benchmarkId);
  return { owner, seller, outsider, providerId, projectId, ...run, ...benchmark, ...records };
}

/** A protected marketplace (buyer) run: created by direct inserts, with the
 *  run_params blob `marketplaceExecutionService` writes, because that is the
 *  only shape `runAccess.isProtectedRun` recognizes. */
async function protectedBuyerRunFixture() {
  const buyer = await mkUser("Buyer");
  const seller = await mkUser("Seller of the protected run");
  const [container] = await db().insert(schema.projects).values({
    userId: buyer.id, name: `Marketplace runs — seller ${seller.id}`,
  });
  const containerId = insertId(container);
  const [template] = await db().insert(schema.pipelineTemplates).values({
    userId: seller.id, name: `seller-method-${seller.id}`,
    steps: [{ name: "Draft", role: "builder", systemPrompt: SELLER_PROMPT }],
  });
  const [listing] = await db().insert(schema.marketplaceListings).values({
    creatorId: seller.id, templateId: insertId(template),
    title: "Protected seller pipeline", price: "12.00", status: "published",
  });
  const listingId = insertId(listing);
  const [run] = await db().insert(schema.swarmRuns).values({
    projectId: containerId, userId: buyer.id, userPrompt: "BUYER INPUT: translate my lease",
    status: "completed", currentStep: "done", pipelineVersion: "marketplace-v1",
    totalTokensUsed: 400, totalLatencyMs: 900,
    runParams: {
      source: "execute", prompt: "BUYER INPUT: translate my lease", stateless: true,
      snapshotVersionId: 1,
      protectedRun: {
        listingId, sellerId: seller.id, buyerId: buyer.id, workflowVersionId: 1,
        grantId: null, purchaseId: null, providerId: 1, purpose: "buyer_execution",
        endpoint: { url: "https://api.trusted.test/v1", method: "chat", allowedModels: ["m"], protectionClass: "protected" },
        policyVersion: "v2-p3-exec-1",
      },
    } as unknown as typeof schema.swarmRuns.$inferInsert.runParams,
  });
  const swarmRunId = insertId(run);
  const [agentRun] = await db().insert(schema.agentRuns).values({
    swarmRunId, projectId: containerId, agentName: "Seller draft", agentRole: "builder",
    pipelineStep: 1, userPrompt: "BUYER INPUT: translate my lease",
    systemPrompt: null, contextInput: null, status: "completed", tokensUsed: 400, latencyMs: 900,
  });
  const [resp] = await db().insert(schema.agentResponses).values({
    agentRunId: insertId(agentRun), swarmRunId, projectId: containerId, responseType: "final",
    content: `ECHO OF SELLER METHOD: ${SELLER_PROMPT} then BUYER INPUT: translate my lease`,
    metadata: {
      model: "seller-model", provider: "OpenAI", providerSlug: "openai",
      tokensUsed: { prompt: 250, completion: 150, total: 400 }, latencyMs: 900,
      temperature: 0.7, maxTokens: 4096, agentName: "Seller draft", agentRole: "builder",
      agentSlug: "seller-draft", pipelineStep: 1, iteration: 1, buildMethod: "llm", sourceResponseIds: [],
    },
  });
  await db().update(schema.swarmRuns).set({ finalResponseId: insertId(resp) })
    .where(eq(schema.swarmRuns.id, swarmRunId));
  // A run of the buyer's OWN, next to it, so "the sweep clears what was
  // delivered and nothing else" can be measured inside one account.
  const own = await mkRunOwnedByProject(buyer, containerId, 1);
  return { buyer, seller, containerId, protectedRunId: swarmRunId, ownRunId: own.swarmRunId, listingId };
}

/** A shared-pipeline run, created by the REAL sharing service with a no-op
 *  dispatcher, so the `sharedRun` context is exactly what production writes. */
async function sharedRunFixture(mode: "run_only" | "full") {
  const grantor = await mkUser(`Grantor ${mode}`);
  const grantee = await mkUser(`Grantee ${mode}`);
  const granteeProviderId = await mkProvider(grantee.id, `grantee-${mode}-${grantee.id}`);
  const [project] = await db().insert(schema.projects).values({ userId: grantor.id, name: `Lent pipeline ${mode} ${grantor.id}` });
  const projectId = insertId(project);
  await db().insert(schema.pipelineSteps).values({
    projectId, stepOrder: 1, stepType: "agent", name: "Draft", role: "builder",
    systemPrompt: GRANTOR_PROMPT, isEnabled: true, model: "grantor-model",
  });
  await share.sharePipeline(grantor.id, { projectId, granteeId: grantee.id, mode });
  const receipt = await share.startSharedRun({
    granteeId: grantee.id, projectId, input: "GRANTEE INPUT: translate clause 4",
    providerId: granteeProviderId, dispatch: async () => undefined,
  });
  const [run] = await db().select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, receipt.swarmRunId)).limit(1);
  const containerId = run.projectId;
  const [agentRun] = await db().insert(schema.agentRuns).values({
    swarmRunId: receipt.swarmRunId, projectId: containerId, agentName: "Draft", agentRole: "builder",
    pipelineStep: 1, userPrompt: "[prompt redacted for a protected run: 31 chars]",
    systemPrompt: null, contextInput: null, status: "completed", tokensUsed: 100, latencyMs: 10,
  });
  await db().insert(schema.agentResponses).values({
    agentRunId: insertId(agentRun), swarmRunId: receipt.swarmRunId, projectId: containerId,
    responseType: "final", content: `ECHO: ${GRANTOR_PROMPT}`,
    metadata: {
      model: "grantor-model", provider: "OpenAI", providerSlug: "openai",
      tokensUsed: { prompt: 60, completion: 40, total: 100 }, latencyMs: 10,
      temperature: 0.7, maxTokens: 4096, agentName: "Draft", agentRole: "builder",
      agentSlug: "draft", pipelineStep: 1, iteration: 1, buildMethod: "llm", sourceResponseIds: [],
    },
  });
  return { grantor, grantee, projectId, containerId, swarmRunId: receipt.swarmRunId, mode };
}

describe("D14 deliver-then-sweep (isolated localhost MySQL)", () => {
  it("delivers the caller's own work data as one hashed bundle, and a second delivery of unchanged data returns the SAME hash", async () => {
    const f = await workFixture();
    const first = await delivery.deliverWorkData(f.owner.id, { projectId: f.projectId });

    // The work itself is in the bundle: the run's input text and its outputs.
    const run = first.bundle.runs.find((r) => r.swarmRunId === f.swarmRunId);
    expect(run, "the caller's own run must be in the bundle").toBeDefined();
    expect(run?.userPrompt).toBe(OWNER_PROMPT);
    expect(run?.responses.map((r) => r.content)).toContain(OWNER_OUTPUT);
    expect(run?.responses.map((r) => r.content)).toContain(OWNER_FINAL);
    expect(run?.steps.map((s) => s.systemPrompt)).toContain(OWNER_STEP_PROMPT);
    expect(run?.steps.map((s) => s.contextInput)).toContain(OWNER_CONTEXT);
    expect(first.counts).toMatchObject({ swarm_runs: 1, agent_runs: 2, agent_responses: 3 });
    expect(first.bundle.benchmarks).toHaveLength(0); // project scope is runs only
    expect(first.bundle.excluded).toEqual([]);

    // "Hash what you hand over": the hash is recomputable from the bundle the
    // client is about to write, and nothing else.
    expect(first.bundleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update(canonicalJson(first.bundle)).digest("hex")).toBe(first.bundleHash);

    const second = await delivery.deliverWorkData(f.owner.id, { projectId: f.projectId });
    expect(second.bundleHash).toBe(first.bundleHash);
    expect(canonicalJson(second.bundle)).toBe(canonicalJson(first.bundle)); // the bytes do not change…
    // …while the receipt does: it records WHEN the copy was handed over.
    await new Promise((resolve) => setTimeout(resolve, 3));
    const third = await delivery.deliverWorkData(f.owner.id, { projectId: f.projectId });
    expect(third.bundleHash).toBe(first.bundleHash);
    expect(third.receipt).not.toBe(first.receipt);
    expect(third.deliveredAt).not.toBe(first.deliveredAt);

    // The account-wide bundle additionally carries the private benchmark body.
    const wide = await delivery.deliverWorkData(f.owner.id, { accountWide: true });
    const bm = wide.bundle.benchmarks.find((b) => b.benchmarkId === f.benchmarkId);
    expect(bm?.cases[0]?.inputText).toBe(CASE_INPUT);
    expect(bm?.cases[0]?.expectedOutput).toBe(CASE_EXPECTED);
    expect(bm?.cases[0]?.provenanceNotes).toBe(CASE_NOTES);
    expect(bm?.candidates[0]?.baselinePrompt).toBe(BASELINE_PROMPT);
    expect(bm?.runs[0]?.outputText).toBe(BENCHMARK_OUTPUT);
    expect(bm?.judgments[0]?.rationale).toBe(JUDGE_RATIONALE);
    // The notice that a published claim rests on this benchmark — without
    // quoting anything from the manifest itself.
    expect(bm?.linkedEvidencePublications).toBe(1);

    // And the same data through the mounted tRPC surface, so the web app and a
    // chat client get one answer.
    const viaRouter = await callerAs(f.owner).dataDelivery.deliver({ projectId: f.projectId });
    expect((viaRouter as Awaited<ReturnType<DeliveryProcedures["deliver"]>>).bundleHash).toBe(first.bundleHash);
  }, 60_000);

  it("sweeps the delivered content and keeps every row, id, number and hash — while the never-swept record does not move", async () => {
    const f = await workFixture();
    const delivered = await delivery.deliverWorkData(f.owner.id, { accountWide: true });
    expect(delivered.bundle.runs.some((r) => r.userPrompt === OWNER_PROMPT)).toBe(true);

    const before = await neverSweptCounts();
    // Non-vacuity first: an equality on 0 === 0 would prove nothing.
    expect(before.pipeline_versions).toBeGreaterThan(0);
    expect(before.evidence_publications).toBeGreaterThan(0);
    expect(before.marketplace_purchases).toBeGreaterThan(0);
    expect(before.execution_grants).toBeGreaterThan(0);
    expect(before.call_attempts).toBeGreaterThan(0);
    expect(before.spend_approvals).toBeGreaterThan(0);
    expect(before.user_privacy_consent).toBeGreaterThan(0);

    const [runBefore] = await db().select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, f.swarmRunId));
    const stepsBefore = await db().select().from(schema.agentRuns).where(eq(schema.agentRuns.swarmRunId, f.swarmRunId));
    const responsesBefore = await db().select().from(schema.agentResponses).where(eq(schema.agentResponses.swarmRunId, f.swarmRunId));
    expect(await storedTextOf(f.swarmRunId)).toContain(OWNER_OUTPUT);

    const receipt = await delivery.sweepDeliveredData(f.owner.id, {
      receipt: delivered.receipt, confirmation: delivery.SWEEP_CONFIRM_PHRASE,
    });

    // ── the content is gone ──
    const stored = await storedTextOf(f.swarmRunId);
    for (const secret of [OWNER_PROMPT, OWNER_STEP_PROMPT, OWNER_CONTEXT, OWNER_OUTPUT, OWNER_FINAL, OWNER_NOTES]) {
      expect(stored, `swept copy must not still hold ${secret.slice(0, 24)}…`).not.toContain(secret);
    }
    const [runAfter] = await db().select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, f.swarmRunId));
    expect(runAfter.userPrompt).toMatch(SWEEP_MARKER);
    expect(runAfter.executionState).toBeNull();
    expect(runAfter.error).toBeNull();
    const stepsAfter = await db().select().from(schema.agentRuns).where(eq(schema.agentRuns.swarmRunId, f.swarmRunId));
    for (const step of stepsAfter) {
      expect(step.systemPrompt).toBeNull();
      expect(step.contextInput).toBeNull();
      expect(step.userPrompt).toMatch(SWEEP_MARKER);
    }
    const responsesAfter = await db().select().from(schema.agentResponses).where(eq(schema.agentResponses.swarmRunId, f.swarmRunId));
    for (const resp of responsesAfter) {
      expect(resp.content).toMatch(SWEEP_MARKER);
      expect(resp.humanNotes).toBeNull();
    }
    const bmCases = await db().select().from(schema.benchmarkCases).where(eq(schema.benchmarkCases.benchmarkId, f.benchmarkId));
    expect(bmCases[0]).toMatchObject({ inputText: null, expectedOutput: null, provenanceNotes: null });
    const bmRuns = await db().select().from(schema.benchmarkRuns).where(eq(schema.benchmarkRuns.benchmarkId, f.benchmarkId));
    expect(bmRuns[0].outputText).toBeNull();
    const bmJudgments = await db().select().from(schema.benchmarkJudgments).where(eq(schema.benchmarkJudgments.benchmarkId, f.benchmarkId));
    expect(bmJudgments[0].rationale).toBeNull();
    const bmCandidates = await db().select().from(schema.benchmarkCandidates).where(eq(schema.benchmarkCandidates.benchmarkId, f.benchmarkId));
    expect(bmCandidates[0].baselinePrompt).toBeNull();

    // ── the verifiable residue is intact (design rule 4) ──
    expect(runAfter.id).toBe(runBefore.id);
    expect(runAfter.projectId).toBe(runBefore.projectId);
    expect(runAfter.userId).toBe(runBefore.userId);
    expect(runAfter.status).toBe(runBefore.status);
    expect(runAfter.totalTokensUsed).toBe(runBefore.totalTokensUsed);
    expect(runAfter.totalLatencyMs).toBe(runBefore.totalLatencyMs);
    expect(runAfter.startedAt).toEqual(runBefore.startedAt);
    expect(runAfter.completedAt).toEqual(runBefore.completedAt);
    expect(runAfter.finalResponseId).toBe(runBefore.finalResponseId);
    expect(runAfter.agentsUsed).toEqual(runBefore.agentsUsed);
    // run_params keeps existing, keeps its keys, and loses only the prompt copy.
    expect(Object.keys(runAfter.runParams ?? {}).sort()).toEqual(Object.keys(runBefore.runParams ?? {}).sort());
    expect((runAfter.runParams as { memoryMode?: string }).memoryMode).toBe("balanced");
    expect((runAfter.runParams as { prompt?: string }).prompt).toMatch(SWEEP_MARKER);
    expect(stepsAfter.map((s) => s.id)).toEqual(stepsBefore.map((s) => s.id));
    expect(stepsAfter.map((s) => [s.tokensUsed, s.latencyMs, s.modelUsed, s.providerUsed]))
      .toEqual(stepsBefore.map((s) => [s.tokensUsed, s.latencyMs, s.modelUsed, s.providerUsed]));
    expect(responsesAfter.map((r) => r.id)).toEqual(responsesBefore.map((r) => r.id));
    expect(responsesAfter.map((r) => r.metadata)).toEqual(responsesBefore.map((r) => r.metadata));
    expect(responsesAfter.map((r) => r.createdAt)).toEqual(responsesBefore.map((r) => r.createdAt));
    // The hashes that make a swept row still verifiable survive untouched.
    expect(bmCases[0].contentHash).toBe(createHash("sha256").update(CASE_INPUT).digest("hex"));
    expect(bmRuns[0].outputHash).toBe(createHash("sha256").update(BENCHMARK_OUTPUT).digest("hex"));

    // ── nothing was deleted, anywhere ──
    const after = await neverSweptCounts();
    expect(after).toEqual(before);
    expect(receipt.neverSwept.before).toEqual(receipt.neverSwept.after);
    expect(receipt.neverSwept.unchanged).toBe(true);
    expect(receipt.rowsDeleted).toBe(0);
    expect(receipt.rowCountsWithinSweptTables.unchanged).toBe(true);
    expect(receipt.ledger.unchanged).toBe(true);
    expect(receipt.bundleHash).toBe(delivered.bundleHash);
    // The receipt names what it removed.
    expect(Object.fromEntries(receipt.columnsSwept.map((c) => [`${c.table}.${c.column}`, c.rows]))).toMatchObject({
      "swarm_runs.user_prompt": 1, "swarm_runs.execution_state": 1, "swarm_runs.error": 1,
      "swarm_runs.run_params.prompt": 1, "agent_runs.system_prompt": 2, "agent_runs.user_prompt": 2,
      "agent_runs.context_input": 2, "agent_responses.content": 3, "agent_responses.human_notes": 3,
      "benchmark_cases.input_text": 1, "benchmark_cases.expected_output": 1,
      "benchmark_cases.provenance_notes": 1, "benchmark_candidates.baseline_prompt": 1,
      "benchmark_runs.output_text": 1, "benchmark_judgments.rationale": 1,
    });

    // ── a stale receipt cannot sweep again: what is on the server is no longer
    //    what that receipt delivered ──
    await expect(delivery.sweepDeliveredData(f.owner.id, {
      receipt: delivered.receipt, confirmation: delivery.SWEEP_CONFIRM_PHRASE,
    })).rejects.toThrow(/^bundle_changed:/);

    // Re-delivering after a sweep is stable too (the marker text is now the
    // content, and it does not shift between reads).
    const again = await delivery.deliverWorkData(f.owner.id, { accountWide: true });
    const onceMore = await delivery.deliverWorkData(f.owner.id, { accountWide: true });
    expect(again.bundleHash).toBe(onceMore.bundleHash);
    expect(again.bundleHash).not.toBe(delivered.bundleHash);
    // The ledger is still reconcilable to a run that happened, with numbers.
    const totals = await delivery.deliveredLedgerTotals(f.owner.id, f.benchmarkId);
    expect(totals.totalCalls).toBe(1);
    expect(totals.knownCostUsd).toBe("0.00120000");
  }, 60_000);

  it("delivers unique execution-state content and the stored prompt without exporting other run parameters", async () => {
    const f = await workFixture();
    const executionState = {
      currentIndex: 2, iterationCounts: { 1: 3 },
      chain: [{ id: f.extraResponseId, content: "state-only draft", agentRole: "builder", agentName: "Builder" }],
      modifyInstructions: "state-only modification instructions",
      pendingApproval: { stepOrder: 2, lastOutput: "state-only pending output", instructions: "state-only approval instructions" },
    };
    const runParams = {
      source: "execute" as const, prompt: "stored request prompt differs from userPrompt",
      memoryMode: "balanced", giteeTokenEnc: "fixture-only-encrypted-token",
      attachments: [{ type: "text" as const, name: "private.txt", content: "attachment bytes not delivered" }],
    };
    await db().update(schema.swarmRuns).set({ executionState, runParams }).where(eq(schema.swarmRuns.id, f.swarmRunId));
    const delivered = await delivery.deliverWorkData(f.owner.id, { swarmRunId: f.swarmRunId });
    expect(delivered.version).toBe(2);
    expect(delivered.bundle.version).toBe(2);
    expect(delivered.bundle.runs[0]).toMatchObject({ userPrompt: OWNER_PROMPT, executionState, runParamsPrompt: runParams.prompt });
    expect(createHash("sha256").update(canonicalJson(delivered.bundle)).digest("hex")).toBe(delivered.bundleHash);
    expect(JSON.stringify(delivered.bundle)).not.toContain(runParams.giteeTokenEnc);
    expect(JSON.stringify(delivered.bundle)).not.toContain("attachment bytes not delivered");
    await delivery.sweepDeliveredData(f.owner.id, { receipt: delivered.receipt, confirmation: delivery.SWEEP_CONFIRM_PHRASE });
    const [swept] = await db().select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, f.swarmRunId));
    expect(swept.executionState).toBeNull();
    expect(swept.runParams).toEqual({ ...runParams, prompt: expect.stringMatching(SWEEP_MARKER) });
  });

  it.each(["modifyInstructions", "pendingApproval", "runParamsPrompt"] as const)("refuses to erase %s changed since delivery", async (field) => {
    const f = await workFixture();
    const delivered = await delivery.deliverWorkData(f.owner.id, { swarmRunId: f.swarmRunId });
    const [run] = await db().select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, f.swarmRunId));
    if (field === "runParamsPrompt") {
      await db().update(schema.swarmRuns).set({ runParams: { ...run.runParams!, prompt: "undelivered stored prompt" } })
        .where(eq(schema.swarmRuns.id, f.swarmRunId));
    } else {
      const executionState = field === "modifyInstructions"
        ? { ...run.executionState!, modifyInstructions: "undelivered modification instructions" }
        : { ...run.executionState!, pendingApproval: { ...run.executionState!.pendingApproval!, instructions: "undelivered approval instructions" } };
      await db().update(schema.swarmRuns).set({ executionState }).where(eq(schema.swarmRuns.id, f.swarmRunId));
    }
    const changed = await storedTextOf(f.swarmRunId);
    await expect(delivery.sweepDeliveredData(f.owner.id, {
      receipt: delivered.receipt, confirmation: delivery.SWEEP_CONFIRM_PHRASE,
    })).rejects.toThrow(/^bundle_changed:/);
    expect(await storedTextOf(f.swarmRunId)).toBe(changed);
    const fresh = await delivery.deliverWorkData(f.owner.id, { swarmRunId: f.swarmRunId });
    expect(fresh.bundleHash).not.toBe(delivered.bundleHash);
    expect(JSON.stringify(fresh.bundle)).toContain("undelivered");
  });

  it("discloses retained private plans before and after sweeping through tRPC and MCP", async () => {
    const f = await workFixture();
    const plan = JSON.stringify({
      schemaVersion: 1, executionMode: "grade_only",
      cases: [{ stableCaseId: "case-1", inputText: CASE_INPUT, expectedOutput: CASE_EXPECTED, origin: "user" }],
      candidates: [{ stableCandidateId: "solo-1", strategy: "solo_baseline", baselinePrompt: BASELINE_PROMPT }],
    });
    await db().update(schema.benchmarks).set({ plan, spendApprovalId: f.approvalId }).where(eq(schema.benchmarks.id, f.benchmarkId));
    await db().update(schema.spendApprovals).set({ planSnapshot: plan }).where(eq(schema.spendApprovals.id, f.approvalId));
    const [approvalBefore] = await db().select().from(schema.spendApprovals).where(eq(schema.spendApprovals.id, f.approvalId));
    const [benchmarkBefore] = await db().select().from(schema.benchmarks).where(eq(schema.benchmarks.id, f.benchmarkId));
    const tools = await import("../mcp/tools/dataDeliveryTools");
    const context = { userId: f.owner.id, scopes: new Set(["mcp:read", "mcp:write"]), clientId: "delivery-test", requestId: "retention", locale: "en" as const };
    const scope = { benchmarkId: f.benchmarkId };
    const preview = await callerAs(f.owner).dataDelivery.preview(scope);
    const delivered = await callerAs(f.owner).dataDelivery.deliver(scope);
    const mcpPreview = await tools.previewDeliveryScopeTool.handler(scope, context);
    const mcpDelivered = await tools.deliverWorkDataTool.handler(scope, context);
    for (const result of [preview, delivered, mcpPreview, mcpDelivered]) {
      expect(result).toMatchObject({ retention: {
        completeErasure: false,
        notice: expect.stringMatching(/not complete erasure/),
        retainedColumns: expect.arrayContaining([
          { table: "benchmarks", column: "plan" },
          { table: "spend_approvals", column: "plan_snapshot" },
        ]),
      } });
    }
    expect(delivered.howToSweep.warning).toMatch(/case inputs, expected outputs, and baseline prompts/);
    expect(delivered.howToSweep.warning).not.toMatch(/only (one|copy)/);
    expect(JSON.stringify(preview)).not.toContain(CASE_INPUT);
    expect(JSON.stringify(mcpPreview)).not.toContain(BASELINE_PROMPT);
    const swept = await tools.sweepDeliveredWorkTool.handler({ receipt: delivered.receipt, confirmation: delivery.SWEEP_CONFIRM_PHRASE }, context);
    expect(swept).toMatchObject({
      retention: { completeErasure: false },
      meaning: expect.stringMatching(/not complete erasure/),
    });
    expect(JSON.stringify(swept)).not.toMatch(/server no longer holds|only copy/);
    const [approvalAfter] = await db().select().from(schema.spendApprovals).where(eq(schema.spendApprovals.id, f.approvalId));
    const [benchmarkAfter] = await db().select().from(schema.benchmarks).where(eq(schema.benchmarks.id, f.benchmarkId));
    expect(approvalAfter).toEqual(approvalBefore);
    expect(benchmarkAfter).toEqual(benchmarkBefore);
    expect(approvalAfter.planSnapshot).toBe(plan);
    expect(benchmarkAfter.plan).toBe(plan);
    const [kase] = await db().select().from(schema.benchmarkCases).where(eq(schema.benchmarkCases.id, f.caseId));
    expect(kase).toMatchObject({ inputText: null, expectedOutput: null });
    const newDelivery = await callerAs(f.owner).dataDelivery.deliver(scope);
    const routerSweep = await callerAs(f.owner).dataDelivery.sweep({ receipt: newDelivery.receipt, confirmation: delivery.SWEEP_CONFIRM_PHRASE });
    expect(routerSweep).toMatchObject({ retention: { completeErasure: false } });
  });

  it("refuses a correctly signed receipt from the incomplete version-one bundle", async () => {
    const f = await workFixture();
    const delivered = await delivery.deliverWorkData(f.owner.id, { swarmRunId: f.swarmRunId });
    const legacyBundle = JSON.parse(JSON.stringify(delivered.bundle));
    legacyBundle.version = 1;
    for (const run of legacyBundle.runs) {
      delete run.executionState;
      delete run.runParamsPrompt;
    }
    const [prefix, body] = delivered.receipt.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    payload.v = 1;
    payload.bundleHash = createHash("sha256").update(canonicalJson(legacyBundle)).digest("hex");
    const { env } = await import("../lib/env");
    const key = createHash("sha256").update(env.appSecret).digest();
    const signature = createHmac("sha256", key).update(canonicalJson(payload), "utf8").digest("hex");
    const legacyReceipt = `${prefix}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signature}`;
    const before = await storedTextOf(f.swarmRunId);
    await expect(delivery.sweepDeliveredData(f.owner.id, {
      receipt: legacyReceipt, confirmation: delivery.SWEEP_CONFIRM_PHRASE,
    })).rejects.toThrow(/^delivery_receipt_stale:/);
    expect(await storedTextOf(f.swarmRunId)).toBe(before);
  });

  it("preserves null run parameters and delivers null execution state", async () => {
    const f = await workFixture();
    const runParams = null;
    await db().update(schema.swarmRuns).set({ executionState: null, runParams }).where(eq(schema.swarmRuns.id, f.swarmRunId));
    const delivered = await delivery.deliverWorkData(f.owner.id, { swarmRunId: f.swarmRunId });
    expect(delivered.bundle.runs[0]).toMatchObject({ executionState: null, runParamsPrompt: null });
    await delivery.sweepDeliveredData(f.owner.id, { receipt: delivered.receipt, confirmation: delivery.SWEEP_CONFIRM_PHRASE });
    const [swept] = await db().select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, f.swarmRunId));
    expect(swept.runParams).toEqual(runParams);
  });

  it("refuses a sweep with no receipt, the wrong confirmation, or a forged receipt — and deletes nothing", async () => {
    const f = await workFixture();
    const delivered = await delivery.deliverWorkData(f.owner.id, { projectId: f.projectId });
    const beforeCopy = await storedTextOf(f.swarmRunId);
    const beforeCounts = await neverSweptCounts();

    await expect(delivery.sweepDeliveredData(f.owner.id, {}))
      .rejects.toThrow(/^delivery_receipt_required:/);
    await expect(delivery.sweepDeliveredData(f.owner.id, { receipt: "   ", confirmation: delivery.SWEEP_CONFIRM_PHRASE }))
      .rejects.toThrow(/^delivery_receipt_required:/);
    await expect(delivery.sweepDeliveredData(f.owner.id, { receipt: delivered.receipt }))
      .rejects.toThrow(/^sweep_confirmation_required:/);
    await expect(delivery.sweepDeliveredData(f.owner.id, { receipt: delivered.receipt, confirmation: "yes" }))
      .rejects.toThrow(/^sweep_confirmation_required:/);
    await expect(delivery.sweepDeliveredData(f.owner.id, {
      receipt: "not-a-receipt", confirmation: delivery.SWEEP_CONFIRM_PHRASE,
    })).rejects.toThrow(/^delivery_receipt_invalid:/);

    // A tampered receipt (the scope edited to cover someone else's project)
    // fails the signature, which is the whole point of signing it.
    const [head, body, sig] = delivered.receipt.split(".");
    const forged = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    forged.scope = { kind: "account" };
    forged.userId = f.outsider.id;
    const tampered = `${head}.${Buffer.from(JSON.stringify(forged), "utf8").toString("base64url")}.${sig}`;
    await expect(delivery.sweepDeliveredData(f.owner.id, {
      receipt: tampered, confirmation: delivery.SWEEP_CONFIRM_PHRASE,
    })).rejects.toThrow(/^delivery_receipt_invalid:/);
    await expect(delivery.sweepDeliveredData(f.outsider.id, {
      receipt: delivered.receipt, confirmation: delivery.SWEEP_CONFIRM_PHRASE,
    })).rejects.toThrow(/^delivery_receipt_invalid:/);

    // Every refusal wrote nothing.
    expect(await storedTextOf(f.swarmRunId)).toBe(beforeCopy);
    expect(await neverSweptCounts()).toEqual(beforeCounts);
    expect((await db().select({ total: count() }).from(schema.agentResponses)
      .where(eq(schema.agentResponses.swarmRunId, f.swarmRunId)))[0].total).toBe(3);
  }, 60_000);

  it("refuses a protected buyer run and a shared run, names the other account's interest, leaks nothing, and leaves them standing", async () => {
    const p = await protectedBuyerRunFixture();
    const delivered = await delivery.deliverWorkData(p.buyer.id, { projectId: p.containerId });

    // The buyer's own run is deliverable; the protected one is not.
    expect(delivered.bundle.runs.map((r) => r.swarmRunId)).toEqual([p.ownRunId]);
    expect(delivered.bundle.excluded).toHaveLength(1);
    expect(delivered.bundle.excluded[0]).toMatchObject({ swarmRunId: p.protectedRunId });
    expect(delivered.bundle.excluded[0].reason).toMatch(/another account|the seller/i);

    // Asking for THAT run directly is a refusal, not an empty bundle.
    await expect(delivery.deliverWorkData(p.buyer.id, { swarmRunId: p.protectedRunId }))
      .rejects.toThrow(/^protected_marketplace_run_not_sweepable:/);

    // The refusal and the exclusion say WHY without disclosing the seller's
    // method, the buyer's protected content, or anyone's account identity.
    const refusal = await delivery.deliverWorkData(p.buyer.id, { swarmRunId: p.protectedRunId })
      .then(() => null, (e: unknown) => (e as Error).message);
    expect(refusal).toContain("purchase");
    for (const secret of [SELLER_PROMPT, "translate my lease"]) {
      expect(refusal).not.toContain(secret);
      expect(JSON.stringify(delivered.bundle)).not.toContain(secret);
      expect(JSON.stringify(delivered.excluded)).not.toContain(secret);
    }
    // No ids at all in the refusal — not the seller's, not even the run's — and
    // the exclusion entry carries nothing beyond the caller's own run id, a
    // machine code and the human reason.
    expect(refusal).not.toMatch(/\d/);
    expect(Object.keys(delivered.bundle.excluded[0]).sort()).toEqual(["code", "reason", "swarmRunId"]);
    expect(delivered.bundle.excluded[0].reason).not.toMatch(/sellerId|ownerId|granteeId|buyerId|\d/);

    // Sweeping everything the buyer holds must leave the protected run exactly
    // as it was: never sweep what was not delivered.
    const protectedBefore = await storedTextOf(p.protectedRunId);
    const accountBundle = await delivery.deliverWorkData(p.buyer.id, { accountWide: true });
    expect(accountBundle.bundle.excluded.map((e) => e.swarmRunId)).toContain(p.protectedRunId);
    await delivery.sweepDeliveredData(p.buyer.id, {
      receipt: accountBundle.receipt, confirmation: delivery.SWEEP_CONFIRM_PHRASE,
    });
    expect(await storedTextOf(p.protectedRunId)).toBe(protectedBefore);
    expect((await storedTextOf(p.ownRunId))).toMatch(SWEEP_MARKER);

    // ── both share modes: run_only AND full ──
    for (const mode of ["run_only", "full"] as const) {
      const s = await sharedRunFixture(mode);
      await expect(delivery.deliverWorkData(s.grantee.id, { swarmRunId: s.swarmRunId }))
        .rejects.toThrow(/^shared_pipeline_run_not_sweepable:/);
      const container = await delivery.deliverWorkData(s.grantee.id, { projectId: s.containerId });
      expect(container.bundle.runs).toHaveLength(0);
      expect(container.bundle.excluded[0]).toMatchObject({ swarmRunId: s.swarmRunId });
      expect(container.bundle.excluded[0].reason).toMatch(/another account/i);
      // The grantor's method text appears nowhere the grantee can read here.
      expect(JSON.stringify(container)).not.toContain(GRANTOR_PROMPT);

      // The GRANTOR cannot reach the grantee's run either: it is not in the
      // grantor's account at all.
      const asGrantor = await delivery.deliverWorkData(s.grantor.id, { accountWide: true });
      expect(asGrantor.bundle.runs).toHaveLength(0);
      expect(JSON.stringify(asGrantor)).not.toContain("GRANTEE INPUT");

      const before = await storedTextOf(s.swarmRunId);
      const swept = await delivery.sweepDeliveredData(s.grantee.id, {
        receipt: container.receipt, confirmation: delivery.SWEEP_CONFIRM_PHRASE,
      });
      expect(swept.rowsSwept.swarm_runs).toBe(0);
      expect(await storedTextOf(s.swarmRunId)).toBe(before);
    }
  }, 60_000);

  it("gives a second account the same answer for work that is not theirs, and tells them nothing about whether it exists", async () => {
    const f = await workFixture();
    const mine = await delivery.deliverWorkData(f.owner.id, { projectId: f.projectId });
    expect(mine.bundle.runs).toHaveLength(1);

    // A project of theirs that simply does not exist answers identically to one
    // they do not own: "not visible", never "forbidden".
    await expect(delivery.deliverWorkData(f.outsider.id, { projectId: f.projectId }))
      .rejects.toThrow(/^not_found_or_not_authorized: project is not visible to this account$/);
    await expect(delivery.deliverWorkData(f.outsider.id, { projectId: 999_999 }))
      .rejects.toThrow(/^not_found_or_not_authorized: project is not visible to this account$/);
    await expect(delivery.deliverWorkData(f.outsider.id, { benchmarkId: f.benchmarkId }))
      .rejects.toThrow(/^not_found_or_not_authorized: benchmark is not visible to this account$/);

    // A run id they do not own resolves to nothing at all — and learns nothing.
    const probing = await delivery.deliverWorkData(f.outsider.id, { swarmRunId: f.swarmRunId });
    expect(probing.bundle.runs).toEqual([]);
    expect(probing.counts.swarm_runs).toBe(0);
    expect(probing.counts.agent_responses).toBe(0);
    const probeText = JSON.stringify(probing);
    for (const secret of [OWNER_PROMPT, OWNER_OUTPUT, OWNER_FINAL, OWNER_STEP_PROMPT, CASE_INPUT, JUDGE_RATIONALE]) {
      expect(probeText).not.toContain(secret);
    }
    // Their own empty account-wide bundle cannot contain it either.
    expect(JSON.stringify(await delivery.deliverWorkData(f.outsider.id, { accountWide: true })))
      .not.toContain(OWNER_PROMPT);

    // They cannot sweep it: not with their own scope (there is nothing to
    // sweep), and not by replaying the owner's receipt.
    const outsiderBundle = await delivery.deliverWorkData(f.outsider.id, { accountWide: true });
    await expect(delivery.sweepDeliveredData(f.outsider.id, {
      receipt: outsiderBundle.receipt, confirmation: delivery.SWEEP_CONFIRM_PHRASE,
    })).resolves.toMatchObject({ rowsSwept: { swarm_runs: 0 }, rowsDeleted: 0 });
    await expect(delivery.sweepDeliveredData(f.outsider.id, {
      receipt: mine.receipt, confirmation: delivery.SWEEP_CONFIRM_PHRASE,
    })).rejects.toThrow(/^delivery_receipt_invalid: this receipt was not issued to your account$/);
    expect(await storedTextOf(f.swarmRunId)).toContain(OWNER_OUTPUT);

    // A sweep is not a way to reach another account's rows by id either: the
    // outsider owns no project at all, so there is nothing for their receipt to
    // name, and the owner's data is still there verbatim.
    const outsiderProjects = await db().select({ id: schema.projects.id })
      .from(schema.projects).where(eq(schema.projects.userId, f.outsider.id));
    expect(outsiderProjects).toEqual([]);
    expect(await storedTextOf(f.swarmRunId)).toContain(OWNER_OUTPUT);
  }, 60_000);

  it.each(["pending", "running", "cancelled"] as const)("refuses a sweep while a run is %s", async (status) => {
    const f = await workFixture();
    await db().update(schema.swarmRuns).set({ status }).where(eq(schema.swarmRuns.id, f.swarmRunId));
    const delivered = await delivery.deliverWorkData(f.owner.id, { projectId: f.projectId });
    const before = await storedTextOf(f.swarmRunId);
    await expect(delivery.sweepDeliveredData(f.owner.id, {
      receipt: delivered.receipt, confirmation: delivery.SWEEP_CONFIRM_PHRASE,
    })).rejects.toThrow(/^work_in_progress:/);
    expect(await storedTextOf(f.swarmRunId)).toBe(before);
  });

  it("refuses active child work even if its parent is terminal", async () => {
    const f = await workFixture();
    await db().update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, f.stepRows[0]));
    const delivered = await delivery.deliverWorkData(f.owner.id, { swarmRunId: f.swarmRunId });
    const before = await storedTextOf(f.swarmRunId);
    await expect(delivery.sweepDeliveredData(f.owner.id, {
      receipt: delivered.receipt, confirmation: delivery.SWEEP_CONFIRM_PHRASE,
    })).rejects.toThrow(/^work_in_progress:/);
    expect(await storedTextOf(f.swarmRunId)).toBe(before);
  });

  it.each(["draft", "queued", "running"] as const)("refuses a sweep while a benchmark is %s", async (state) => {
    const f = await workFixture();
    await db().update(schema.benchmarks).set({ state }).where(eq(schema.benchmarks.id, f.benchmarkId));
    const delivered = await delivery.deliverWorkData(f.owner.id, { accountWide: true });
    const before = await storedTextOf(f.swarmRunId);
    await expect(delivery.sweepDeliveredData(f.owner.id, {
      receipt: delivered.receipt, confirmation: delivery.SWEEP_CONFIRM_PHRASE,
    })).rejects.toThrow(/^work_in_progress:/);
    expect(await storedTextOf(f.swarmRunId)).toBe(before);
    const [kase] = await db().select().from(schema.benchmarkCases).where(eq(schema.benchmarkCases.id, f.caseId));
    expect(kase.inputText).toBe(CASE_INPUT);
  });

  it.each(["linkedRun", "callPlan"] as const)("refuses a completed run whose %s benchmark is still consuming it", async (link) => {
    const f = await workFixture();
    await db().update(schema.benchmarks).set({ state: "running", leaseToken: "active-worker" })
      .where(eq(schema.benchmarks.id, f.benchmarkId));
    if (link === "linkedRun") {
      await db().update(schema.benchmarkRuns).set({ linkedSwarmRunId: f.swarmRunId })
        .where(eq(schema.benchmarkRuns.id, f.runId));
    } else {
      await db().update(schema.swarmRuns).set({ runParams: { source: "execute", prompt: OWNER_PROMPT, callPlanId: f.benchmarkId } })
        .where(eq(schema.swarmRuns.id, f.swarmRunId));
    }
    const delivered = await delivery.deliverWorkData(f.owner.id, { swarmRunId: f.swarmRunId });
    const before = await storedTextOf(f.swarmRunId);
    await expect(delivery.sweepDeliveredData(f.owner.id, {
      receipt: delivered.receipt, confirmation: delivery.SWEEP_CONFIRM_PHRASE,
    })).rejects.toThrow(/^work_in_progress:/);
    expect(await storedTextOf(f.swarmRunId)).toBe(before);
  });

  it.each(["lease", "child", "judgment"] as const)("refuses a terminal benchmark with outstanding %s work", async (kind) => {
    const f = await workFixture();
    if (kind === "lease") {
      await db().update(schema.benchmarks).set({ leaseToken: "active-worker" }).where(eq(schema.benchmarks.id, f.benchmarkId));
    } else if (kind === "child") {
      await db().update(schema.benchmarkRuns).set({ status: "running" }).where(eq(schema.benchmarkRuns.id, f.runId));
    } else {
      await db().update(schema.benchmarkJudgments).set({ status: "pending" }).where(eq(schema.benchmarkJudgments.benchmarkId, f.benchmarkId));
    }
    const delivered = await delivery.deliverWorkData(f.owner.id, { benchmarkId: f.benchmarkId });
    await expect(delivery.sweepDeliveredData(f.owner.id, {
      receipt: delivered.receipt, confirmation: delivery.SWEEP_CONFIRM_PHRASE,
    })).rejects.toThrow(/^work_in_progress:/);
    const [kase] = await db().select().from(schema.benchmarkCases).where(eq(schema.benchmarkCases.id, f.caseId));
    expect(kase.inputText).toBe(CASE_INPUT);
  });

  it.each(["run", "response", "benchmark"] as const)("preserves a %s edit committed just before the sweep transaction", async (kind) => {
    const f = await workFixture();
    const delivered = await delivery.deliverWorkData(f.owner.id, { accountWide: true });
    const original = db().transaction.bind(db());
    const transaction = vi.spyOn(db(), "transaction").mockImplementationOnce(async (callback, config) => {
      if (kind === "run") {
        await db().update(schema.swarmRuns).set({ userPrompt: "new undelivered input" })
          .where(eq(schema.swarmRuns.id, f.swarmRunId));
      } else if (kind === "response") {
        await db().update(schema.agentResponses).set({ humanNotes: "new undelivered notes" })
          .where(eq(schema.agentResponses.id, f.extraResponseId));
      } else {
        await db().update(schema.benchmarkCases).set({ inputText: "new undelivered case" })
          .where(eq(schema.benchmarkCases.id, f.caseId));
      }
      return original(callback, config);
    });
    try {
      await expect(delivery.sweepDeliveredData(f.owner.id, {
        receipt: delivered.receipt, confirmation: delivery.SWEEP_CONFIRM_PHRASE,
      })).rejects.toThrow(/^bundle_changed:/);
      expect(transaction).toHaveBeenCalledOnce();
    } finally {
      transaction.mockRestore();
    }
    const [run] = await db().select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, f.swarmRunId));
    const [response] = await db().select().from(schema.agentResponses).where(eq(schema.agentResponses.id, f.extraResponseId));
    const [kase] = await db().select().from(schema.benchmarkCases).where(eq(schema.benchmarkCases.id, f.caseId));
    expect(run.userPrompt).toBe(kind === "run" ? "new undelivered input" : OWNER_PROMPT);
    expect(response.humanNotes).toBe(kind === "response" ? "new undelivered notes" : null);
    expect(kase.inputText).toBe(kind === "benchmark" ? "new undelivered case" : CASE_INPUT);
    expect(response.content).toContain(OWNER_OUTPUT);
  });

  it("holds read locks against another connection before the first clearing write", async () => {
    const f = await workFixture();
    const delivered = await delivery.deliverWorkData(f.owner.id, { accountWide: true });
    const editor = await pool!.getConnection();
    await editor.query("SET SESSION innodb_lock_wait_timeout = 1");
    const original = db().transaction.bind(db());
    let probes = 0;
    const transaction = vi.spyOn(db(), "transaction").mockImplementationOnce((callback, config) =>
      original(async (tx) => {
        const update = tx.update.bind(tx);
        vi.spyOn(tx, "update").mockImplementationOnce((table) => {
          const builder = update(table);
          const set = builder.set.bind(builder);
          vi.spyOn(builder, "set").mockImplementationOnce((values) => {
            const query = set(values);
            const execute = query.execute.bind(query);
            vi.spyOn(query, "execute").mockImplementationOnce(async (...args) => {
              for (const [statement, params] of [
                ["UPDATE swarm_runs SET user_prompt = ? WHERE id = ?", ["concurrent input", f.swarmRunId]],
                ["UPDATE agent_responses SET human_notes = ? WHERE id = ?", ["concurrent notes", f.extraResponseId]],
                ["UPDATE benchmark_cases SET input_text = ? WHERE id = ?", ["concurrent case", f.caseId]],
                ["INSERT INTO benchmark_cases (benchmark_id, stable_case_id, case_order, input_text, content_hash, origin) VALUES (?, ?, ?, ?, ?, ?)",
                  [f.benchmarkId, "concurrent-case", 2, "undelivered case", "c".repeat(64), "user"]],
              ] as const) {
                await expect(editor.query(statement, [...params])).rejects.toMatchObject({ code: "ER_LOCK_WAIT_TIMEOUT" });
                probes++;
              }
              return execute(...args);
            });
            return query;
          });
          return builder;
        });
        return callback(tx);
      }, config));
    try {
      await delivery.sweepDeliveredData(f.owner.id, {
        receipt: delivered.receipt, confirmation: delivery.SWEEP_CONFIRM_PHRASE,
      });
      expect(probes).toBe(4);
      await editor.query("UPDATE agent_responses SET human_notes = ? WHERE id = ?", ["notes after commit", f.extraResponseId]);
      const [response] = await db().select().from(schema.agentResponses).where(eq(schema.agentResponses.id, f.extraResponseId));
      expect(response.humanNotes).toBe("notes after commit");
    } finally {
      transaction.mockRestore();
      await editor.query("SET SESSION innodb_lock_wait_timeout = DEFAULT");
      editor.release();
    }
  }, 30_000);

  it("rolls back every clearing write when the transaction fails", async () => {
    const f = await workFixture();
    const delivered = await delivery.deliverWorkData(f.owner.id, { accountWide: true });
    const before = await storedTextOf(f.swarmRunId);
    const original = db().transaction.bind(db());
    const transaction = vi.spyOn(db(), "transaction").mockImplementationOnce((callback, config) =>
      original(async (tx) => {
        await callback(tx);
        throw new Error("injected transaction failure");
      }, config));
    try {
      await expect(delivery.sweepDeliveredData(f.owner.id, {
        receipt: delivered.receipt, confirmation: delivery.SWEEP_CONFIRM_PHRASE,
      })).rejects.toThrow("injected transaction failure");
    } finally {
      transaction.mockRestore();
    }
    expect(await storedTextOf(f.swarmRunId)).toBe(before);
    expect((await delivery.deliverWorkData(f.owner.id, { accountWide: true })).bundleHash).toBe(delivered.bundleHash);
  });

  it("allows only one concurrent sweep of the same delivered content", async () => {
    const f = await workFixture();
    const delivered = await delivery.deliverWorkData(f.owner.id, { accountWide: true });
    const original = db().transaction.bind(db());
    let entered = 0;
    let release!: () => void;
    const bothEntered = new Promise<void>((resolve) => { release = resolve; });
    const transaction = vi.spyOn(db(), "transaction").mockImplementation(async (callback, config) => {
      if (++entered === 2) release();
      await bothEntered;
      return original(callback, config);
    });
    try {
      const input = { receipt: delivered.receipt, confirmation: delivery.SWEEP_CONFIRM_PHRASE };
      const results = await Promise.allSettled([
        delivery.sweepDeliveredData(f.owner.id, input), delivery.sweepDeliveredData(f.owner.id, input),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const failures = results.filter((r) => r.status === "rejected");
      expect(failures).toHaveLength(1);
      expect((failures[0] as PromiseRejectedResult).reason.message).toMatch(/^bundle_changed:/);
    } finally {
      transaction.mockRestore();
    }
  });

  it("serves both calls through the mounted tRPC router, with the same answers as the service", async () => {
    const f = await workFixture();
    const procedures = callerAs(f.owner).dataDelivery;
    const delivered = await procedures.deliver({ projectId: f.projectId });
    expect(delivered.bundle.runs[0].userPrompt).toBe(OWNER_PROMPT);
    const preview = await procedures.preview({ projectId: f.projectId });
    expect(preview.bundleHash).toBe(delivered.bundleHash);
    expect(preview.counts.swarm_runs).toBe(1);

    const swept = await procedures.sweep({ receipt: delivered.receipt, confirmation: delivery.SWEEP_CONFIRM_PHRASE });
    expect(swept.rowsSwept).toMatchObject({ swarm_runs: 1, agent_runs: 2, agent_responses: 3 });
    expect(swept.ledger.unchanged).toBe(true);
    expect(await storedTextOf(f.swarmRunId)).toMatch(SWEEP_MARKER);

    // Refusals come back as tRPC errors on the wire, with the same code first.
    const asOutsider = callerAs(f.outsider).dataDelivery;
    await expect(asOutsider.deliver({ projectId: f.projectId }))
      .rejects.toThrow(/not_found_or_not_authorized/);
    await expect(asOutsider.sweep({ receipt: delivered.receipt, confirmation: delivery.SWEEP_CONFIRM_PHRASE }))
      .rejects.toThrow(/delivery_receipt_invalid/);
  }, 60_000);
});
