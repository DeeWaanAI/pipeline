// The instrument behind the local-archive decision: what we hold per account, and
// why. Its whole value is that the numbers are right, so the test seeds known
// bodies and checks the arithmetic — a silently-zero probe (a bad join, a mistyped
// column) would look like "you're not storing much" and get a deletion decision
// made on it.
//
// Throwaway schema of its own (`swarm_v2test_inventory`), local docker stack.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";

const TEST_DB = "swarm_v2test_inventory";
const ROOT_MYSQL = process.env.MYSQL_ROOT_URL || "mysql://root:rootpass@localhost:3307";

let admin: mysql.Connection;
let inv: typeof import("./storageInventory");
let schema: typeof import("@db/schema");
let db: any;
let owner = 0;
let stranger = 0;
let swarmRunId = 0;

async function pushSchema() {
  const { execFileSync } = await import("node:child_process");
  execFileSync("npx", ["drizzle-kit", "push", "--force"], {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    stdio: "ignore",
    timeout: 150_000,
  });
}

beforeAll(async () => {
  admin = await mysql.createConnection(ROOT_MYSQL);
  const [lock] = await admin.query<mysql.RowDataPacket[]>("SELECT GET_LOCK(?, 0) AS acquired", [TEST_DB]);
  if (!lock[0]?.acquired) throw new Error(`another run holds ${TEST_DB}`);
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

  inv = await import("./storageInventory");
  schema = await import("@db/schema");
  const { getDb } = await import("../queries/connection");
  db = getDb();

  const [u1] = await db.insert(schema.users).values({ username: `inv-a-${Date.now()}`, name: "A" });
  owner = Number((u1 as { insertId: number }).insertId);
  const [u2] = await db.insert(schema.users).values({ username: `inv-b-${Date.now()}`, name: "B" });
  stranger = Number((u2 as { insertId: number }).insertId);

  const [p] = await db.insert(schema.projects).values({ userId: owner, name: "Inv project" });
  const projectId = Number((p as { insertId: number }).insertId);

  // live-work: a 1,000-byte brief and a ~500-byte version definition
  const [r] = await db.insert(schema.swarmRuns).values({ projectId, userId: owner, userPrompt: "a".repeat(1000) });
  swarmRunId = Number((r as { insertId: number }).insertId);
  await db.insert(schema.pipelineVersions).values({
    ownerId: owner, versionNumber: 1, definition: JSON.stringify({ steps: "b".repeat(500) }),
    definitionHash: "b".repeat(64),
  });

  // research: one case with a 700-byte input
  const [b] = await db.insert(schema.benchmarks).values({ ownerId: owner, executionMode: "grade_only", state: "completed" });
  const benchmarkId = Number((b as { insertId: number }).insertId);
  await db.insert(schema.benchmarkCases).values({
    benchmarkId, stableCaseId: "case-1", caseOrder: 0, contentHash: "c".repeat(64), inputText: "d".repeat(700),
  });

  // hosted-for-others: a published manifest and a ledger row
  await db.insert(schema.evidencePublications).values({
    authorId: owner, testedAt: new Date(), consentVersion: "consent-v1", manifestHash: "e".repeat(64),
    publicManifest: JSON.stringify({ body: "f".repeat(300) }), provenance: "platform_recorded", publicationKind: "seller",
  });
  await db.insert(schema.callAttempts).values({
    operationId: 1, attemptIndex: 0, outcome: "success", requestedModel: "some-judge",
    payerId: owner, actorId: owner, purpose: "private_evaluation", operationKind: "judgment",
    errorMessage: "g".repeat(200),
  });
}, 240_000);

afterAll(async () => {
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.query(`REVOKE ALL PRIVILEGES ON \`${TEST_DB}\`.* FROM 'swarm'@'%'`);
    await admin.end();
  }
});

describe("the storage inventory", () => {
  it("counts each group's bytes where the content actually is", async () => {
    const { totals } = await inv.accountHoldings(owner);
    expect(totals["live-work"].bytes).toBeGreaterThanOrEqual(1500);
    expect(totals.research.bytes).toBeGreaterThanOrEqual(700);
    expect(totals["hosted-for-others"].bytes).toBeGreaterThanOrEqual(500);
    expect(totals["live-work"].rows).toBeGreaterThan(0);
  });

  it("separates what the user can take from what others rely on", async () => {
    const r = await inv.accountHoldings(owner);
    expect(r.sweepable).toBe(r.totals["live-work"].bytes + r.totals.research.bytes);
    expect(r.retained).toBe(r.totals["hosted-for-others"].bytes);
    expect(r.sweepable).toBeGreaterThan(r.retained);
    expect(r.items.reduce((a, i) => a + i.bytes, 0)).toBe(r.sweepable + r.retained);
  });

  it("names the reason for every group, in words a user can act on", async () => {
    const { items } = await inv.accountHoldings(owner);
    for (const item of items) {
      expect(item.note.length).toBeGreaterThan(20);
      expect(["live-work", "research", "hosted-for-others"]).toContain(item.group);
    }
    // The manifests are the ones that must survive a sweep, and the note says so.
    const manifest = items.find((i) => i.table === "evidence_publications")!;
    expect(manifest.group).toBe("hosted-for-others");
    expect(manifest.note.toLowerCase()).toContain("stays");
  });

  it("measures one account without reaching another's", async () => {
    const empty = await inv.accountHoldings(stranger);
    expect(empty.sweepable).toBe(0);
    expect(empty.retained).toBe(0);
    expect(empty.items.every((i) => i.rows === 0 && i.bytes === 0)).toBe(true);
  });

  it("treats an emptied body as zero bytes rather than a missing row", async () => {
    // `swarm_runs.user_prompt` is NOT NULL, so a sweep clears it rather than
    // nulling it. Either way the row must still be counted and the bytes must
    // fall to zero — that is how a user sees "1 run, no prompt text left"
    // instead of an unexplained gap.
    const { eq } = await import("drizzle-orm");
    await db.update(schema.swarmRuns).set({ userPrompt: "" }).where(eq(schema.swarmRuns.id, swarmRunId));
    const { items } = await inv.accountHoldings(owner);
    const runs = items.find((i) => i.table === "swarm_runs")!;
    expect(runs.rows).toBe(1);
    expect(runs.bytes).toBe(0);
  });

});
