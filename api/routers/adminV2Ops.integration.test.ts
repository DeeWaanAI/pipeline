// DB-backed integration test for the v2 operations screen (spec D10, task #21).
//
// Four things are proven against the REAL tables, through the REAL tRPC
// procedures (no stubbed aggregation, no mocked service):
//   1. a provider endpoint can be approved and then listed — and the row it
//      wrote is the row the egress gate actually resolves;
//   2. a catalogued model's `vendor` can be set and is returned by both the
//      admin read and the D12 consumer, while the existing write rules (admin
//      only, reviewed lineage, refresh-instead-of-duplicate) still hold;
//   3. a partially-priced benchmark is rendered as a FLOOR plus an unpriced
//      count, and no dollar total is ever presented while something is unpriced;
//   4. a non-admin caller is refused on every new procedure, refused calls and
//      plain reads both leave every table byte-for-byte as they found them.
//
// Own throwaway schema (`swarm_v2test_adminops`) plus a `GET_LOCK` guard, so it
// cannot collide with the other parallel integration files and cannot touch the
// local `swarm` database with the desktop-pass artifacts in it.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { count, eq, isNull } from "drizzle-orm";
import * as schema from "@db/schema";
import * as relations from "@db/relations";

const isolated = vi.hoisted(() => ({ db: null as MySql2Database<typeof schema & typeof relations> | null }));
vi.mock("../queries/connection", () => ({
  getDb: () => {
    if (!isolated.db) throw new Error("Admin ops test database is not initialized");
    return isolated.db;
  },
}));

import { adminRouter } from "./admin";
import { modelCatalogRouter } from "./modelCatalog";
import { assertTrustedEgress } from "../services/protectedEgress";
import { resolveModelVendors } from "../services/modelCatalogService";

const TEST_DB = "swarm_v2test_adminops";
const ENDPOINT_URL = "https://api.example-provider.com/v1";
const DISCLOSURE = "Provider retains request and response logs for the credential owner; no training on inputs.";

let admin: mysql.Connection | undefined;
let pool: mysql.Pool | undefined;
let ownsDatabase = false;

