// DB-backed Class A delivery drill (V3-ARCHITECTURE-DECISION.md §7, owner chose
// "sold as a copy" on 2026-10-13). A unique throwaway schema keeps concurrent
// integration runs isolated.
//
// What is exercised for real: entitlement resolution against a purchase row, the
// recomputed definitionHash, the buyer-owned project/steps/template rows written
// by the materializer, and the lineage on the copy's first version. No LLM call
// is made and no payment is taken — the purchase row is seeded directly, exactly
// as the protected-execution file seeds its own entitlements.
//
// The two cases that would fail a naive implementation:
//  · "carries the seller's provider binding" — a copy that kept providerId bills
//    the buyer against someone else's credential row (and is the leak
//    export_pipeline still has at api/routers/export.ts:61-64).
//  · "delivers whatever the row says" — without the hash recomputed over what is
//    about to be written, a drifted version row ships a copy its evidence no
//    longer describes, and the receipt would be a lie.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { and, eq } from "drizzle-orm";

const TEST_DB = `swarm_v2test_delivery_${randomUUID().replaceAll("-", "")}`;
const ROOT_MYSQL = process.env.MYSQL_ROOT_URL || "mysql://root:rootpass@localhost:3307";
const SELLER_PROMPT = "SELLER SECRET SYSTEM PROMPT: reads ~/vault/secrets.md then drafts";
const PIPELINE_CONFIG = { maxIterations: 3, enabledAgents: ["builder", "polisher"], stopOnNoImprovement: false };

let delivery: typeof import("./pipelineDelivery");
let versionService: typeof import("./benchmark/versionService");
let schema: typeof import("@db/schema");
let admin: mysql.Connection;

beforeAll(async () => {
  const rootUrl = new URL(ROOT_MYSQL);
  if (!["localhost", "127.0.0.1"].includes(rootUrl.hostname) || rootUrl.port !== "3307"
    || !["", "/"].includes(rootUrl.pathname)) {
    throw new Error("Delivery tests require the local Docker MySQL endpoint with no database selected");
  }
  admin = await mysql.createConnection(ROOT_MYSQL);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  rootUrl.pathname = `/${TEST_DB}`;
  process.env.DATABASE_URL = rootUrl.toString();
  process.env.DATABASE_READ_URL = process.env.DATABASE_URL;
  process.env.REDIS_URL = "";
  process.env.NODE_ENV = "development";
  process.env.APP_SECRET ||= "1".repeat(64);
  process.env.AI_SWARM_MASTER_KEY ||= "2".repeat(64);
  process.env.MARKETPLACE_MASTER_KEY ||= "3".repeat(64);
  const { execFileSync } = await import("node:child_process");
  execFileSync(process.execPath, [
    fileURLToPath(new URL("../../node_modules/drizzle-kit/bin.cjs", import.meta.url)), "push", "--force",
  ], {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL }, stdio: "pipe", timeout: 150_000,
  });
  delivery = await import("./pipelineDelivery");
  versionService = await import("./benchmark/versionService");
  schema = await import("@db/schema");
}, 300_000);

afterAll(async () => {
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.end();
  }
});

async function db() {
  return (await import("../queries/connection")).getDb();
}

const CERTIFIED_STEPS = [
  {
    stepOrder: 1, name: "Draft", role: "builder", systemPrompt: SELLER_PROMPT,
    stepType: "agent", providerId: 0, model: "seller-model", temperature: "0.7", maxTokens: 1024,
    ifConfig: null, whileConfig: null,
  },
  {
    stepOrder: 2, name: "Polish", role: "polisher", systemPrompt: "polish it quietly",
    stepType: "agent", providerId: 0, model: "seller-model", temperature: "0.5", maxTokens: 512,
    ifConfig: null, whileConfig: null,
  },
];

/** Seller with a published v2 listing on a real `createVersionRow` snapshot, and
 *  a buyer whose purchase was receipted against that exact version. */
