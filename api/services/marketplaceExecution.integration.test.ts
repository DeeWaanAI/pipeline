// DB-backed protected-execution drill (offering redesign v2, spec §8.1–§8.3;
// acceptance A12/A13/A14). Own throwaway schema (`swarm_v2test_execprot`) so it
// cannot collide with the other parallel integration files.
//
// No LLM call is made: dispatch is stubbed. What is exercised for real is
// entitlement resolution, the trusted-endpoint policy, the buyer-owned run
// container, the authorized snapshot loader, and the buyer-visible projection.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { and, eq, inArray } from "drizzle-orm";

const TEST_DB = "swarm_v2test_execprot";
const ROOT_MYSQL = process.env.MYSQL_ROOT_URL || "mysql://root:rootpass@localhost:3307";
const SELLER_PROMPT = "SELLER SECRET SYSTEM PROMPT: use the client's /vault folder and the key sk-SELLERKEY123456789";

let ex: typeof import("./marketplaceExecutionService");
let schema: typeof import("@db/schema");
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
  const { execFileSync } = await import("node:child_process");
  execFileSync("npx", ["drizzle-kit", "push", "--force"], {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL }, stdio: "ignore", timeout: 150_000,
  });
  ex = await import("./marketplaceExecutionService");
  schema = await import("@db/schema");
}, 300_000);

afterAll(async () => {
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.query(`REVOKE ALL PRIVILEGES ON \`${TEST_DB}\`.* FROM 'swarm'@'%'`);
    await admin.end();
  }
});

async function db() {
  return (await import("../queries/connection")).getDb();
}

async function setFlag(key: string, enabled: boolean) {
  const d = await db();
  const [existing] = await d.select({ id: schema.featureFlags.id }).from(schema.featureFlags)
    .where(eq(schema.featureFlags.key, key)).limit(1);
  if (existing) await d.update(schema.featureFlags).set({ enabled }).where(eq(schema.featureFlags.id, existing.id));
  else await d.insert(schema.featureFlags).values({ key, name: key, description: "test", enabled, rolloutPercent: 0 });
  (await import("../plugins/featureFlags")).resetFlagCache();
}

const APPROVED_URL = "https://api.example-provider.com/v1";

/** Seller with a published v2 listing whose current version is `versionId`,
 *  and a buyer who owns a provider and an approved endpoint. */
async function seed(args: { entitled?: boolean; approvedEndpoint?: boolean } = {}) {
  const d = await db();
  const stamp = `${Date.now()}-${Math.random()}`;
  const [seller] = await d.insert(schema.users).values({ name: "Seller", email: `s-${stamp}@example.test`, tier: "pro_auto" });
  const sellerId = Number((seller as { insertId: number }).insertId);
  const [buyer] = await d.insert(schema.users).values({ name: "Buyer", email: `b-${stamp}@example.test`, tier: "standard" });
  const buyerId = Number((buyer as { insertId: number }).insertId);

  const [proj] = await d.insert(schema.projects).values({ userId: sellerId, name: "Seller Pipeline" });
  const sellerProjectId = Number((proj as { insertId: number }).insertId);
  const [sellerProv] = await d.insert(schema.llmProviders).values({
    userId: sellerId, name: `seller-${stamp}`, slug: "openai", baseUrl: APPROVED_URL,
    apiKeyRef: "seller-ciphertext", defaultModel: "seller-model",
  });
  const sellerProviderId = Number((sellerProv as { insertId: number }).insertId);

  const [ver] = await d.insert(schema.pipelineVersions).values({
    ownerId: sellerId, sourceProjectId: sellerProjectId, versionNumber: 1,
    definition: JSON.stringify({
      steps: [
        { stepOrder: 1, name: "Draft", role: "builder", systemPrompt: SELLER_PROMPT, providerId: sellerProviderId, model: "seller-model", temperature: "0.7", maxTokens: 1024, stepType: "agent", ifConfig: null, whileConfig: null },
        { stepOrder: 2, name: "Polish", role: "polisher", systemPrompt: "polish it quietly", providerId: sellerProviderId, model: "seller-model", temperature: "0.7", maxTokens: 1024, stepType: "agent", ifConfig: null, whileConfig: null },
      ],
      sourceAgentIds: [],
    }),
    definitionHash: "a".repeat(64),
  });
  const versionId = Number((ver as { insertId: number }).insertId);

  const [tpl] = await d.insert(schema.pipelineTemplates).values({
    userId: sellerId, name: `tpl-${stamp}`, steps: [{ name: "Draft", role: "builder", systemPrompt: SELLER_PROMPT }], sourceProjectId: sellerProjectId,
  });
  const [listing] = await d.insert(schema.marketplaceListings).values({
    creatorId: sellerId, templateId: Number((tpl as { insertId: number }).insertId),
    title: "Contract Redliner", price: "4.99", status: "published",
  });
  const listingId = Number((listing as { insertId: number }).insertId);
  await d.insert(schema.marketplaceListingV2).values({
    listingId, publicationMode: "v2", currentWorkflowVersionId: versionId, evidenceSummaryRevision: 1,
  });

  const [buyerProv] = await d.insert(schema.llmProviders).values({
    userId: buyerId, name: `buyer-${stamp}`, slug: "openai", baseUrl: APPROVED_URL,
    apiKeyRef: "buyer-ciphertext", defaultModel: "buyer-model",
  });
  const buyerProviderId = Number((buyerProv as { insertId: number }).insertId);

  if (args.approvedEndpoint !== false) {
    // (provider, baseUrl) is unique — approve the destination once for the run.
    const already = await d.select({ id: schema.trustedProviderEndpoints.id }).from(schema.trustedProviderEndpoints)
      .where(and(eq(schema.trustedProviderEndpoints.provider, "openai"), eq(schema.trustedProviderEndpoints.baseUrl, APPROVED_URL)))
      .limit(1);
    if (!already.length) {
      await d.insert(schema.trustedProviderEndpoints).values({
        provider: "openai", baseUrl: APPROVED_URL, adapterKind: "openai_compatible",
        endpointClass: "first_party", loggingDisclosure: "Provider retains request logs for the credential owner.",
        protectionClass: "standard", approvedBy: sellerId, policyVersion: "test-1", enabled: true,
      });
    }
  }
  if (args.entitled !== false) {
    await d.insert(schema.marketplacePurchases).values({
      buyerId, listingId, amountPaid: "4.99", platformFee: "1.50", creatorEarnings: "3.49", status: "active",
    });
  }
  await setFlag("v2ProtectedExecution", true);
  return { sellerId, buyerId, sellerProjectId, sellerProviderId, versionId, listingId, buyerProviderId };
}