beforeAll(async () => {
  if (process.env.NODE_ENV === "production") throw new Error("Admin ops tests refuse production mode");
  const url = new URL(process.env.MYSQL_ROOT_URL || "mysql://root:rootpass@localhost:3307");
  const connection = {
    host: url.hostname, port: Number(url.port || 3307),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
  };
  admin = await mysql.createConnection(connection);
  const [lock] = await admin.query<mysql.RowDataPacket[]>("SELECT GET_LOCK(?, 0) AS acquired", [TEST_DB]);
  if (lock[0].acquired !== 1) throw new Error("Another admin-ops fixture is running");
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
type Ctx = Parameters<typeof adminRouter.createCaller>[0];
type Caller = ReturnType<typeof adminRouter.createCaller>;

let seq = 0;
async function actor(email: string, role: "admin" | "user") {
  seq += 1;
  const [res] = await db().insert(schema.users).values({
    name: `${role}-${seq}`, email, username: `${role}${seq}`, role,
  });
  const id = Number((res as { insertId: number }).insertId);
  const [row] = await db().select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
  return row;
}

const insertId = (res: unknown) => Number((res as { insertId: number }).insertId);

function as(user: schema.User): Caller {
  return adminRouter.createCaller({ user, remoteIp: "test-fixture" } as Ctx);
}
function catalogAs(user: schema.User) {
  return modelCatalogRouter.createCaller({ user, remoteIp: "test-fixture" } as Ctx);
}

async function refuses(call: Promise<unknown>, code: "FORBIDDEN" | "UNAUTHORIZED") {
  const err = await call.then(() => null, (e: unknown) => e as { code?: string; message?: string });
  expect(err, "the call was expected to be refused").not.toBeNull();
  expect((err as { code?: string }).code).toBe(code);
}

// Every table this screen touches, counted before and after a read so "reads
// are reads" is a measured claim rather than an assertion of intent.
const COUNT_QUERIES = [
  () => db().select({ total: count() }).from(schema.trustedProviderEndpoints),
  () => db().select({ total: count() }).from(schema.modelCatalog),
  () => db().select({ total: count() }).from(schema.modelReleaseEvents),
  () => db().select({ total: count() }).from(schema.evidencePublications),
  () => db().select({ total: count() }).from(schema.callAttempts),
  () => db().select({ total: count() }).from(schema.spendApprovals),
  () => db().select({ total: count() }).from(schema.adminAuditLog),
  () => db().select({ total: count() }).from(schema.benchmarks),
  () => db().select({ total: count() }).from(schema.llmProviders),
  () => db().select({ total: count() }).from(schema.users),
];

async function tableCounts() {
  const out: number[] = [];
  for (const one of COUNT_QUERIES) {
    const [r] = await one();
    out.push(Number(r.total));
  }
  return out;
}

/** A payer-owned provider row pointing at ENDPOINT_URL — the shape a protected
 *  buyer run presents to the egress gate. */
async function seedProvider(payerId: number) {
  const [provider] = await db().insert(schema.llmProviders).values({
    userId: payerId, name: "fixture-provider", slug: "example_provider", baseUrl: ENDPOINT_URL,
    apiKeyRef: "not-a-real-ciphertext", defaultModel: "model-a", isEnabled: true,
  });
  return insertId(provider);
}

/** One frozen call plan, three benchmarks, and a ledger whose rows differ only
 *  in how much of them has been priced. */
async function seedSpend(payerId: number) {
  const d = db();
  const [approval] = await d.insert(schema.spendApprovals).values({
    actorId: payerId, payerId, purpose: "private_evaluation", planHash: "d".repeat(64),
    planSnapshot: '{"calls":6}', bindings: [{ providerId: 1, model: "model-a" }],
    limits: { maxCalls: 6 }, spendCeilingUsd: "1.00", status: "active", policyVersion: "v2-spend-1",
  });
  const spendApprovalId = insertId(approval);
  const [meta] = await d.insert(schema.benchmarks).values({
    ownerId: payerId, executionMode: "grade_only", state: "completed", spendApprovalId,
  });
  const [partial] = await d.insert(schema.benchmarks).values({
    ownerId: payerId, executionMode: "grade_only", state: "completed", spendApprovalId,
  });
  const [unpriced] = await d.insert(schema.benchmarks).values({
    ownerId: payerId, executionMode: "grade_only", state: "completed", spendApprovalId,
  });
  const ids = {
    meta: insertId(meta),
    partial: insertId(partial),
    unpriced: insertId(unpriced),
  };

  let operationId = 1000;
  const attempt = async (row: {
    benchmarkId: number | null; cost: string | null; basis: string | null;
    completeness: "complete" | "partial" | "unknown"; outcome?: "success" | "failed" | "uncertain";
  }) => {
    operationId += 1;
    await d.insert(schema.callAttempts).values({
      operationKind: "generation", operationId, benchmarkId: row.benchmarkId,
      purpose: "private_evaluation", actorId: payerId, payerId, providerRefId: null,
      requestedModel: "model-a", attemptIndex: 1, outcome: row.outcome ?? "success",
      promptTokens: 100, completionTokens: 50,
      estimatedCostUsd: row.cost, costBasis: row.basis,
      costPricingAsOf: row.basis ? new Date("2026-01-01T00:00:00Z") : null,
      costCompleteness: row.completeness,
    });
  };
  // Fully priced benchmark: the figure IS a fact.
  await attempt({ benchmarkId: ids.meta, cost: "0.05000000", basis: "price_vector", completeness: "complete" });
  // Partially priced benchmark: the priced part is a floor, not a bill.
  await attempt({ benchmarkId: ids.partial, cost: "0.01000000", basis: "price_vector", completeness: "complete" });
  await attempt({ benchmarkId: ids.partial, cost: "0.02000000", basis: "provider_list", completeness: "complete" });
  await attempt({ benchmarkId: ids.partial, cost: null, basis: null, completeness: "unknown" });
  await attempt({ benchmarkId: ids.partial, cost: null, basis: null, completeness: "partial", outcome: "uncertain" });
  // Nothing priceable at all: still not a claim that the run was free.
  await attempt({ benchmarkId: ids.unpriced, cost: null, basis: null, completeness: "unknown" });
  await attempt({ benchmarkId: ids.unpriced, cost: null, basis: null, completeness: "unknown" });
  // One row no benchmark owns.
  await attempt({ benchmarkId: null, cost: "0.00250000", basis: "price_vector", completeness: "complete" });

  return { ...ids, spendApprovalId };
}

describe("v2 operations screen (isolated localhost MySQL)", () => {
  it("approves a provider endpoint, lists it, and the gate resolves exactly that row", async () => {
    const actorRow = await actor("ops-endpoints@example.test", "admin");
    const payer = await actor("payer-endpoints@example.test", "user");
    const ops = as(actorRow);
    const base = {
      provider: "example_provider", loggingDisclosure: DISCLOSURE,
      protectionClass: "standard" as const, policyVersion: "v2-egress-1",
    };

    expect(await ops.listTrustedEndpoints()).toEqual([]);

    // The two disclosures are mandatory: each omission is a refusal, not a
    // silent default.
    await expect(ops.approveTrustedEndpoint({
      provider: "example_provider", baseUrl: ENDPOINT_URL, protectionClass: "standard", policyVersion: "v2-egress-1",
    } as never)).rejects.toThrow();
    await expect(ops.approveTrustedEndpoint({
      provider: "example_provider", baseUrl: ENDPOINT_URL, loggingDisclosure: DISCLOSURE, policyVersion: "v2-egress-1",
    } as never)).rejects.toThrow();
    // A plain-http destination is never a trusted executor, so it cannot even
    // be approved into the table.
    await expect(ops.approveTrustedEndpoint({
      ...base, baseUrl: "http://api.example-provider.com/v1",
    })).rejects.toThrow(/endpoint_refused[\s\S]*insecure_transport/);
    // Naming the wrong adapter would create a row the gate can never see.
    await expect(ops.approveTrustedEndpoint({
      ...base, baseUrl: ENDPOINT_URL, adapterKind: "anthropic",
    })).rejects.toThrow(/adapter_kind_mismatch/);
    expect(await ops.listTrustedEndpoints()).toEqual([]);

    // Trailing slash + mixed case: stored normalized, the form the gate compares.
    const approved = await ops.approveTrustedEndpoint({
      ...base, provider: "  Example_Provider  ", baseUrl: "https://API.example-provider.com/v1/",
    });
    expect(approved).toMatchObject({ success: true, normalizedBaseUrl: ENDPOINT_URL });
    const endpointId = approved.endpointId;
    expect(typeof endpointId).toBe("number");
    expect(await db().select({ id: schema.trustedProviderEndpoints.id }).from(schema.trustedProviderEndpoints))
      .toHaveLength(1);

    const listed = await ops.listTrustedEndpoints();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      provider: "example_provider", baseUrl: ENDPOINT_URL, adapterKind: "openai_compatible",
      endpointClass: "first_party", protectionClass: "standard", loggingDisclosure: DISCLOSURE,
      policyVersion: "v2-egress-1", enabled: true, approvedBy: actorRow.id,
      approvedByUsername: actorRow.username, liveForGate: true, urlUnusable: null,
      adapterMatchesProvider: true,
    });
    expect(listed[0].matchKey).toBe(`example_provider ${ENDPOINT_URL} openai_compatible`);

    // Re-approving the same (provider, baseUrl) is refused: a reviewed
    // disclosure is never silently overwritten by a second approval.
    await expect(ops.approveTrustedEndpoint({ ...base, baseUrl: ENDPOINT_URL })).rejects.toThrow(/already_approved/);
    expect(await db().select({ id: schema.trustedProviderEndpoints.id }).from(schema.trustedProviderEndpoints))
      .toHaveLength(1);

    // The real gate: `assertTrustedEgress` resolves exactly the row approved
    // above, and hands back its disclosure. This is the step the drill was
    // stopping at while the table had no rows.
    const providerId = await seedProvider(payer.id);
    const [providerRow] = await db().select().from(schema.llmProviders).where(eq(schema.llmProviders.id, providerId)).limit(1);
    expect(await assertTrustedEgress({ provider: providerRow, payerId: payer.id })).toMatchObject({
      endpointId, provider: "example_provider", baseUrl: ENDPOINT_URL,
      adapterKind: "openai_compatible", protectionClass: "standard",
      loggingDisclosure: DISCLOSURE, policyVersion: "v2-egress-1",
    });

    // Disabling is the operator's lever, and the gate honours it immediately.
    await ops.setTrustedEndpointEnabled({ endpointId: endpointId as number, enabled: false });
    expect(await ops.listTrustedEndpoints({ enabledOnly: true })).toEqual([]);
    expect((await ops.listTrustedEndpoints())[0]).toMatchObject({ enabled: false, liveForGate: false });
    await expect(assertTrustedEgress({ provider: providerRow, payerId: payer.id })).rejects.toThrow(/endpoint_not_approved/);

    await ops.setTrustedEndpointEnabled({ endpointId: endpointId as number, enabled: true });
    const reEnabled = await ops.listTrustedEndpoints({ provider: "example_provider" });
    expect(reEnabled).toHaveLength(1);
    expect(reEnabled[0]).toMatchObject({ enabled: true, liveForGate: true });
    expect(await assertTrustedEgress({ provider: providerRow, payerId: payer.id })).toMatchObject({ endpointId });
  });

  it("sets the catalog vendor the D12 gate reads, and keeps every existing write rule", async () => {
    const actorRow = await actor("ops-catalog@example.test", "admin");
    const ops = as(actorRow);
    const catalog = catalogAs(actorRow);

    const empty = await ops.listModelCatalog({ page: 1, pageSize: 20 });
    expect(empty.items).toEqual([]);
    expect(empty.vendorMissingTotal).toBe(0);

    // A reviewed entry can carry its developer, and re-recording refreshes the
    // same row rather than duplicating it.
    const first = await catalog.recordModel({
      provider: "Example_Provider", modelId: "model-a", vendor: "DeepSeek", family: "v3",
    });
    expect(first.created).toBe(true);
    // A reviewed re-record refreshes the entry rather than duplicating it, and
    // its semantics are FULL REPLACEMENT: a field omitted from the re-record
    // goes back to NULL. That is exactly why a vendor correction has its own
    // narrow lever below instead of a re-record.
    expect(await catalog.recordModel({ provider: "example_provider", modelId: "model-a", vendor: "deepseek" }))
      .toEqual({ catalogId: first.catalogId, created: false });
    expect((await db().select({ id: schema.modelCatalog.id }).from(schema.modelCatalog))).toHaveLength(1);
    const [afterReRecord] = await db().select().from(schema.modelCatalog).where(eq(schema.modelCatalog.id, first.catalogId));
    expect(afterReRecord.family).toBeNull();
    await catalog.recordModel({ provider: "example_provider", modelId: "model-a", vendor: "DeepSeek", family: "v3" });

    // Lineage stays reviewed: an unknown predecessor and a predecessor from
    // another provider are both errors, not nulls.
    await expect(catalog.recordModel({
      provider: "example_provider", modelId: "model-b", successorOfModelId: "never-catalogued",
    })).rejects.toThrow(/unknown_predecessor/);
    await db().insert(schema.modelCatalog).values({ provider: "other", modelId: "model-o" });
    await expect(catalog.recordModel({
      provider: "example_provider", modelId: "model-b", successorOfModelId: "model-o",
    })).rejects.toThrow(/cross_provider_lineage/);
    expect(await db().select({ id: schema.modelCatalog.id }).from(schema.modelCatalog)).toHaveLength(2);

    // The field an evidence-panel refusal points a user at: now writable.
    expect(await ops.setModelVendor({ catalogId: first.catalogId, vendor: "  DeepSeek  " })).toEqual({
      success: true, vendor: "deepseek",
    });
    const listed = await ops.listModelCatalog({ page: 1, pageSize: 20, search: "model-a" });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      id: first.catalogId, provider: "example_provider", modelId: "model-a",
      vendor: "deepseek", family: "v3", availabilitySource: "admin_reviewed",
    });
    expect(Number(listed.items[0].releaseEventCount)).toBe(0);
    // The D12 consumer of the column, reached through the catalog as written.
    expect(await resolveModelVendors(["model-a", "model-o"])).toEqual({ "model-a": "deepseek", "model-o": null });

    // Only the vendor moved: the other reviewed fields are intact.
    const [stored] = await db().select().from(schema.modelCatalog).where(eq(schema.modelCatalog.id, first.catalogId));
    expect(stored).toMatchObject({ family: "v3", availabilitySource: "admin_reviewed", successorOfModelId: null });

    // "Missing vendor" is the filter an operator reaches for after a refusal.
    const missing = await ops.listModelCatalog({ page: 1, pageSize: 20, missingVendorOnly: true });
    expect(missing.items.map((i) => i.modelId)).toEqual(["model-o"]);
    expect(missing.vendorMissingTotal).toBe(1);
    expect((await ops.listModelCatalog({ page: 1, pageSize: 20 })).total).toBe(2);

    // Clearing is honest too: no recorded vendor means the gate cannot use the
    // identity, and it never collides with another model's vendor.
    await ops.setModelVendor({ catalogId: first.catalogId, vendor: null });
    expect(await resolveModelVendors(["model-a"])).toEqual({ "model-a": null });
    await ops.setModelVendor({ catalogId: first.catalogId, vendor: "deepseek" });
    await expect(ops.setModelVendor({ catalogId: 999_999, vendor: "nobody" })).rejects.toThrow(/catalog_entry_not_found/);

    // Release events show the reviewed identity they name.
    const event = await catalog.recordReleaseEvent({
      modelCatalogId: first.catalogId, eventKey: "fixture-release-1", relevanceRule: "same_model",
    });
    expect(event.created).toBe(true);
    // Two events on ONE catalog entry, and none on the other. This is the case
    // that separates "counted this entry's events" from "counted the event
    // whose own id happens to equal this row's id": a mis-scoped count would
    // report 1 and 1 here.
    await catalog.recordReleaseEvent({
      modelCatalogId: first.catalogId, eventKey: "fixture-release-2", relevanceRule: "same_family",
    });
    const events = await ops.listModelReleaseEvents({ page: 1, pageSize: 20 });
    expect(events.total).toBe(2);
    expect(events.items.map((e) => e.eventKey).sort()).toEqual(["fixture-release-1", "fixture-release-2"]);
    expect(events.items[0]).toMatchObject({
      relevanceRule: "same_family", modelId: "model-a",
      provider: "example_provider", vendor: "deepseek", recordedByUsername: actorRow.username,
    });
    const withEvents = await ops.listModelCatalog({ page: 1, pageSize: 20 });
    const counts = new Map(withEvents.items.map((i) => [i.modelId, Number(i.releaseEventCount)]));
    expect(counts.get("model-a")).toBe(2);
    expect(counts.get("model-o")).toBe(0);
  });

  it("renders a partially-priced benchmark as a floor with an unpriced count, never as a total", async () => {
    const actorRow = await actor("ops-spend@example.test", "admin");
    const payer = await actor("payer-spend@example.test", "user");
    const ops = as(actorRow);
    const seeded = await seedSpend(payer.id);

    const summary = await ops.spendSummary({ page: 1, pageSize: 20 });
    const byId = new Map(summary.benchmarks.map((b) => [b.benchmarkId, b]));
    const rowOf = (id: number) => {
      const row = byId.get(id);
      expect(row, `benchmark ${id} is missing from the spend summary`).toBeDefined();
      return row!;
    };

    // Fully priced: the figure is a fact.
    const complete = rowOf(seeded.meta);
    expect(complete.cost).toMatchObject({ knownUsd: "0.05000000", unpricedOperations: 0, completeness: "complete" });
    expect(complete.cost.display).toContain("$0.05000000");
    expect(complete.ownerUsername).toBe(payer.username);
    expect(complete.purpose).toBe("private_evaluation");

    // Partially priced: a floor, plus the count that is still unknown.
    const partial = rowOf(seeded.partial);
    expect(partial.totals).toMatchObject({ totalCalls: 4, pricedOperations: 2, uncertainCalls: 1 });
    expect(partial.cost.knownUsd).toBeNull();
    expect(partial.cost.pricedSoFarUsd).toBe("0.03000000");
    expect(partial.cost.unpricedOperations).toBe(2);
    expect(partial.cost.completeness).toBe("partial");
    expect(partial.cost.display).toMatch(/^At least \$0\.03000000/);
    expect(partial.cost.display).toContain("FLOOR");
    expect([...partial.cost.pricingBases].sort()).toEqual(["price_vector", "provider_list"]);

    // Nothing priceable at all: still not a claim that the run was free.
    const unpriced = rowOf(seeded.unpriced);
    expect(unpriced.cost.knownUsd).toBeNull();
    expect(unpriced.cost.unpricedOperations).toBe(2);
    expect(unpriced.cost.display).toContain("FLOOR");

    // THE discipline, stated as an invariant over every row on the screen:
    // while anything is unpriced, no dollar figure may be shown as the cost.
    expect(summary.benchmarks.length).toBeGreaterThanOrEqual(3);
    for (const row of summary.benchmarks) {
      if (row.cost.unpricedOperations > 0) expect(row.cost.knownUsd).toBeNull();
      expect(row.cost.display).not.toBe("$0.00");
      expect(row.cost.display).not.toMatch(/^ *\$0\.0+ /);
    }

    // Per-account and per-purpose: the same sentence, from the same function.
    const account = summary.byPayer.find((p) => p.payerId === payer.id);
    expect(account, "the paying account is missing").toBeDefined();
    expect(account!.username).toBe(payer.username);
    expect(account!.totalCalls).toBe(8);
    expect(account!.pricedOperations).toBe(4);
    expect(account!.uncertainCalls).toBe(1);
    expect(account!.cost.knownUsd).toBeNull();
    expect(account!.cost.pricedSoFarUsd).toBe("0.08250000");
    expect(account!.cost.unpricedOperations).toBe(4);
    expect(account!.cost.display).toContain("FLOOR");

    const purpose = summary.byPurpose.find((p) => p.purpose === "private_evaluation");
    expect(purpose).toMatchObject({ totalCalls: 8, pricedOperations: 4 });
    expect(purpose!.cost.unpricedOperations).toBe(4);
    expect(purpose!.cost.knownUsd).toBeNull();

    // The row no benchmark owns is named as its own bucket, not folded in.
    expect(summary.unattached).toHaveLength(1);
    expect(summary.unattached[0]).toMatchObject({ totalCalls: 1, pricedOperations: 1 });
    expect(summary.unattached[0].cost.knownUsd).toBe("0.00250000");

    // Frozen call plans, read-only.
    const approvals = await ops.listSpendApprovals({ page: 1, pageSize: 20 });
    expect(approvals.items).toHaveLength(1);
    expect(approvals.items[0]).toMatchObject({
      id: seeded.spendApprovalId, purpose: "private_evaluation", status: "active",
      payerUsername: payer.username, actorUsername: payer.username, spendCeilingUsd: "1.00",
      policyVersion: "v2-spend-1",
    });
    expect(Number(approvals.items[0].benchmarkCount)).toBe(3);
    const revoked = await ops.listSpendApprovals({ page: 1, pageSize: 20, status: "revoked" });
    expect(revoked).toMatchObject({ items: [], total: 0, page: 1, pageSize: 20 });

    // The ledger the screen read is the ledger it was handed: 8 rows, 4 of them
    // with no price, none of them changed.
    const [attemptCount] = await db().select({ total: count() }).from(schema.callAttempts);
    expect(Number(attemptCount.total)).toBe(8);
    expect(await db().select({ id: schema.callAttempts.id }).from(schema.callAttempts)
      .where(isNull(schema.callAttempts.estimatedCostUsd))).toHaveLength(4);
  });

  it("lists evidence publications and drills into the stored manifest without rewriting it", async () => {
    const actorRow = await actor("ops-evidence@example.test", "admin");
    const author = await actor("author-evidence@example.test", "user");
    const ops = as(actorRow);
    const [tpl] = await db().insert(schema.pipelineTemplates).values({
      userId: author.id, name: "fixture-template", steps: [],
    });
    const [listing] = await db().insert(schema.marketplaceListings).values({
      creatorId: author.id, templateId: insertId(tpl), title: "Fixture listing", price: "1.00", status: "published",
    });
    const listingId = insertId(listing);
    const [pub] = await db().insert(schema.evidencePublications).values({
      authorId: author.id, listingId, publicationKind: "seller", provenance: "platform_recorded",
      publicManifest: "{ not json", manifestHash: "a".repeat(64), consentVersion: "consent-v1",
      state: "published", testedAt: new Date("2026-01-05T00:00:00Z"),
    });
    const publicationId = insertId(pub);
    const [draft] = await db().insert(schema.evidencePublications).values({
      authorId: author.id, listingId, publicationKind: "community", provenance: "user_reported",
      publicManifest: "{}", manifestHash: "b".repeat(64), consentVersion: "consent-v1",
      state: "draft_preview", supersedesPublicationId: publicationId, testedAt: new Date("2026-01-06T00:00:00Z"),
    });
    const draftId = insertId(draft);

    const all = await ops.listEvidencePublications({ page: 1, pageSize: 20 });
    expect(all.total).toBe(2);
    expect(all.items.map((i) => i.id).sort((x, y) => x - y)).toEqual([publicationId, draftId].sort((x, y) => x - y));
    const sellerOnly = await ops.listEvidencePublications({ page: 1, pageSize: 20, publicationKind: "seller" });
    expect(sellerOnly.items).toHaveLength(1);
    expect(sellerOnly.items[0]).toMatchObject({
      id: publicationId, state: "published", publicationKind: "seller", listingId,
      authorUsername: author.username, manifestHash: "a".repeat(64), consentVersion: "consent-v1",
      benchmarkId: null, externalReportId: null, withdrawalReason: null, publishedAt: null,
    });
    const drafts = await ops.listEvidencePublications({ page: 1, pageSize: 20, state: "draft_preview" });
    expect(drafts.items.map((i) => i.id)).toEqual([draftId]);
    expect(drafts.items[0].supersedesPublicationId).toBe(publicationId);
    expect(await ops.listEvidencePublications({ page: 1, pageSize: 20, listingId: 987_654 })).toMatchObject({ items: [], total: 0 });

    const detail = await ops.evidencePublicationDetail({ publicationId });
    expect(detail.publication).toMatchObject({ id: publicationId, state: "published", provenance: "platform_recorded" });
    // A manifest that does not parse is reported as a fault, not handed over as
    // if it were a validated document.
    expect(detail.manifest).toBeNull();
    expect(detail.manifestError).toContain("not valid JSON");
    // The raw stored column is not part of the response shape.
    expect(detail.publication).not.toHaveProperty("publicManifest");
    await expect(ops.evidencePublicationDetail({ publicationId: 987_654 })).rejects.toThrow(/Publication not found/);

    // There is no admin withdrawal to reach: a publication is withdrawn by its
    // author through the evidence router, never from this screen. Checked on the
    // mounted router object, so a rename cannot quietly leave one behind.
    const procs = Object.keys(
      (adminRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures,
    );
    for (const name of Object.keys(adminProcedureNames)) expect(procs).toContain(name);
    expect(procs.filter((n) => /withdraw/i.test(n))).toEqual([]);
    const stored = await db().select().from(schema.evidencePublications);
    expect(stored.map((r) => `${r.id}|${r.state}|${String(r.withdrawnAt)}`).sort()).toEqual(
      [`${publicationId}|published|null`, `${draftId}|draft_preview|null`].sort(),
    );
  });

  it("refuses every non-admin caller, and writes nothing while being refused", async () => {
    const plain = await actor("not-admin@example.test", "user");
    const ops = as(plain);
    const catalog = catalogAs(plain);
    const base = {
      provider: "example_provider", baseUrl: ENDPOINT_URL, loggingDisclosure: DISCLOSURE,
      protectionClass: "standard" as const, policyVersion: "v2-egress-1",
    };
    const before = await tableCounts();

    await refuses(ops.listTrustedEndpoints(), "FORBIDDEN");
    await refuses(ops.approveTrustedEndpoint(base), "FORBIDDEN");
    await refuses(ops.setTrustedEndpointEnabled({ endpointId: 1, enabled: false }), "FORBIDDEN");
    await refuses(ops.listModelCatalog({ page: 1, pageSize: 20 }), "FORBIDDEN");
    await refuses(ops.setModelVendor({ catalogId: 1, vendor: "deepseek" }), "FORBIDDEN");
    await refuses(ops.listModelReleaseEvents({ page: 1, pageSize: 20 }), "FORBIDDEN");
    await refuses(ops.listEvidencePublications({ page: 1, pageSize: 20 }), "FORBIDDEN");
    await refuses(ops.evidencePublicationDetail({ publicationId: 1 }), "FORBIDDEN");
    await refuses(ops.spendSummary({ page: 1, pageSize: 20 }), "FORBIDDEN");
    await refuses(ops.listSpendApprovals({ page: 1, pageSize: 20 }), "FORBIDDEN");
    // The catalog write path stays admin-only at both layers.
    await refuses(catalog.recordModel({ provider: "example_provider", modelId: "nope", vendor: "nobody" }), "FORBIDDEN");

    // No session at all is a different refusal, and still a refusal.
    const anonymous = adminRouter.createCaller({ user: null } as Ctx);
    await refuses(anonymous.listTrustedEndpoints(), "UNAUTHORIZED");
    await refuses(anonymous.spendSummary({ page: 1, pageSize: 20 }), "UNAUTHORIZED");

    // Not one row was written by any refused call — including the audit trail.
    expect(await tableCounts()).toEqual(before);
  });

  it("leaves every table exactly as it found it across all read procedures", async () => {
    const actorRow = await actor("ops-readonly@example.test", "admin");
    const ops = as(actorRow);
    const before = await tableCounts();

    await ops.listTrustedEndpoints();
    await ops.listTrustedEndpoints({ enabledOnly: true });
    await ops.listModelCatalog({ page: 1, pageSize: 20 });
    await ops.listModelCatalog({ page: 1, pageSize: 20, missingVendorOnly: true, search: "model" });
    await ops.listModelReleaseEvents({ page: 1, pageSize: 20 });
    await ops.listEvidencePublications({ page: 1, pageSize: 20 });
    await ops.evidencePublicationDetail({ publicationId: 1 });
    await ops.spendSummary({ page: 1, pageSize: 20 });
    await ops.listSpendApprovals({ page: 1, pageSize: 20 });
    await ops.listAdminAuditLog({ page: 1, pageSize: 20 });
    await ops.listFeatureFlags();
    // The pre-existing raw-SQL reads (`systemStats`, `listUsers`,
    // `certificationQueue`) are deliberately not called here: they hand-write
    // snake_case column names, which exist in `swarm` via the migration files
    // but not in a `drizzle-kit push` schema built from schema.ts camelCase
    // names. That divergence predates this screen and is not what is under
    // test; every read BELOW is drizzle-typed and runs against the real tables.

    expect(await tableCounts()).toEqual(before);
  });
});