async function seed(args: { purchase?: boolean; legacyListing?: boolean; unversionedReceipt?: boolean } = {}) {
  const d = await db();
  const stamp = `${Date.now()}-${Math.random()}`;

  const [seller] = await d.insert(schema.users).values({
    name: "Seller", email: `s-${stamp}@example.test`, tier: "pro_auto",
  });
  const sellerId = Number((seller as { insertId: number }).insertId);
  const [buyer] = await d.insert(schema.users).values({
    name: "Buyer", email: `b-${stamp}@example.test`, tier: "standard",
  });
  const buyerId = Number((buyer as { insertId: number }).insertId);

  const [proj] = await d.insert(schema.projects).values({ userId: sellerId, name: "Seller Pipeline" });
  const sellerProjectId = Number((proj as { insertId: number }).insertId);

  // The seller's own credential row: the copy must never point at it.
  const [sellerProv] = await d.insert(schema.llmProviders).values({
    userId: sellerId, name: `seller-${stamp}`, slug: "openai",
    baseUrl: "https://api.example-provider.com/v1", apiKeyRef: "seller-ciphertext",
    defaultModel: "seller-model",
  });
  const sellerProviderId = Number((sellerProv as { insertId: number }).insertId);

  const steps = CERTIFIED_STEPS.map((s) => ({ ...s, providerId: sellerProviderId }));
  const created = await versionService.createVersionRow({
    ownerId: sellerId,
    sourceProjectId: sellerProjectId,
    definition: { schemaVersion: 1, steps, pipelineConfig: PIPELINE_CONFIG, sourceAgentIds: [] },
    designerMethod: "manual",
  });

  const [tpl] = await d.insert(schema.pipelineTemplates).values({
    userId: sellerId, name: `tpl-${stamp}`,
    steps: [{ name: "Draft", role: "builder", systemPrompt: SELLER_PROMPT }],
    sourceProjectId: sellerProjectId,
  });
  const [listing] = await d.insert(schema.marketplaceListings).values({
    creatorId: sellerId, templateId: Number((tpl as { insertId: number }).insertId),
    title: "Contract Redliner", description: "Redlines a contract", price: "4.99", status: "published",
  });
  const listingId = Number((listing as { insertId: number }).insertId);

  if (!args.legacyListing) {
    await d.insert(schema.marketplaceListingV2).values({
      listingId, publicationMode: "v2", currentWorkflowVersionId: created.versionId,
      evidenceSummaryRevision: 1,
    });
  }

  if (args.purchase !== false) {
    await d.insert(schema.marketplacePurchases).values({
      buyerId, listingId, amountPaid: "4.99", platformFee: "1.50", creatorEarnings: "3.49",
      status: "active",
      // A pre-migration receipt (before 029) names no version at all.
      ...(args.unversionedReceipt ? {} : { workflowVersionId: created.versionId }),
    });
  }

  return {
    sellerId, buyerId, sellerProjectId, sellerProviderId, listingId,
    versionId: created.versionId, definitionHash: created.definitionHash,
  };
}

/** Publish a real evidence record for the seeded listing's version and point the
 *  listing's sidecar at it — the state a listing must be in before anyone may
 *  fork it. Without this the sidecar has no evidence id and the fork refuses. */
async function publishEvidenceFor(f: Awaited<ReturnType<typeof seed>>) {
  const d = await db();
  const { createHash } = await import("crypto");
  const { stableJson } = await import("./benchmark/versionService");
  // A truthful publication: the manifest names the listing/version/definition it
  // belongs to, and manifestHash is the real hash of its canonical bytes — the
  // delivery path now refuses anything less.
  const manifest = {
    schemaVersion: 1,
    versionIdentity: { listingId: f.listingId, workflowVersionId: f.versionId, definitionHash: f.definitionHash },
  };
  const [row] = await d.insert(schema.evidencePublications).values({
    authorId: f.sellerId,
    listingId: f.listingId,
    listingWorkflowVersionId: f.versionId,
    publicationKind: "seller",
    provenance: "platform_recorded",
    publicManifest: JSON.stringify(manifest),
    manifestHash: createHash("sha256").update(stableJson(manifest)).digest("hex"),
    schemaVersion: 1,
    consentVersion: "consent-v1",
    state: "published",
    testedAt: new Date(),
    publishedAt: new Date(),
  });
  const publicationId = Number((row as { insertId: number }).insertId);
  await d.update(schema.marketplaceListingV2).set({ currentEvidencePublicationId: publicationId })
    .where(eq(schema.marketplaceListingV2.listingId, f.listingId));
  return publicationId;
}