const start = async (f: Awaited<ReturnType<typeof seed>>, over: Record<string, unknown> = {}) =>
  ex.startProtectedRun({
    buyerId: f.buyerId, listingId: f.listingId, input: "Translate clause 4.",
    providerId: f.buyerProviderId, dispatch: async () => {}, ...over,
  });

describe("protected marketplace execution (DB-backed)", () => {
  it("runs the seller's published version for an entitled buyer without exposing its definition", async () => {
    const f = await seed();
    const receipt = await start(f);
    expect(receipt.swarmRunId).toBeGreaterThan(0);
    expect(receipt.protectionClass).toBe("standard");
    expect(receipt.loggingDisclosure).toContain("retains request logs");
    expect(receipt.residualRisks.join(" ")).toContain("Prompts necessarily leave");

    const d = await db();
    const [run] = await d.select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, receipt.swarmRunId)).limit(1);
    expect(run.userId).toBe(f.buyerId);
    const params = run.runParams as { snapshotVersionId?: number; protectedRun?: Record<string, unknown>; stateless?: boolean };
    expect(params.snapshotVersionId).toBe(f.versionId);
    expect(params.stateless).toBe(true);
    // §8.1: nothing was copied into a buyer-owned definition-bearing row.
    const [container] = await d.select().from(schema.projects).where(eq(schema.projects.id, run.projectId)).limit(1);
    expect(container.userId).toBe(f.buyerId);
    expect(container.name).toContain("Marketplace runs");
    const copiedSteps = await d.select({ id: schema.pipelineSteps.id }).from(schema.pipelineSteps)
      .where(eq(schema.pipelineSteps.projectId, container.id));
    const copiedTemplates = await d.select({ id: schema.pipelineTemplates.id }).from(schema.pipelineTemplates)
      .where(eq(schema.pipelineTemplates.userId, f.buyerId));
    expect(copiedSteps).toHaveLength(0);
    expect(copiedTemplates).toHaveLength(0);

    // The authorized loader: buyer-pinned provider, no seller agent refs.
    const loaded = await ex.loadAuthorizedSnapshotSteps({
      runRow: run, callerId: f.buyerId, params: params.protectedRun as never, versionId: f.versionId,
    });
    expect(loaded.steps).toHaveLength(2);
    expect(loaded.steps.every((s) => s.providerId === f.buyerProviderId)).toBe(true);
    expect(loaded.steps.every((s) => s.agentId === null)).toBe(true);
    // The seller's own provider is never the billable route (A14).
    expect(loaded.steps.some((s) => s.providerId === f.sellerProviderId)).toBe(false);
  });

  it("refuses before anything is queued when the endpoint is not approved, or the buyer is not entitled", async () => {
    const d = await db();
    // An unapproved (but public, https) destination: the allowlist row for
    // APPROVED_URL exists from other cases, so the refusal must come from the
    // URL itself not being listed.
    const unapproved = await seed();
    await d.update(schema.llmProviders).set({ baseUrl: "https://some-aggregator.example/v1" })
      .where(eq(schema.llmProviders.id, unapproved.buyerProviderId));
    await expect(start(unapproved)).rejects.toThrow(/endpoint_not_approved/);
    expect(await d.select({ id: schema.swarmRuns.id }).from(schema.swarmRuns)
      .where(eq(schema.swarmRuns.userId, unapproved.buyerId))).toHaveLength(0);

    const notEntitled = await seed({ entitled: false });
    await expect(start(notEntitled)).rejects.toThrow(/not_entitled/);
    // §8.3: both refusals happened BEFORE the run row existed, so nothing queued.
    expect(await d.select({ id: schema.swarmRuns.id }).from(schema.swarmRuns)
      .where(eq(schema.swarmRuns.userId, notEntitled.buyerId))).toHaveLength(0);
  });

  it("refuses a buyer endpoint that points at a private or non-https destination (A13)", async () => {
    const f = await seed();
    const d = await db();
    for (const baseUrl of ["http://api.example-provider.com/v1", "https://169.254.169.254/latest/meta-data"]) {
      await d.update(schema.llmProviders).set({ baseUrl }).where(eq(schema.llmProviders.id, f.buyerProviderId));
      await expect(start(f)).rejects.toThrow(/insecure_transport|blocked_destination/);
    }
  });

  it("a revoked right stops the run at dispatch, and cannot be replayed from run_params", async () => {
    const f = await seed();
    const receipt = await start(f);
    const d = await db();
    const [run] = await d.select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, receipt.swarmRunId)).limit(1);
    const params = run.runParams as { protectedRun: Record<string, unknown> };

    await d.delete(schema.marketplacePurchases).where(and(
      eq(schema.marketplacePurchases.buyerId, f.buyerId), eq(schema.marketplacePurchases.listingId, f.listingId),
    ));
    await expect(ex.loadAuthorizedSnapshotSteps({
      runRow: run, callerId: f.buyerId, params: params.protectedRun as never, versionId: f.versionId,
    })).rejects.toThrow(/not_entitled/);

    // A different user's caller id never resolves, even with the blob.
    const [other] = await d.insert(schema.users).values({ name: "Other", email: `o-${Date.now()}@example.test`, tier: "standard" });
    await expect(ex.loadAuthorizedSnapshotSteps({
      runRow: run, callerId: Number((other as { insertId: number }).insertId),
      params: params.protectedRun as never, versionId: f.versionId,
    })).rejects.toThrow(/not_found_or_not_authorized/);
  });

  it("a right bound to an older version cannot run the new one, and cannot inherit its evidence (A11)", async () => {
    const f = await seed();
    const d = await db();
    // The seller publishes a new version + its own evidence (the only way the
    // boundary moves the pointer), so the listing now sells version 2.
    const [v2] = await d.insert(schema.pipelineVersions).values({
      ownerId: f.sellerId, sourceProjectId: f.sellerProjectId, versionNumber: 2,
      definition: JSON.stringify({ steps: [], sourceAgentIds: [] }), definitionHash: "b".repeat(64),
    });
    const v2Id = Number((v2 as { insertId: number }).insertId);
    await d.update(schema.marketplaceListingV2).set({ currentWorkflowVersionId: v2Id, evidenceSummaryRevision: 2 })
      .where(eq(schema.marketplaceListingV2.listingId, f.listingId));
    await d.insert(schema.executionGrants).values({
      subjectType: "user", subjectId: f.buyerId, listingId: f.listingId,
      workflowVersionId: f.versionId, source: "purchase", state: "active",
    });
    const retained = await start(f);
    const [retainedRun] = await d.select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, retained.swarmRunId)).limit(1);
    expect((retainedRun.runParams as { snapshotVersionId: number }).snapshotVersionId).toBe(f.versionId);

    // Unversioned legacy purchases keep their existing current-version behavior.
    await d.delete(schema.executionGrants).where(eq(schema.executionGrants.subjectId, f.buyerId));
    const receipt = await start(f);
    const [run] = await d.select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, receipt.swarmRunId)).limit(1);
    expect((run.runParams as { snapshotVersionId: number }).snapshotVersionId).toBe(v2Id);
  });

  it("delisting and replacement preserve purchased versions, but not refunded or expired rights", async () => {
    const f = await seed();
    const d = await db();
    await d.update(schema.marketplacePurchases).set({ workflowVersionId: f.versionId })
      .where(eq(schema.marketplacePurchases.listingId, f.listingId));
    const queued = await start(f);
    const [replacement] = await d.insert(schema.pipelineVersions).values({
      ownerId: f.sellerId, sourceProjectId: f.sellerProjectId, versionNumber: 2,
      definition: JSON.stringify({ steps: [], sourceAgentIds: [] }), definitionHash: "d".repeat(64),
    });
    const replacementId = Number((replacement as { insertId: number }).insertId);
    await d.update(schema.marketplaceListingV2).set({ currentWorkflowVersionId: replacementId })
      .where(eq(schema.marketplaceListingV2.listingId, f.listingId));
    await d.update(schema.marketplaceListings).set({ status: "unpublished" }).where(eq(schema.marketplaceListings.id, f.listingId));
    const right = await ex.resolveProtectedExecutionRight({ buyerId: f.buyerId, listingId: f.listingId, purpose: "buyer_execution" });
    expect(right.soldVersionId).toBe(f.versionId);
    expect(right.versionBinding).toBe("purchase_receipt");
    await expect(start(f)).resolves.toHaveProperty("swarmRunId");
    const [run] = await d.select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, queued.swarmRunId));
    const params = (run.runParams as { protectedRun: import("./marketplaceExecutionService").ProtectedRunParams }).protectedRun;
    const loaded = await ex.loadAuthorizedSnapshotSteps({ runRow: run, callerId: f.buyerId, params, versionId: f.versionId });
    expect(loaded.steps).toHaveLength(2);
    await expect(ex.resolveProtectedExecutionRight({ buyerId: f.buyerId, listingId: f.listingId, purpose: "buyer_execution", workflowVersionId: replacementId }))
      .rejects.toThrow(/not_entitled/);
    await expect(start(f, { buyerId: f.sellerId })).rejects.toThrow(/not_entitled/);
    await d.update(schema.marketplacePurchases).set({ status: "refunded" }).where(eq(schema.marketplacePurchases.listingId, f.listingId));
    await expect(start(f)).rejects.toThrow(/not_entitled/);
    await d.update(schema.marketplacePurchases).set({ status: "active", isSubscription: true, subscriptionEnd: new Date("2020-01-01T00:00:00Z") })
      .where(eq(schema.marketplacePurchases.listingId, f.listingId));
    await expect(start(f)).rejects.toThrow(/not_entitled/);
    await d.insert(schema.executionGrants).values({
      subjectType: "user", subjectId: f.buyerId, listingId: f.listingId, workflowVersionId: f.versionId,
      source: "manual", state: "active", expiresAt: new Date("2020-01-01T00:00:00Z"),
    });
    await expect(start(f)).rejects.toThrow(/not_entitled/);
  });

  it("the buyer view contains step metadata only, never the seller's prompts (A12)", async () => {
    const f = await seed();
    const receipt = await start(f);
    const d = await db();
    const [run] = await d.select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, receipt.swarmRunId)).limit(1);
    // Pretend the worker got two steps in; the projection must still be metadata-only.
    await d.insert(schema.agentRuns).values([
      { swarmRunId: run.id, projectId: run.projectId, agentName: "Draft", agentRole: "builder", pipelineStep: 1, userPrompt: "x", systemPrompt: SELLER_PROMPT, status: "completed", tokensUsed: 10, latencyMs: 5 },
      { swarmRunId: run.id, projectId: run.projectId, agentName: "Polish", agentRole: "polisher", pipelineStep: 2, userPrompt: "x", systemPrompt: "polish it quietly", status: "completed", tokensUsed: 7, latencyMs: 3 },
    ]);
    const view = await ex.getProtectedRunView({ buyerId: f.buyerId, swarmRunId: run.id });
    expect(view?.progress).toHaveLength(2);
    expect(JSON.stringify(view)).not.toContain("SELLER SECRET");
    expect(JSON.stringify(view)).not.toContain("sk-SELLERKEY");
    expect(JSON.stringify(view)).not.toContain("polish it quietly");
    expect(view?.progress[0].tokensUsed).toBe(10);
    expect(view?.totals.tokensUsed ?? 0).toBeGreaterThanOrEqual(0);
    // Another buyer cannot read it.
    expect(await ex.getProtectedRunView({ buyerId: f.sellerId, swarmRunId: run.id })).toBeNull();
  });

  it("the same idempotencyKey returns the same run rather than spending twice", async () => {
    const f = await seed();
    const first = await start(f, { idempotencyKey: "op-1" });
    const second = await start(f, { idempotencyKey: "op-1" });
    expect(second.swarmRunId).toBe(first.swarmRunId);
    expect(second.reused).toBe(true);
    const d = await db();
    expect(await d.select({ id: schema.swarmRuns.id }).from(schema.swarmRuns)
      .where(eq(schema.swarmRuns.userId, f.buyerId))).toHaveLength(1);
  });

  it("the v2ProtectedExecution flag is a real gate, and trials wait for the P4 policy", async () => {
    const f = await seed();
    await setFlag("v2ProtectedExecution", false);
    await expect(start(f)).rejects.toThrow(/protected_execution_disabled/);
    await setFlag("v2ProtectedExecution", true);
    // `v2Commercial` is OFF by owner policy, so a trial must not sneak in.
    await expect(start(f, { purpose: "trial" })).rejects.toThrow(/trial_policy_unresolved/);
  });
});