/** The exact set of procedures this task adds. Pinned so a later edit cannot
 *  quietly widen the screen: every name here is admin-guarded, and the refusal
 *  test calls each one. */
const adminProcedureNames = {
  listTrustedEndpoints: "query", approveTrustedEndpoint: "mutation", setTrustedEndpointEnabled: "mutation",
  listModelCatalog: "query", setModelVendor: "mutation", listModelReleaseEvents: "query",
  listEvidencePublications: "query", evidencePublicationDetail: "query",
  spendSummary: "query", listSpendApprovals: "query",
};

// ─── the correlated-count pinhole (task #36) ─────────────────────────
//
// drizzle emits an UNQUALIFIED column name when a Column is interpolated into a
// raw `sql` fragment — verified against `toSQL()`, which renders
// `projects.user_id = \`id\`` for `${users.id}`. MySQL resolves that bare name to
// the SUBQUERY's own table, so a correlated count silently becomes
// `projects.user_id = projects.id` and every row of the admin screen reports the
// same wrong number (or 0). These fixtures give each row a DIFFERENT true count,
// which is the only shape that distinguishes a correlation from a constant.
describe("admin counts that must correlate per row", () => {
  it("reports per-user project/run counts, per-listing review pools and per-entry waitlist positions", async () => {
    const heavy = await actor("heavy@countspinhole.test", "user");
    const light = await actor("light@countspinhole.test", "user");

    for (let i = 0; i < 3; i++) {
      await db().insert(schema.projects).values({ userId: heavy.id, name: `heavy project ${i}` });
    }
    const [lightProject] = await db().insert(schema.projects).values({ userId: light.id, name: "light project" });
    const heavyProjects = await db().select({ id: schema.projects.id }).from(schema.projects)
      .where(eq(schema.projects.userId, heavy.id));
    for (let i = 0; i < 2; i++) {
      await db().insert(schema.swarmRuns).values({
        userId: heavy.id, projectId: heavyProjects[i]!.id, userPrompt: `run ${i}`,
      });
    }
    void lightProject;

    const listed = await as(await actor("counter@countspinhole.test", "admin")).listUsers({ page: 1, search: "@countspinhole.test" });
    const byEmail = new Map(listed.users.map((u) => [u.email, u]));
    expect(Number(byEmail.get("heavy@countspinhole.test")!.projectCount)).toBe(3);
    expect(Number(byEmail.get("light@countspinhole.test")!.projectCount)).toBe(1);
    expect(Number(byEmail.get("heavy@countspinhole.test")!.runCount)).toBe(2);
    expect(Number(byEmail.get("light@countspinhole.test")!.runCount)).toBe(0);

    // Two listings whose review pools are deliberately different sizes.
    const [template] = await db().insert(schema.pipelineTemplates).values({
      userId: heavy.id, name: "countspinhole-template", steps: [{ name: "Draft", role: "builder", systemPrompt: "p" }],
    });
    const templateId = insertId(template);
    const [bigListing] = await db().insert(schema.marketplaceListings).values({
      creatorId: heavy.id, templateId, title: "Big pool", price: "1.00", status: "pending_review",
    });
    const [smallListing] = await db().insert(schema.marketplaceListings).values({
      creatorId: heavy.id, templateId, title: "Small pool", price: "2.00", status: "pending_review",
    });
    const bigId = insertId(bigListing), smallId = insertId(smallListing);
    await db().insert(schema.blindReviewTasks).values([
      { listingId: bigId, promptIndex: 0, status: "completed" },
      { listingId: bigId, promptIndex: 1, status: "completed" },
      { listingId: bigId, promptIndex: 2, status: "pooled" },
      { listingId: smallId, promptIndex: 0, status: "pooled" },
    ]);

    const queue = await as(await actor("queue@countspinhole.test", "admin")).certificationQueue();
    const big = queue.find((l: { id: number }) => l.id === bigId);
    const small = queue.find((l: { id: number }) => l.id === smallId);
    expect(Number(big!.poolTotal)).toBe(3);
    expect(Number(big!.poolCompleted)).toBe(2);
    expect(Number(small!.poolTotal)).toBe(1);
    expect(Number(small!.poolCompleted)).toBe(0);

    // Three waitlist entries: distinct positions, and one code referred twice.
    const totalBefore = (await db().select({ id: schema.waitlistEntries.id }).from(schema.waitlistEntries)).length;
    const codes = ["PINHOLE-A", "PINHOLE-B", "PINHOLE-C"];
    for (const [i, code] of codes.entries()) {
      await db().insert(schema.waitlistEntries).values({
        email: `waitlist${i}@countspinhole.test`, role: "creator", referralCode: code,
        ref: i === 0 ? null : "PINHOLE-A",
      });
    }
    const waitlist = await as(await actor("wl@countspinhole.test", "admin")).listWaitlist({ page: 1, search: "@countspinhole.test" });
    const rows = waitlist.items.filter((w: { email: string }) => w.email.endsWith("@countspinhole.test"));
    expect(rows.map((w: { position: number }) => Number(w.position)))
      .toEqual([totalBefore + 1, totalBefore + 2, totalBefore + 3]);
    expect(Number(rows[0]!.referralCount)).toBe(2);
    expect(Number(rows[1]!.referralCount)).toBe(0);
  });
});
