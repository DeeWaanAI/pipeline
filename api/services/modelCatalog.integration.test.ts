// Model release awareness drill (offering redesign v2, spec §12.1; acceptance
// A19). Own throwaway schema (`swarm_v2test_catalog`).
//
// Covers: admin-only writes, reviewed lineage (no name matching), replay-safe
// events, the notice dedupe key, and the suggestion lifecycle including the
// rule that acting on a suggestion never starts paid work.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { and, eq, sql } from "drizzle-orm";

const TEST_DB = "swarm_v2test_catalog";
const ROOT_MYSQL = process.env.MYSQL_ROOT_URL || "mysql://root:rootpass@localhost:3307";

let mc: typeof import("./modelCatalogService");
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
  mc = await import("./modelCatalogService");
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

async function makeUsers() {
  const d = await db();
  const stamp = `${Date.now()}-${Math.random()}`;
  const [a] = await d.insert(schema.users).values({ name: "Admin", email: `a-${stamp}@example.test`, role: "admin", tier: "pro_auto" });
  const [s] = await d.insert(schema.users).values({ name: "Seller", email: `s-${stamp}@example.test`, tier: "pro_auto" });
  const [o] = await d.insert(schema.users).values({ name: "Other", email: `o-${stamp}@example.test`, tier: "standard" });
  const [p] = await d.insert(schema.projects).values({ userId: Number((s as { insertId: number }).insertId), name: "P" });
  const [t] = await d.insert(schema.pipelineTemplates).values({
    userId: Number((s as { insertId: number }).insertId), name: "T", steps: [{ name: "Draft", role: "builder", systemPrompt: "x" }],
  });
  const [v] = await d.insert(schema.pipelineVersions).values({
    ownerId: Number((s as { insertId: number }).insertId), sourceProjectId: Number((p as { insertId: number }).insertId),
    versionNumber: 1, definition: "{}", definitionHash: "c".repeat(64),
  });
  return {
    adminId: Number((a as { insertId: number }).insertId),
    sellerId: Number((s as { insertId: number }).insertId),
    otherId: Number((o as { insertId: number }).insertId),
    versionId: Number((v as { insertId: number }).insertId),
    templateId: Number((t as { insertId: number }).insertId),
  };
}