const projectCount = async (userId: number) => {
  const d = await db();
  return (await d.select({ id: schema.projects.id }).from(schema.projects)
    .where(eq(schema.projects.userId, userId))).length;
};

describe("Class A marketplace delivery (DB-backed)", () => {
  it("hands an entitled buyer their own editable copy, billed to nobody's keys but theirs", async () => {
    const f = await seed();
    const copy = await delivery.deliverPurchasedCopy(f.buyerId, { listingId: f.listingId });

    expect(copy.projectId).toBeGreaterThan(0);
    expect(copy.stepCount).toBe(2);
    expect(copy.deliveredDefinitionHash).toBe(f.definitionHash);
    expect(copy.meaning).toContain(f.definitionHash);
    expect(copy.versionBinding).toBe("purchase_receipt");

    const d = await db();
    const [project] = await d.select().from(schema.projects).where(eq(schema.projects.id, copy.projectId)).limit(1);
    expect(project.userId).toBe(f.buyerId);
    // Attribution survives ownership: the copy is the buyer's, the work is the
    // seller's, and that is a column — not a string a reseller can rewrite.
    expect(project.originCreatorId).toBe(f.sellerId);
    expect(project.pipelineTemplateId).toBe(copy.templateId);
    expect(project.pipelineConfig).toEqual(PIPELINE_CONFIG);

    const steps = await d.select().from(schema.pipelineSteps)
      .where(eq(schema.pipelineSteps.projectId, copy.projectId)).orderBy(schema.pipelineSteps.stepOrder);
    expect(steps).toHaveLength(2);
    // Class A really does hand over the graph — the prompts are the point.
    expect(steps[0].systemPrompt).toBe(SELLER_PROMPT);
    // …but the seller's bindings do not travel.
    expect(steps.every((s) => s.providerId === null)).toBe(true);
    expect(steps.every((s) => s.agentId === null)).toBe(true);
    expect(steps.some((s) => s.providerId === f.sellerProviderId)).toBe(false);

    const templates = await d.select().from(schema.pipelineTemplates)
      .where(eq(schema.pipelineTemplates.userId, f.buyerId));
    expect(templates).toHaveLength(1);
    expect((templates[0].steps as Array<Record<string, unknown>>)[0].providerId).toBeNull();

    // The copy starts its own history, parented to the certified version and
    // attributed to the seller through inherited lineage.
    const [copyVersion] = await d.select().from(schema.pipelineVersions)
      .where(eq(schema.pipelineVersions.id, copy.workflowVersionId)).limit(1);
    expect(copyVersion.ownerId).toBe(f.buyerId);
    expect(copyVersion.parentVersionId).toBe(f.versionId);
    expect(copyVersion.originCreatorId).toBe(f.sellerId);
    expect(JSON.parse(copyVersion.definition).pipelineConfig).toEqual(PIPELINE_CONFIG);
  });

  it("refuses a buyer with no purchase, and writes nothing on the way out", async () => {
    const f = await seed({ purchase: false });
    await expect(delivery.deliverPurchasedCopy(f.buyerId, { listingId: f.listingId }))
      .rejects.toThrow(/not_entitled/);
    expect(await projectCount(f.buyerId)).toBe(0);
  });

  it("refuses a refunded purchase — the door closes when the money is returned", async () => {
    const f = await seed();
    const d = await db();
    await d.update(schema.marketplacePurchases).set({ status: "refunded" })
      .where(and(eq(schema.marketplacePurchases.buyerId, f.buyerId), eq(schema.marketplacePurchases.listingId, f.listingId)));
    await expect(delivery.deliverPurchasedCopy(f.buyerId, { listingId: f.listingId }))
      .rejects.toThrow(/not_entitled/);
    expect(await projectCount(f.buyerId)).toBe(0);
  });

  it("refuses when the version row no longer matches its own hash, and writes nothing", async () => {
    const f = await seed();
    const d = await db();
    // Counted globally and compared before/after, so the case does not depend on
    // which deliveries ran earlier in this file.
    const stepsBefore = (await d.select({ id: schema.pipelineSteps.id }).from(schema.pipelineSteps)).length;
    // Drift the definition in place while the recorded hash stays as published:
    // exactly the state in which a shipped copy would stop being the thing the
    // listing's evidence describes.
    const drifted = versionService.stableJson({
      schemaVersion: 1,
      steps: [{ ...CERTIFIED_STEPS[0], providerId: f.sellerProviderId, systemPrompt: "REPLACED PROMPT" }],
      pipelineConfig: null,
      sourceAgentIds: [],
    });
    await d.update(schema.pipelineVersions).set({ definition: drifted })
      .where(eq(schema.pipelineVersions.id, f.versionId));

    await expect(delivery.deliverPurchasedCopy(f.buyerId, { listingId: f.listingId }))
      .rejects.toThrow(/definition_hash_mismatch/);
    expect(await projectCount(f.buyerId)).toBe(0);
    // The refusal happens before the first INSERT: no half-written copy is left
    // pointing at a project that was never created.
    const stepsAfter = (await d.select({ id: schema.pipelineSteps.id }).from(schema.pipelineSteps)).length;
    expect(stepsAfter).toBe(stepsBefore);
  });

  it("refuses a legacy listing: there is no certified version to hand over", async () => {
    const f = await seed({ legacyListing: true });
    await expect(delivery.deliverPurchasedCopy(f.buyerId, { listingId: f.listingId }))
      .rejects.toThrow(/not_a_v2_listing/);
    expect(await projectCount(f.buyerId)).toBe(0);
  });

  it("does not let a receipt on one listing deliver another", async () => {
    const a = await seed();
    const b = await seed({ purchase: false });
    await expect(delivery.deliverPurchasedCopy(a.buyerId, { listingId: b.listingId }))
      .rejects.toThrow(/not_entitled/);
    expect(await projectCount(a.buyerId)).toBe(0);
  });

  it("says so when an unversioned receipt gets whatever is current, not what was bought", async () => {
    const f = await seed({ unversionedReceipt: true });
    const d = await db();
    // The seller ships a new build AFTER the sale and the listing's current
    // pointer moves to it. A receipt that names no version resolves forward —
    // which is the one way a copy can be a different build than the one money
    // changed hands for. It is allowed (stranding pre-migration buyers is worse)
    // but it is disclosed in the record the buyer keeps, not only in a log line.
    const newer = await versionService.createVersionRow({
      ownerId: f.sellerId,
      sourceProjectId: f.sellerProjectId,
      definition: {
        schemaVersion: 1,
        steps: [{ ...CERTIFIED_STEPS[0], providerId: f.sellerProviderId, systemPrompt: "SELLER PROMPT FROM A BUILD AFTER THE SALE" }],
        pipelineConfig: null,
        sourceAgentIds: [],
      },
      designerMethod: "manual",
      parentVersionId: f.versionId,
    });
    await d.update(schema.marketplaceListingV2).set({ currentWorkflowVersionId: newer.versionId })
      .where(eq(schema.marketplaceListingV2.listingId, f.listingId));

    const copy = await delivery.deliverPurchasedCopy(f.buyerId, { listingId: f.listingId });
    expect(copy.versionBinding).toBe("legacy_current");
    expect(copy.deliveredVersionNumber).toBe(2);
    expect(copy.deliveredDefinitionHash).toBe(newer.definitionHash);
    expect(copy.meaning).toContain("predates version receipting");
    expect(copy.meaning).toContain(newer.definitionHash);
  });

  it("delivers a copy that exports as the work itself, with none of the wiring", async () => {
    const f = await seed();
    const copy = await delivery.deliverPurchasedCopy(f.buyerId, { listingId: f.listingId });

    const d = await db();
    const [buyerUser] = await d.select().from(schema.users).where(eq(schema.users.id, f.buyerId)).limit(1);
    const { appRouter } = await import("../router");
    const caller = appRouter.createCaller({
      req: new Request("http://internal/test"),
      resHeaders: new Headers(),
      user: buyerUser,
      requestId: "delivery-export-probe",
    });
    const exported = await caller.export.exportPipeline({ projectId: copy.projectId });
    const text = JSON.stringify(exported);

    expect(exported.format).toBe(2);
    // The graph is genuinely in the file — for Class A that IS the product.
    expect(text.includes("SELLER SECRET SYSTEM PROMPT")).toBe(true);
    // None of the database wiring is. A row id in a shared artifact cannot be
    // honoured by anyone (execution re-resolves the credential from the runner's
    // own account), so shipping one would only invite a broken import.
    for (const forbidden of ["providerId", "agentId", "projectId", "userId", '"id":']) {
      expect(text.includes(forbidden), `export payload carries ${forbidden}`).toBe(false);
    }
  });
  describe("forking a public listing", () => {
    it("refuses a listing whose evidence is not published — no evidence, no fork", async () => {
      const f = await seed();
      await expect(delivery.forkPublicListing(f.buyerId, { listingId: f.listingId }))
        .rejects.toThrow(/no_published_evidence/);
      expect(await projectCount(f.buyerId)).toBe(0);
    });

    it("refuses an unpublished listing and a nonexistent one identically", async () => {
      const f = await seed();
      await publishEvidenceFor(f);
      const d = await db();
      await d.update(schema.marketplaceListings).set({ status: "unpublished" })
        .where(eq(schema.marketplaceListings.id, f.listingId));
      const hidden = await delivery.forkPublicListing(f.buyerId, { listingId: f.listingId })
        .catch((err: Error) => err.message);
      const missing = await delivery.forkPublicListing(f.buyerId, { listingId: 987_654 })
        .catch((err: Error) => err.message);
      expect(hidden).toBe(missing);
      expect(String(hidden)).toMatch(/not_available/);
    });

    it("forks a published listing into the forker's own account, attributed to its origin", async () => {
      const f = await seed();
      await publishEvidenceFor(f);
      const copy = await delivery.forkPublicListing(f.buyerId, { listingId: f.listingId });

      expect(copy.versionBinding).toBe("public_fork");
      expect(copy.deliveredDefinitionHash).toBe(f.definitionHash);
      expect(copy.meaning).toContain("attributed");

      const d = await db();
      const [project] = await d.select().from(schema.projects).where(eq(schema.projects.id, copy.projectId)).limit(1);
      expect(project.userId).toBe(f.buyerId);
      // The fork carries the origin account as data, not as a string in a name.
      expect(project.originCreatorId).toBe(f.sellerId);

      const steps = await d.select().from(schema.pipelineSteps)
        .where(eq(schema.pipelineSteps.projectId, copy.projectId));
      expect(steps).toHaveLength(2);
      expect(steps.every((s) => s.providerId === null && s.agentId === null)).toBe(true);
      expect(steps.some((s) => s.systemPrompt === SELLER_PROMPT)).toBe(true);

      const [copyVersion] = await d.select().from(schema.pipelineVersions)
        .where(eq(schema.pipelineVersions.id, copy.workflowVersionId)).limit(1);
      expect(copyVersion.originCreatorId).toBe(f.sellerId);
      expect(copyVersion.parentVersionId).toBe(f.versionId);
    });

    it("lets the origin account fork its own listing without laundering attribution", async () => {
      const f = await seed();
      await publishEvidenceFor(f);
      const copy = await delivery.forkPublicListing(f.sellerId, { listingId: f.listingId });
      expect(copy.sellerId).toBe(f.sellerId);
      const d = await db();
      const [project] = await d.select().from(schema.projects).where(eq(schema.projects.id, copy.projectId)).limit(1);
      expect(project.originCreatorId).toBe(f.sellerId);
    });
  });

  describe("the portable bundle", () => {
    async function makeStranger(tag: string) {
      const d = await db();
      const [u] = await d.insert(schema.users).values({ name: "Stranger", email: `x-${tag}@example.test`, tier: "standard" });
      return Number((u as { insertId: number }).insertId);
    }

    it("exports a published listing as a file with no database wiring in it", async () => {
      const f = await seed();
      await publishEvidenceFor(f);
      const bundle = await delivery.exportListingBundle(f.buyerId, f.listingId);
      const text = JSON.stringify(bundle);
      expect(bundle.provenance.definitionHash).toBe(f.definitionHash);
      expect(bundle.provenance.originCreatorId).toBe(f.sellerId);
      expect(bundle.pipeline.steps).toHaveLength(2);
      expect(text.includes("SELLER SECRET SYSTEM PROMPT")).toBe(true);
      for (const forbidden of ["providerId", "agentId", '"projectId"', '"userId"', '"id":']) {
        expect(text.includes(forbidden), forbidden).toBe(false);
      }
    });

    it("imports into a different account as an owned, attributed, key-free copy", async () => {
      const f = await seed();
      await publishEvidenceFor(f);
      const bundle = await delivery.exportListingBundle(f.buyerId, f.listingId);
      const stranger = await makeStranger(`${Date.now()}`);

      const imported = await delivery.importPipelineBundle(stranger, { bundle });
      expect(imported.verification.valid).toBe(true);
      // The seeded publication was written straight into the table, so it carries
      // no attestation: the import must say the benchmark is unproven rather than
      // quietly treating a file as verified.
      expect(imported.verification.evidenceState).toBe("unsigned");
      expect(imported.meaning).toContain("nothing here proves DeeWaanAI issued it");

      const d = await db();
      const [project] = await d.select().from(schema.projects).where(eq(schema.projects.id, imported.projectId)).limit(1);
      expect(project.userId).toBe(stranger);
      expect(project.originCreatorId).toBe(0);
      expect(project.pipelineConfig).toMatchObject({
        ...PIPELINE_CONFIG,
        _importedBundle: { provenance: bundle.provenance, evidence: bundle.evidence, verification: imported.verification },
      });
      const [version] = await d.select().from(schema.pipelineVersions)
        .where(eq(schema.pipelineVersions.sourceProjectId, imported.projectId));
      expect(version.parentVersionId).toBeNull();
      expect(version.originVersionId).toBeNull();
      expect(version.originCreatorId).toBe(0);
      const steps = await d.select().from(schema.pipelineSteps)
        .where(eq(schema.pipelineSteps.projectId, imported.projectId));
      expect(steps).toHaveLength(2);
      expect(steps.every((x) => x.providerId === null && x.agentId === null)).toBe(true);
    });

    async function remoteBundle() {
      const { buildPipelineBundle, bundleIntegrityHash } = await import("./pipelineBundle");
      const steps = CERTIFIED_STEPS.map(({ providerId: _providerId, ...step }) => step);
      return buildPipelineBundle({
        pipelineName: "Independent installation",
        pipelineDescription: "Portable pipeline with no local source rows",
        steps,
        listingId: 2_000_000_001,
        workflowVersionId: 2_000_000_002,
        originCreatorId: 2_000_000_003,
        originAccountName: "Remote author",
        workflowVersionNumber: 7,
        definitionHash: "a".repeat(64),
        bundleHash: bundleIntegrityHash({ steps, schemaVersion: 1, pipelineConfig: PIPELINE_CONFIG }),
        schemaVersion: 1,
        pipelineConfig: PIPELINE_CONFIG,
        manifestHash: "b".repeat(64),
        manifestJson: null,
        attestation: null,
        bundleAttestation: null,
      });
    }

    it("imports absent remote identities without resolving local lineage and preserves portable metadata", async () => {
      const bundle = await remoteBundle();
      const stranger = await makeStranger(`remote-${randomUUID()}`);
      const d = await db();
      expect(await d.select().from(schema.users)
        .where(eq(schema.users.id, bundle.provenance.originCreatorId))).toHaveLength(0);
      expect(await d.select().from(schema.pipelineVersions)
        .where(eq(schema.pipelineVersions.id, bundle.provenance.workflowVersionId!))).toHaveLength(0);
      const lineage = await import("./workflowLineage");
      const lookup = vi.spyOn(lineage, "resolveVersionLineage");
      try {
        const imported = await delivery.importPipelineBundle(stranger, { bundle, name: "Local copy" });
        expect(lookup).not.toHaveBeenCalled();
        const [project] = await d.select().from(schema.projects).where(eq(schema.projects.id, imported.projectId));
        expect(project.userId).toBe(stranger);
        expect(project.name).toBe("Local copy");
        expect(project.originCreatorId).toBe(0);
        expect(project.defaultProviderId).toBeNull();
        expect(project.pipelineConfig).toEqual({
          ...PIPELINE_CONFIG,
          _importedBundle: {
            kind: bundle.kind,
            exportedAt: bundle.exportedAt,
            provenance: bundle.provenance,
            evidence: bundle.evidence,
            attestation: bundle.attestation,
            verification: imported.verification,
          },
        });
        const [version] = await d.select().from(schema.pipelineVersions)
          .where(eq(schema.pipelineVersions.sourceProjectId, imported.projectId));
        expect(version.ownerId).toBe(stranger);
        expect(version.parentVersionId).toBeNull();
        expect(version.originVersionId).toBeNull();
        expect(version.originCreatorId).toBe(0);
        const definition = JSON.parse(version.definition);
        expect(definition.pipelineConfig).toEqual(project.pipelineConfig);
        expect(definition.sourceAgentIds).toEqual([null, null]);
        expect(definition.steps.every((s: { providerId: number | null }) => s.providerId === null)).toBe(true);
        const [template] = await d.select().from(schema.pipelineTemplates)
          .where(eq(schema.pipelineTemplates.id, project.pipelineTemplateId!));
        expect(template.userId).toBe(stranger);
        expect(template.sourceProjectId).toBe(project.id);
        expect(template.steps).toHaveLength(2);
        expect(template.steps.every((s) => s.providerId === null)).toBe(true);
        await expect(lineage.assertOriginalCreatorMaySellVersion({ userId: stranger, workflowVersionId: version.id }))
          .rejects.toThrow(/publish_origin_required/);
        const next = await versionService.captureVersionFromProject(stranger, project.id);
        const loaded = await versionService.loadVersionDefinition(next.versionId);
        expect(loaded.version.originCreatorId).toBe(0);
        expect(loaded.definition.pipelineConfig).toEqual(project.pipelineConfig);
      } finally {
        lookup.mockRestore();
      }
    });

    it("rolls back project and step writes when template insertion fails", async () => {
      const bundle = await remoteBundle();
      const stranger = await makeStranger(`rollback-${randomUUID()}`);
      const d = await db();
      const before = {
        projects: (await d.select().from(schema.projects)).length,
        steps: (await d.select().from(schema.pipelineSteps)).length,
        templates: (await d.select().from(schema.pipelineTemplates)).length,
        versions: (await d.select().from(schema.pipelineVersions)).length,
      };
      await admin.query(`CREATE TRIGGER \`${TEST_DB}\`.reject_delivery_template BEFORE INSERT ON \`${TEST_DB}\`.pipeline_templates
        FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced template failure'`);
      try {
        await expect(delivery.importPipelineBundle(stranger, { bundle }))
          .rejects.toMatchObject({ cause: { message: "forced template failure" } });
        expect((await d.select().from(schema.projects)).length).toBe(before.projects);
        expect((await d.select().from(schema.pipelineSteps)).length).toBe(before.steps);
        expect((await d.select().from(schema.pipelineTemplates)).length).toBe(before.templates);
        expect((await d.select().from(schema.pipelineVersions)).length).toBe(before.versions);
      } finally {
        await admin.query(`DROP TRIGGER \`${TEST_DB}\`.reject_delivery_template`);
      }
    });

    it("refuses a bundle whose steps were edited, and writes nothing", async () => {
      const f = await seed();
      await publishEvidenceFor(f);
      const bundle = await delivery.exportListingBundle(f.buyerId, f.listingId);
      const stranger = await makeStranger(`t-${Date.now()}`);
      const before = await projectCount(stranger);

      const tampered = {
        ...bundle,
        pipeline: { ...bundle.pipeline, steps: [{ ...bundle.pipeline.steps[0], systemPrompt: "TAMPERED" }, ...bundle.pipeline.steps.slice(1)] },
      };
      await expect(delivery.importPipelineBundle(stranger, { bundle: tampered }))
        .rejects.toThrow(/bundle_steps_do_not_match_the_declared_hash/);
      expect(await projectCount(stranger)).toBe(before);
    });

    it("refuses to export a listing that is neither entitled nor publicly evidenced", async () => {
      const f = await seed({ purchase: false });
      const stranger = await makeStranger(`n-${Date.now()}`);
      const hidden = await delivery.exportListingBundle(stranger, f.listingId).catch((e: Error) => e.message);
      const missing = await delivery.exportListingBundle(stranger, 987_654).catch((e: Error) => e.message);
      expect(hidden).toBe(missing);
      expect(String(hidden)).toMatch(/not_available/);
    });
  });
});
