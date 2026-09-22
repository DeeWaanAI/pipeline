// Legacy-flow drill (spec §12 "legacy-flow e2e", and the owner's rule of
// 2026-09-22: a seller who removes an item stops NEW sales only — "all what is
// bought stays running"). Own throwaway schema so it cannot collide with the
// parallel integration files. No LLM call is made anywhere.
//
// What is exercised is the SEAM between the two systems. A listing that
// predates v2 has no `marketplace_listing_v2` row and no evidence publication,
// so it must (a) keep being sellable and usable, (b) be refused by the v2
// protected-execution path rather than silently borrowing its guarantees, and
// (c) never be able to fake a v2 evidence receipt. The purchase right itself is
// the thing that must survive a delisting, a withdrawal and a refund.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { and, eq } from "drizzle-orm";

const TEST_DB = "swarm_v2test_legacy";
const ROOT_MYSQL = process.env.MYSQL_ROOT_URL || "mysql://root:rootpass@localhost:3307";
const SELLER_PROMPT = "SELLER SECRET PROMPT: read the client's /vault folder using sk-SELLERKEY123456789";
const APPROVED_URL = "https://api.example-provider.com/v1";

let exec: typeof import("./marketplaceExecutionService");
let sync: typeof import("./entitlementSync");
let ent: typeof import("./entitlements");
let evidence: typeof import("./evidenceService");
let schema: typeof import("@db/schema");
let admin: mysql.Connection;

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
  exec = await import("./marketplaceExecutionService");
  sync = await import("./entitlementSync");
  ent = await import("./entitlements");
  evidence = await import("./evidenceService");
  schema = await import("@db/schema");
  await setFlag("v2ProtectedExecution", true);
}, 300_000);

afterAll(async () => {
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.query(`REVOKE ALL PRIVILEGES ON \`${TEST_DB}\`.* FROM 'swarm'@'%'`);
    await admin.end();
  }
});

/** A pre-v2 listing: published, priced, sellable, with NO sidecar row and NO
 *  evidence publication — which is what every legacy listing looked like the
 *  day v2 shipped. */
async function seed() {
  const d = await db();
  const stamp = `${Date.now()}-${Math.random()}`;
  const [seller] = await d.insert(schema.users).values({ name: "Legacy Seller", email: `ls-${stamp}@example.test`, tier: "standard" });
  const sellerId = Number((seller as { insertId: number }).insertId);
  const [buyer] = await d.insert(schema.users).values({ name: "Legacy Buyer", email: `lb-${stamp}@example.test`, tier: "standard" });
  const buyerId = Number((buyer as { insertId: number }).insertId);

  const [proj] = await d.insert(schema.projects).values({ userId: sellerId, name: "Legacy Pipeline" });
  const projectId = Number((proj as { insertId: number }).insertId);
  const [prov] = await d.insert(schema.llmProviders).values({
    userId: sellerId, name: `seller-${stamp}`, slug: "openai", baseUrl: APPROVED_URL,
    apiKeyRef: "seller-ciphertext", defaultModel: "seller-model",
  });
  const sellerProviderId = Number((prov as { insertId: number }).insertId);
  const [ver] = await d.insert(schema.pipelineVersions).values({
    ownerId: sellerId, sourceProjectId: projectId, versionNumber: 1,
    definition: JSON.stringify({
      steps: [{
        stepOrder: 1, name: "Draft", role: "builder", systemPrompt: SELLER_PROMPT,
        providerId: sellerProviderId, model: "seller-model", temperature: "0.7", maxTokens: 1024,
        stepType: "agent", ifConfig: null, whileConfig: null,
      }],
      sourceAgentIds: [],
    }),
    definitionHash: "b".repeat(64),
  });
  const versionId = Number((ver as { insertId: number }).insertId);
  const [tpl] = await d.insert(schema.pipelineTemplates).values({
    userId: sellerId, name: `legacy-tpl-${stamp}`, sourceProjectId: projectId,
    steps: [{ name: "Draft", role: "builder", systemPrompt: SELLER_PROMPT }],
  });
  const [listing] = await d.insert(schema.marketplaceListings).values({
    creatorId: sellerId, templateId: Number((tpl as { insertId: number }).insertId),
    title: "Legacy Summariser", price: "9.99", status: "published",
  });
  const listingId = Number((listing as { insertId: number }).insertId);

  const approved = await d.select({ id: schema.trustedProviderEndpoints.id }).from(schema.trustedProviderEndpoints)
    .where(and(eq(schema.trustedProviderEndpoints.provider, "openai"), eq(schema.trustedProviderEndpoints.baseUrl, APPROVED_URL)))
    .limit(1);
  if (!approved.length) {
    await d.insert(schema.trustedProviderEndpoints).values({
      provider: "openai", baseUrl: APPROVED_URL, adapterKind: "openai_compatible",
      endpointClass: "first_party", loggingDisclosure: "Provider retains request logs for the credential owner.",
      protectionClass: "standard", approvedBy: sellerId, policyVersion: "test-1", enabled: true,
    });
  }
  return { d, sellerId, buyerId, listingId, versionId, stamp };
}

