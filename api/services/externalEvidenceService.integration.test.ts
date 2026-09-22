import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { count, eq } from "drizzle-orm";
import * as schema from "@db/schema";
import * as relations from "@db/relations";
import type { McpAuthContext } from "../mcp/types";

const isolated = vi.hoisted(() => ({ db: null as MySql2Database<typeof schema & typeof relations> | null }));
vi.mock("../queries/connection", () => ({
  getDb: () => {
    if (!isolated.db) throw new Error("Isolated external report database is not initialized");
    return isolated.db;
  },
}));

import * as external from "./externalEvidenceService";
import { resetFlagCache } from "../plugins/featureFlags";
import { communityEvidenceRouter } from "../routers/evidence";
import { EXTERNAL_EVIDENCE_TOOLS } from "../mcp/tools/externalEvidenceTools";

const TEST_DB = "swarm_v2test_external";
let admin: mysql.Connection | undefined;
let pool: mysql.Pool | undefined;
let ownsDatabase = false;

beforeAll(async () => {
  if (process.env.NODE_ENV === "production") throw new Error("External evidence tests refuse production mode");
  // Same local root URL (and same refusal-without-it convention) as every
  // other throwaway-DB integration file here.
  const url = new URL(process.env.MYSQL_ROOT_URL || "mysql://root:rootpass@localhost:3307");
  const connection = { host: url.hostname, port: Number(url.port || 3307), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  admin = await mysql.createConnection(connection);
  const [lock] = await admin.query<mysql.RowDataPacket[]>("SELECT GET_LOCK(?, 0) AS acquired", [TEST_DB]);
  if (lock[0].acquired !== 1) throw new Error("Another external evidence fixture is running");
  ownsDatabase = true;
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin.query(`CREATE DATABASE ${TEST_DB} CHARACTER SET utf8mb4`);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const pushUrl = new URL(`mysql://${connection.user}@${connection.host}:${connection.port}/${TEST_DB}`);
  pushUrl.password = connection.password;
  execFileSync(process.execPath, [fileURLToPath(new URL("../../node_modules/drizzle-kit/bin.cjs", import.meta.url)), "push", "--force"], {
    cwd: root,
    env: { PATH: process.env.PATH, NODE_ENV: "test", DATABASE_URL: pushUrl.toString(), DOTENV_CONFIG_PATH: "/dev/null" },
    stdio: "pipe", timeout: 150_000,
  });
  pool = mysql.createPool({ ...connection, database: TEST_DB, connectionLimit: 4 });
  isolated.db = drizzle(pool, { schema: { ...schema, ...relations }, mode: "default" });
  await isolated.db.insert(schema.featureFlags).values({ key: "v2Publication", name: "External report fixture", enabled: true, rolloutPercent: 0 });
  resetFlagCache();
}, 180_000);

afterAll(async () => {
  isolated.db = null;
  resetFlagCache();
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

async function setFlag(enabled: boolean) {
  await db().update(schema.featureFlags).set({ enabled }).where(eq(schema.featureFlags.key, "v2Publication"));
  resetFlagCache();
}

async function fixture() {
  const stamp = `${Date.now()}-${Math.random()}`;
  const [seller] = await db().insert(schema.users).values({ name: "Seller", email: `seller-${stamp}@example.test` });
  const [author] = await db().insert(schema.users).values({ name: "External tester", email: `external-${stamp}@example.test` });
  const sellerId = Number(seller.insertId);
  const userId = Number(author.insertId);
  const [template] = await db().insert(schema.pipelineTemplates).values({ userId: sellerId, name: "Fixture", steps: [] });
  const templateId = Number(template.insertId);
  const [version] = await db().insert(schema.pipelineVersions).values({
    ownerId: sellerId, sourceTemplateId: templateId, versionNumber: 1,
    definition: '{"privatePrompt":"PRIVATE_DEFINITION_SENTINEL"}', definitionHash: "a".repeat(64),
  });
  const workflowVersionId = Number(version.insertId);
  const [listing] = await db().insert(schema.marketplaceListings).values({
    creatorId: sellerId, templateId, title: "Public v2 fixture", price: "1.00", status: "published",
  });
  const listingId = Number(listing.insertId);
  const [publication] = await db().insert(schema.evidencePublications).values({
    authorId: sellerId, listingId, listingWorkflowVersionId: workflowVersionId,
    publicationKind: "seller", provenance: "platform_recorded", publicManifest: "{}",
    manifestHash: "b".repeat(64), consentVersion: "fixture", state: "published", testedAt: new Date("2025-01-01"),
  });
  const publicationId = Number(publication.insertId);
  await db().insert(schema.marketplaceListingV2).values({
    listingId, publicationMode: "v2", currentWorkflowVersionId: workflowVersionId,
    currentEvidencePublicationId: publicationId, evidenceSummaryRevision: 1,
  });
  const input = {
    listingId, workflowVersionId, declaredInputs: "A question", declaredOutputs: "An externally obtained answer",
    declaredModel: "author-named model", declaredDate: "sometime last winter", declaredRubric: "My own criteria",
    notes: "Not a platform run", consentVersion: external.EXTERNAL_CONSENT_VERSION,
  } as const;
  return { userId, sellerId, listingId, workflowVersionId, publicationId, input };
}

async function rowsIn(table: typeof schema.externalEvidenceReports | typeof schema.benchmarks | typeof schema.benchmarkRuns |
  typeof schema.benchmarkJudgments | typeof schema.callAttempts | typeof schema.evidencePublications | typeof schema.swarmRuns) {
  const [result] = await db().select({ total: count() }).from(table);
  return result.total;
}

async function measurementCounts() {
  return Promise.all([
    schema.benchmarks, schema.benchmarkRuns, schema.benchmarkJudgments, schema.callAttempts, schema.evidencePublications, schema.swarmRuns,
  ].map(rowsIn));
}

async function listingState(listingId: number) {
  return {
    listing: await db().select().from(schema.marketplaceListings).where(eq(schema.marketplaceListings.id, listingId)),
    v2: await db().select().from(schema.marketplaceListingV2).where(eq(schema.marketplaceListingV2.listingId, listingId)),
  };
}

async function publish(f: Awaited<ReturnType<typeof fixture>>, patch = {}) {
  const input = { ...f.input, ...patch };
  const preview = await external.previewExternal(f.userId, input);
  return external.reportExternal(f.userId, { ...input, previewHash: preview.previewHash, publishConsent: true });
}

describe("external community reports (isolated localhost MySQL)", () => {
  it("previews stable normalized content without writes or private version disclosure", async () => {
    const f = await fixture();
    const before = await measurementCounts();
    const reports = await rowsIn(schema.externalEvidenceReports);
    const first = await external.previewExternal(f.userId, { ...f.input, declaredInputs: "  cafe\u0301\r\nline  " });
    const second = await external.previewExternal(f.userId, { ...f.input, declaredInputs: "café\nline" });
    expect(second).toEqual(first);
    expect(first.previewHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.report.provenance).toBe("user_reported");
    expect(first.report.verificationNotice).toContain("not independently verified");
    expect(first.secretFindings).toEqual([]);
    expect(JSON.stringify(first)).not.toContain("PRIVATE_DEFINITION_SENTINEL");
    expect(await measurementCounts()).toEqual(before);
    expect(await rowsIn(schema.externalEvidenceReports)).toBe(reports);
  });

  it("writes only the external report and exposes its declarations, not platform measurements", async () => {
    const f = await fixture();
    const counts = await measurementCounts();
    const listing = await listingState(f.listingId);
    const result = await publish(f);
    const read = await external.getExternal({ reportId: result.report.reportId });
    expect(read).toEqual(result.report);
    expect(await external.listExternal({ listingId: f.listingId })).toEqual([read]);
    expect(read).toMatchObject({ provenance: "user_reported", declaredDate: "sometime last winter", authorId: f.userId });
    expect(read?.verificationNotice).toContain("not independently verified");
    expect(read?.reportedAt).toMatch(/^\d{4}-/);
    for (const key of ["testedAt", "manifest", "publicManifest", "score", "attestation", "benchmarkId", "attachments", "definition"]) {
      expect(read).not.toHaveProperty(key);
    }
    const [stored] = await db().select().from(schema.externalEvidenceReports).where(eq(schema.externalEvidenceReports.id, result.report.reportId));
    expect(stored.attachments).toBeNull();
    expect(stored.declaredDate).toBe(f.input.declaredDate);
    expect(await measurementCounts()).toEqual(counts);
    expect(await listingState(f.listingId)).toEqual(listing);
  });

  it("enforces the publication flag in the service, including direct MCP calls, without disabling reads", async () => {
    const f = await fixture();
    const existing = await publish(f);
    const preview = await external.previewExternal(f.userId, f.input);
    const args = { ...f.input, previewHash: preview.previewHash, publishConsent: true };
    const countBefore = await rowsIn(schema.externalEvidenceReports);
    await setFlag(false);
    try {
      await expect(external.reportExternal(f.userId, args)).rejects.toThrow("publication_disabled");
      await expect(EXTERNAL_EVIDENCE_TOOLS[1].handler(args, { userId: f.userId } as McpAuthContext)).rejects.toThrow("publication_disabled");
      expect(await external.previewExternal(f.userId, f.input)).toEqual(preview);
      expect(await external.getExternal({ reportId: existing.report.reportId })).not.toBeNull();
      expect(await external.listExternal({ listingId: f.listingId })).toHaveLength(1);
      expect(await rowsIn(schema.externalEvidenceReports)).toBe(countBefore);
    } finally {
      await setFlag(true);
    }
  });

  it("binds every declared field, target and author to consented bytes", async () => {
    const f = await fixture();
    const other = await fixture();
    const preview = await external.previewExternal(f.userId, f.input);
    const args = { ...f.input, previewHash: preview.previewHash, publishConsent: true };
    const before = await rowsIn(schema.externalEvidenceReports);
    for (const field of ["declaredInputs", "declaredOutputs", "declaredModel", "declaredDate", "declaredRubric", "notes"] as const) {
      await expect(external.reportExternal(f.userId, { ...args, [field]: "changed" })).rejects.toThrow("preview_changed");
    }
    await expect(external.reportExternal(f.userId, { ...args, workflowVersionId: null })).rejects.toThrow("preview_changed");
    await expect(external.reportExternal(f.userId, { ...args, listingId: other.listingId, workflowVersionId: other.workflowVersionId })).rejects.toThrow("preview_changed");
    await expect(external.reportExternal(other.userId, args)).rejects.toThrow("preview_changed");
    await expect(external.reportExternal(f.userId, { ...args, previewHash: "0".repeat(64) })).rejects.toThrow("preview_changed");
    await expect(external.reportExternal(f.userId, { ...args, consentVersion: "unsupported" })).rejects.toThrow();
    await expect(external.reportExternal(f.userId, { ...args, publishConsent: false })).rejects.toThrow();
    expect(await rowsIn(schema.externalEvidenceReports)).toBe(before);
  });

  it("detects secrets in every declared field, including quoted values, and never echoes matches in refusals", async () => {
    const f = await fixture();
    const before = await rowsIn(schema.externalEvidenceReports);
    const secret = 'password="exampleSecret123456789"';
    for (const field of ["declaredInputs", "declaredOutputs", "declaredModel", "declaredDate", "declaredRubric", "notes"] as const) {
      const input = { ...f.input, [field]: secret };
      const preview = await external.previewExternal(f.userId, input);
      expect(preview.secretFindings).toContain("assignment of a secret-looking value");
      expect(preview.secretFindings.join(" ")).not.toContain("exampleSecret123456789");
      await expect(external.reportExternal(f.userId, { ...input, previewHash: preview.previewHash, publishConsent: true }))
        .rejects.toThrow(/^publication_refused: redact assignment of a secret-looking value before publishing$/);
    }
    expect(await rowsIn(schema.externalEvidenceReports)).toBe(before);
  });

  it("gives the same refusal for private, unrelated and nonexistent versions or listings", async () => {
    const f = await fixture();
    const other = await fixture();
    const [privateVersion] = await db().insert(schema.pipelineVersions).values({
      ownerId: f.sellerId, versionNumber: 2, definition: "PRIVATE_UNPUBLISHED_SENTINEL", definitionHash: "c".repeat(64),
    });
    const before = await rowsIn(schema.externalEvidenceReports);
    for (const patch of [
      { workflowVersionId: Number(privateVersion.insertId) }, { workflowVersionId: other.workflowVersionId },
      { workflowVersionId: 2_147_483_647 }, { listingId: 2_147_483_647 }, { listingId: other.listingId },
    ]) {
      const input = { ...f.input, ...patch };
      await expect(external.previewExternal(f.userId, input)).rejects.toThrow(/^not_found_or_not_authorized$/);
      await expect(external.reportExternal(f.userId, { ...input, previewHash: "0".repeat(64), publishConsent: true }))
        .rejects.toThrow(/^not_found_or_not_authorized$/);
    }
    expect(await rowsIn(schema.externalEvidenceReports)).toBe(before);
  });

  it("refuses legacy, nonpublic and unbacked listing targets even for the seller", async () => {
    const f = await fixture();
    for (const status of ["draft", "unpublished", "certifying"] as const) {
      await db().update(schema.marketplaceListings).set({ status }).where(eq(schema.marketplaceListings.id, f.listingId));
      await expect(external.previewExternal(f.sellerId, f.input)).rejects.toThrow(/^not_found_or_not_authorized$/);
    }
    await db().update(schema.marketplaceListings).set({ status: "published" }).where(eq(schema.marketplaceListings.id, f.listingId));
    await db().update(schema.marketplaceListingV2).set({ publicationMode: "legacy" }).where(eq(schema.marketplaceListingV2.listingId, f.listingId));
    await expect(external.previewExternal(f.userId, f.input)).rejects.toThrow("not_found_or_not_authorized");
    await db().update(schema.marketplaceListingV2).set({ publicationMode: "v2", currentEvidencePublicationId: null })
      .where(eq(schema.marketplaceListingV2.listingId, f.listingId));
    await expect(external.previewExternal(f.userId, f.input)).rejects.toThrow("not_found_or_not_authorized");
    await db().update(schema.marketplaceListingV2).set({ currentEvidencePublicationId: f.publicationId })
      .where(eq(schema.marketplaceListingV2.listingId, f.listingId));
    await db().update(schema.evidencePublications).set({ state: "withdrawn" }).where(eq(schema.evidencePublications.id, f.publicationId));
    await expect(external.previewExternal(f.userId, f.input)).rejects.toThrow("not_found_or_not_authorized");
  });

  it("rechecks accessibility after preview and hides reports when the listing ceases to be public", async () => {
    const f = await fixture();
    const existing = await publish(f);
    const preview = await external.previewExternal(f.userId, f.input);
    await db().update(schema.marketplaceListings).set({ status: "unpublished" }).where(eq(schema.marketplaceListings.id, f.listingId));
    const before = await rowsIn(schema.externalEvidenceReports);
    await expect(external.reportExternal(f.userId, { ...f.input, previewHash: preview.previewHash, publishConsent: true }))
      .rejects.toThrow("not_found_or_not_authorized");
    expect(await rowsIn(schema.externalEvidenceReports)).toBe(before);
    expect(await external.getExternal({ reportId: existing.report.reportId })).toBeNull();
    expect(await external.getExternal({ reportId: 2_147_483_647 })).toBeNull();
    expect(await external.listExternal({ listingId: f.listingId })).toEqual([]);
    expect(await external.listExternal({ listingId: 2_147_483_647 })).toEqual([]);
  });

  it("supports listing-only declarations and bounded stable pagination", async () => {
    const f = await fixture();
    const one = await publish(f, { workflowVersionId: undefined });
    const two = await publish(f, { notes: "Second report" });
    const three = await publish(f, { notes: "Third report" });
    expect(one.report.workflowVersionId).toBeNull();
    const first = await external.listExternal({ listingId: f.listingId, limit: 2 });
    expect(first.map((report) => report.reportId)).toEqual([three.report.reportId, two.report.reportId]);
    expect(await external.listExternal({ listingId: f.listingId, beforeId: two.report.reportId, limit: 2 })).toEqual([one.report]);
  });

  it("uses the same preview and writer through tRPC and MCP", async () => {
    const f = await fixture();
    const [user] = await db().select().from(schema.users).where(eq(schema.users.id, f.userId));
    const caller = communityEvidenceRouter.createCaller({ user } as Parameters<typeof communityEvidenceRouter.createCaller>[0]);
    const ctx = { userId: f.userId, scopes: new Set(["mcp:read", "mcp:write"]), clientId: "fixture", requestId: "external-fixture", locale: "en" } satisfies McpAuthContext;
    const preview = await caller.previewExternal(f.input);
    expect(await EXTERNAL_EVIDENCE_TOOLS[0].handler(f.input, ctx)).toMatchObject(preview);
    const published = await caller.reportExternal({ ...f.input, previewHash: preview.previewHash, publishConsent: true });
    expect(await EXTERNAL_EVIDENCE_TOOLS[2].handler({ reportId: published.report.reportId }, ctx)).toEqual(published.report);
    expect(await EXTERNAL_EVIDENCE_TOOLS[3].handler({ listingId: f.listingId }, ctx)).toEqual([published.report]);
    expect(await caller.getExternal({ reportId: published.report.reportId })).toEqual(published.report);
    expect(await caller.listExternal({ listingId: f.listingId })).toEqual([published.report]);
  });
});