// ─── "no resale" as a fact of the data, not a rule to obey ───────────
//
// The owner's decision says a purchased workflow is licensed to RUN, never to
// sell. Lineage (`publish_origin_required`) is what refuses a derived work, but
// it only has something to refuse if a buyer can reach a publish boundary at all
// — so the stronger guarantee is that a purchase hands the buyer NOTHING
// publishable: no template, no version, no steps. This pins that, from a real
// purchase and a real protected run, rather than trusting the gate alone.
describe("a purchase leaves the buyer nothing to resell (DB-backed)", () => {
  it("creates no owned template, version or steps, and both publish boundaries refuse the seller's work", async () => {
    const f = await seed({ entitled: true });
    const receipt = await start(f);
    const d = await db();

    // The buyer ran it, so they own a run and its container. That container is
    // the only project they own, and it is a container precisely because it
    // holds no definition: the run executed the SELLER's snapshot.
    const buyerProjects = await d.select({ id: schema.projects.id }).from(schema.projects)
      .where(eq(schema.projects.userId, f.buyerId));
    expect(buyerProjects.length).toBeGreaterThan(0);
    const steps = await d.select({ id: schema.pipelineSteps.id }).from(schema.pipelineSteps)
      .where(inArray(schema.pipelineSteps.projectId, buyerProjects.map((p) => p.id)));
    expect(steps).toEqual([]);

    expect(await d.select({ id: schema.pipelineTemplates.id }).from(schema.pipelineTemplates)
      .where(eq(schema.pipelineTemplates.userId, f.buyerId))).toEqual([]);
    expect(await d.select({ id: schema.pipelineVersions.id }).from(schema.pipelineVersions)
      .where(eq(schema.pipelineVersions.ownerId, f.buyerId))).toEqual([]);

    // Boundary 1 — the web/MCP listing path needs a template the caller owns.
    // The seller's is right there and unreachable: same answer as "no such
    // template", so a purchase cannot even be used to probe what exists.
    const { assertOriginalCreatorMayList } = await import("./workflowLineage");
    const [sellerTemplate] = await d.select({ id: schema.pipelineTemplates.id }).from(schema.pipelineTemplates)
      .where(eq(schema.pipelineTemplates.userId, f.sellerId)).limit(1);
    await expect(assertOriginalCreatorMayList({
      userId: f.buyerId, templateId: sellerTemplate.id,
    })).rejects.toThrow("not_found_or_not_authorized");

    // Boundary 2 — selling evidence requires a version the caller owns. The run
    // just executed a real published version; it belongs to the seller.
    await setFlag("v2Publication", true);
    const { publishVersion } = await import("./evidenceService");
    await expect(publishVersion({
      userId: f.buyerId, listingId: f.listingId, workflowVersionId: f.versionId,
      benchmarkId: 1, previewHash: "b".repeat(64), consentVersion: "consent-v1",
    })).rejects.toThrow("not_found_or_not_authorized");

    // And the seller's rows are untouched by any of the above.
    const [stillOurs] = await d.select({ ownerId: schema.pipelineVersions.ownerId })
      .from(schema.pipelineVersions).where(eq(schema.pipelineVersions.id, f.versionId)).limit(1);
    expect(stillOurs.ownerId).toBe(f.sellerId);
    expect(receipt.swarmRunId).toBeGreaterThan(0);
  });
});