async function buy(f: Awaited<ReturnType<typeof seed>>) {
  return sync.fulfillMarketplacePurchase({
    userId: f.buyerId, listingId: f.listingId, amountPaid: 9.99,
    stripeSessionId: `cs_${f.stamp}`, stripePaymentIntentId: `pi_${f.stamp}`,
  });
}

const right = (f: Awaited<ReturnType<typeof seed>>) => exec.resolveProtectedExecutionRight({
  buyerId: f.buyerId, listingId: f.listingId, purpose: "buyer_execution",
});

describe("a listing that predates the v2 publication rules", () => {
  it("has no v2 record and no evidence — which does not stop it being sold", async () => {
    const f = await seed();
    const [v2] = await f.d.select().from(schema.marketplaceListingV2)
      .where(eq(schema.marketplaceListingV2.listingId, f.listingId)).limit(1);
    expect(v2, "a legacy listing must have no sidecar row for this drill to mean anything").toBeUndefined();

    await expect(buy(f)).resolves.toMatchObject({ purchaseId: expect.any(Number) });
    expect(await ent.can(f.buyerId, `pipeline:run:${f.listingId}`)).toBe(true);
  });

  it("grants the purchase capability with no version pin (there was none to pin)", async () => {
    const f = await seed();
    await buy(f);
    const [purchase] = await f.d.select().from(schema.marketplacePurchases)
      .where(and(eq(schema.marketplacePurchases.buyerId, f.buyerId), eq(schema.marketplacePurchases.listingId, f.listingId)))
      .limit(1);
    expect(purchase.workflowVersionId).toBeNull();
    expect(purchase.evidencePublicationId).toBeNull();
    const granted = await ent.getActiveEntitlements("user", f.buyerId);
    expect(granted.map((g) => g.capability)).toContain(`pipeline:run:${f.listingId}`);
    expect(granted.find((g) => g.capability === `pipeline:run:${f.listingId}`)?.source).toBe("purchase");
  });

  it("is refused by the v2 protected path instead of borrowing its guarantees", async () => {
    const f = await seed();
    await buy(f);
    await expect(right(f)).rejects.toThrow(/not_a_v2_listing/);
    await expect(exec.startProtectedRun({
      buyerId: f.buyerId, listingId: f.listingId, input: "summarise this",
      providerId: f.sellerId, dispatch: async () => {},
    })).rejects.toThrow(/not_a_v2_listing/);
  });

  it("delisting stops new purchases and leaves the bought right intact (owner rule)", async () => {
    const f = await seed();
    await buy(f);
    await f.d.update(schema.marketplaceListings).set({ status: "unpublished" })
      .where(eq(schema.marketplaceListings.id, f.listingId));

    expect(await ent.can(f.buyerId, `pipeline:run:${f.listingId}`), "the buyer keeps what they bought").toBe(true);
    const [purchase] = await f.d.select({ status: schema.marketplacePurchases.status }).from(schema.marketplacePurchases)
      .where(and(eq(schema.marketplacePurchases.buyerId, f.buyerId), eq(schema.marketplacePurchases.listingId, f.listingId)))
      .limit(1);
    expect(purchase.status).toBe("active");

    const [latecomer] = await f.d.insert(schema.users).values({ name: "Latecomer", email: `late-${f.stamp}@example.test`, tier: "standard" });
    await expect(sync.fulfillMarketplacePurchase({
      userId: Number((latecomer as { insertId: number }).insertId), listingId: f.listingId,
      amountPaid: 9.99, stripeSessionId: `cs_late_${f.stamp}`, stripePaymentIntentId: null,
    })).rejects.toThrow(/not buyable/);
  });

  it("has no purchased evidence to read — a legacy listing cannot mint a v2 receipt", async () => {
    const f = await seed();
    await buy(f);
    expect(await evidence.getPurchasedEvidenceForListing({ userId: f.buyerId, listingId: f.listingId })).toBeNull();
  });

  it("a refund revokes the right, and only that buyer's right", async () => {
    const f = await seed();
    await buy(f);
    const [keeper] = await f.d.insert(schema.users).values({ name: "Keeper", email: `keep-${f.stamp}@example.test`, tier: "standard" });
    const keeperId = Number((keeper as { insertId: number }).insertId);
    await sync.fulfillMarketplacePurchase({
      userId: keeperId, listingId: f.listingId, amountPaid: 9.99,
      stripeSessionId: `cs_keep_${f.stamp}`, stripePaymentIntentId: `pi_keep_${f.stamp}`,
    });

    expect(await sync.revokeMarketplacePurchase({ stripePaymentIntentId: `pi_${f.stamp}` })).toEqual({ revoked: true });
    expect(await ent.can(f.buyerId, `pipeline:run:${f.listingId}`), "the refunded buyer must lose the right").toBe(false);
    expect(await ent.can(keeperId, `pipeline:run:${f.listingId}`), "an unrelated buyer must not be collaterally revoked").toBe(true);
  });
});