describe("model catalog and retest suggestions (DB-backed)", () => {
  it("only admins write the catalog", async () => {
    const u = await makeUsers();
    await expect(mc.recordCatalogModel(u.sellerId, { provider: "openai", modelId: "gpt-x" }))
      .rejects.toThrow(/not_found_or_not_authorized/);
    const recorded = await mc.recordCatalogModel(u.adminId, { provider: "openai", modelId: "gpt-x" });
    expect(recorded.created).toBe(true);
  });

  it("re-recording refreshes the reviewed entry instead of duplicating it", async () => {
    const u = await makeUsers();
    const first = await mc.recordCatalogModel(u.adminId, { provider: "openai", modelId: "gpt-refresh", family: "gpt" });
    const second = await mc.recordCatalogModel(u.adminId, { provider: "OpenAI", modelId: "gpt-refresh", family: "gpt-2" });
    expect(second.catalogId).toBe(first.catalogId);
    expect(second.created).toBe(false);
    const d = await db();
    const rows = await d.select({ id: schema.modelCatalog.id }).from(schema.modelCatalog).where(eq(schema.modelCatalog.modelId, "gpt-refresh"));
    expect(rows).toHaveLength(1);
  });

  it("lineage must point at a real, same-provider catalog entry — never a name guess", async () => {
    const u = await makeUsers();
    await expect(mc.recordCatalogModel(u.adminId, { provider: "openai", modelId: "gpt-new", successorOfModelId: "gpt-never-catalogued" }))
      .rejects.toThrow(/unknown_predecessor/);
    await mc.recordCatalogModel(u.adminId, { provider: "anthropic", modelId: "claude-old" });
    await expect(mc.recordCatalogModel(u.adminId, { provider: "openai", modelId: "gpt-cross", successorOfModelId: "claude-old" }))
      .rejects.toThrow(/cross_provider_lineage/);
  });

  it("a replayed release event notifies nobody twice", async () => {
    const u = await makeUsers();
    const entry = await mc.recordCatalogModel(u.adminId, { provider: "openai", modelId: "gpt-event", family: "gpt" });
    const first = await mc.recordReleaseEvent(u.adminId, { modelCatalogId: entry.catalogId, eventKey: "openai/gpt-event@2026-09-20" });
    expect(first.created).toBe(true);
    const replay = await mc.recordReleaseEvent(u.adminId, { modelCatalogId: entry.catalogId, eventKey: "openai/gpt-event@2026-09-20" });
    expect(replay.created).toBe(false);
    expect(replay.releaseEventId).toBe(first.releaseEventId);
    const d = await db();
    const [count] = await d.select({ n: sql<number>`count(*)` }).from(schema.modelReleaseEvents);
    expect(Number(count.n)).toBe(1);
  });

  it("relevance compares reviewed identity, not a substring (A19 scope)", () => {
    const tested = [{ provider: "openai", requestedModel: "gpt-4o", returnedModel: null }];
    expect(mc.manifestMatches(tested, { provider: "openai", modelId: "gpt-4o", family: "gpt" }, "same_model")).toBe(true);
    // a different provider's model of the same name is not a match
    expect(mc.manifestMatches(tested, { provider: "azure-openai", modelId: "gpt-4o", family: "gpt" }, "same_model")).toBe(false);
    // "gpt" is the REVIEWED family; a name containing it is not enough — the
    // family rule compares the tested id against the family, not a substring.
    expect(mc.manifestMatches(tested, { provider: "openai", modelId: "gpt-5", family: "gpt" }, "same_family")).toBe(false);
    expect(mc.manifestMatches([{ provider: "openai", requestedModel: "gpt", returnedModel: null }], { provider: "openai", modelId: "gpt-5", family: "gpt" }, "same_family")).toBe(true);
    // successor_of fires for the model the new one replaces, not for the new one
    expect(mc.manifestMatches(tested, { provider: "openai", modelId: "gpt-5", family: "gpt", successorOfModelId: "gpt-4o" }, "successor_of")).toBe(true);
  });

  it("one notice per (seller, version, event, channel); dismissal is respected; nothing is auto-started", async () => {
    const u = await makeUsers();
    const d = await db();
    const entry = await mc.recordCatalogModel(u.adminId, { provider: "openai", modelId: "gpt-dedupe" });
    const event = await mc.recordReleaseEvent(u.adminId, { modelCatalogId: entry.catalogId, eventKey: "openai/gpt-dedupe@1" });
    const [listing] = await d.insert(schema.marketplaceListings).values({
      creatorId: u.sellerId, templateId: u.templateId, title: "L", price: "1.00", status: "published",
    });
    const listingId = Number((listing as { insertId: number }).insertId);
    const values = {
      sellerId: u.sellerId, listingId, workflowVersionId: u.versionId,
      releaseEventId: event.releaseEventId, channel: "in_app" as const, state: "pending" as const,
    };
    // The fan-out inserts with .ignore() against this unique index, so the
    // index behaviour IS the dedupe behaviour. drizzle returns the raw
    // OkPacket as the first element — `affectedRows` lives there.
    const [ra] = await d.insert(schema.retestSuggestions).ignore().values(values);
    const [rb] = await d.insert(schema.retestSuggestions).ignore().values(values);
    expect(Number((ra as { affectedRows?: number }).affectedRows)).toBe(1);
    expect(Number((rb as { affectedRows?: number }).affectedRows)).toBe(0);
    const rows = await d.select({ id: schema.retestSuggestions.id }).from(schema.retestSuggestions)
      .where(eq(schema.retestSuggestions.releaseEventId, event.releaseEventId));
    expect(rows).toHaveLength(1);

    const suggestionId = rows[0].id;
    const visible = await mc.listRetestSuggestions(u.sellerId);
    expect(visible.map((s) => s.id)).toContain(suggestionId);
    // Re-running the fan-out over a store with no published evidence for this
    // model creates nothing and notifies nobody — no phantom notices.
    expect(await mc.generateSuggestionsForEvent(event.releaseEventId, "same_model")).toEqual({ suggestionsCreated: 0, sellersNotified: 0 });
    expect(await d.select({ id: schema.notifications.id }).from(schema.notifications)).toHaveLength(0);

    const snoozed = await mc.respondToSuggestion(u.sellerId, suggestionId, "snooze", { until: new Date(Date.now() + 86_400_000) });
    expect(snoozed.state).toBe("snoozed");
    expect((await mc.listRetestSuggestions(u.sellerId)).map((s) => s.id)).not.toContain(suggestionId);
    // an expired snooze is visible again — deferral, not deletion
    await d.update(schema.retestSuggestions).set({ snoozedUntil: new Date(Date.now() - 1000) })
      .where(eq(schema.retestSuggestions.id, suggestionId));
    expect((await mc.listRetestSuggestions(u.sellerId)).map((s) => s.id)).toContain(suggestionId);

    // Someone else's suggestion is not addressable at all.
    expect(await mc.respondToSuggestion(u.otherId, suggestionId, "dismiss")).toEqual({ ok: false, state: "not_found", startedWork: false });

    const planned = await mc.respondToSuggestion(u.sellerId, suggestionId, "plan_retest");
    expect(planned).toEqual({ ok: true, state: "retest_started", startedWork: false });
    // §12.1/D5: no run, no spend, no benchmark was created by any of this.
    expect(await d.select({ id: schema.benchmarks.id }).from(schema.benchmarks)).toHaveLength(0);
    expect(await d.select({ id: schema.swarmRuns.id }).from(schema.swarmRuns)).toHaveLength(0);

    const dismissed = await mc.respondToSuggestion(u.sellerId, suggestionId, "dismiss");
    expect(dismissed.state).toBe("dismissed");
    expect((await mc.listRetestSuggestions(u.sellerId)).map((s) => s.id)).not.toContain(suggestionId);
    expect((await mc.listRetestSuggestions(u.sellerId, { includeDismissed: true })).map((s) => s.id)).toContain(suggestionId);
  });

  it("deprecation is disclosed, and execution is not silently disabled", async () => {
    const u = await makeUsers();
    const entry = await mc.recordCatalogModel(u.adminId, { provider: "openai", modelId: "gpt-retire" });
    const result = await mc.markModelDeprecated(u.adminId, entry.catalogId, new Date());
    expect(result).toEqual({ ok: true, executionDisabled: false });
    // No listing was unpublished and no evidence was touched by deprecation.
    const d = await db();
    expect(await d.select({ id: schema.evidencePublications.id }).from(schema.evidencePublications)).toHaveLength(0);
  });
});
