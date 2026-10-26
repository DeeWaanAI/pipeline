// DB-backed test for the two doors that remain: export your OWN pipeline to a
// file, and import somebody's file into your own account. The marketplace doors
// (purchase, fork-a-listing) were removed with the marketplace itself; these two
// are the whole sharing model now, so they carry the tests.
//
// Own throwaway schema per run, so it cannot collide with a parallel file.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { eq } from "drizzle-orm";

const TEST_DB = `swarm_v2test_bundle_${randomUUID().replaceAll("-", "")}`;
const ROOT_MYSQL = process.env.MYSQL_ROOT_URL || "mysql://root:rootpass@localhost:3307";
const SIGNING = generateKeyPairSync("ed25519");
const SIGNING_PUBLIC = SIGNING.publicKey.export({ type: "spki", format: "pem" }).toString();
const PARAMS = { enable_thinking: false, reasoning_effort: "low" };

let delivery: typeof import("./pipelineDelivery");
let bundleMod: typeof import("./pipelineBundle");
let schema: typeof import("@db/schema");
let admin: mysql.Connection;

beforeAll(async () => {
  const rootUrl = new URL(ROOT_MYSQL);
  if (!["localhost", "127.0.0.1"].includes(rootUrl.hostname) || rootUrl.port !== "3307"
    || !["", "/"].includes(rootUrl.pathname)) {
    throw new Error("Bundle tests require the local Docker MySQL endpoint with no database selected");
  }
  admin = await mysql.createConnection(ROOT_MYSQL);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  rootUrl.pathname = `/${TEST_DB}`;
  process.env.DATABASE_URL = rootUrl.toString();
  process.env.REDIS_URL = "";
  process.env.NODE_ENV = "development";
  process.env.APP_SECRET ||= "1".repeat(64);
  process.env.AI_SWARM_MASTER_KEY ||= "2".repeat(64);
  process.env.MARKETPLACE_MASTER_KEY ||= "3".repeat(64);
  process.env.EVIDENCE_SIGNING_PRIVATE_KEY = SIGNING.privateKey
    .export({ type: "pkcs8", format: "pem" }).toString().replace(/\n/g, "\\n");
  process.env.EVIDENCE_SIGNING_KEY_ID = "bundle-test-key";
  const { execFileSync } = await import("node:child_process");
  execFileSync(process.execPath, [
    fileURLToPath(new URL("../../node_modules/drizzle-kit/bin.cjs", import.meta.url)), "push", "--force",
  ], { env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL }, stdio: "pipe", timeout: 150_000 });
  delivery = await import("./pipelineDelivery");
  bundleMod = await import("./pipelineBundle");
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

async function authorWithPipeline(tag: string) {
  const d = await db();
  const [u] = await d.insert(schema.users).values({ name: "Author", email: `a-${tag}@example.test`, tier: "standard" });
  const authorId = Number((u as { insertId: number }).insertId);
  const [p] = await d.insert(schema.projects).values({
    userId: authorId, name: "Contract Redliner", description: "redlines an agreement",
    pipelineConfig: { maxIterations: 2 },
  });
  const projectId = Number((p as { insertId: number }).insertId);
  await d.insert(schema.pipelineSteps).values([
    {
      projectId, stepOrder: 1, name: "Draft", role: "builder", systemPrompt: "draft the clause",
      stepType: "agent", model: "model-a", temperature: "0.7", maxTokens: 1024, parameters: PARAMS,
    },
    { projectId, stepOrder: 2, name: "Polish", role: "polisher", systemPrompt: "tighten it", stepType: "agent", model: "model-a" },
  ]);
  return { authorId, projectId };
}

async function stranger(tag: string) {
  const d = await db();
  const [u] = await d.insert(schema.users).values({ name: "Recipient", email: `r-${tag}@example.test`, tier: "standard" });
  return Number((u as { insertId: number }).insertId);
}

describe("local sharing: export your own pipeline, import somebody's", () => {
  it("exports a signed file with no database wiring and with the step parameters intact", async () => {
    const { authorId, projectId } = await authorWithPipeline(`${Date.now()}`);
    const bundle = await delivery.exportOwnPipelineBundle(authorId, { projectId });

    expect(bundle.pipeline.steps).toHaveLength(2);
    expect(bundle.pipeline.steps[0].parameters).toEqual(PARAMS);
    expect(bundle.provenance.definitionHash).toBe(bundle.provenance.bundleHash);
    expect(bundle.evidence).toBeNull();
    expect(bundle.benchmark).toBeNull();
    // The file is self-verifying, and signed by the key we configured.
    const verdict = bundleMod.verifyPipelineBundle(bundle, SIGNING_PUBLIC);
    expect(verdict.valid).toBe(true);
    expect(verdict.provenanceState).toBe("signed");
    const text = JSON.stringify(bundle);
    for (const forbidden of ["providerId", "agentId", '"projectId"', '"userId"', '"id":']) {
      expect(text.includes(forbidden), forbidden).toBe(false);
    }
  });

  it("imports into another account: owned, attributed to nobody local, parameters preserved", async () => {
    const { authorId, projectId } = await authorWithPipeline(`${Date.now()}`);
    const bundle = await delivery.exportOwnPipelineBundle(authorId, { projectId });
    const recipient = await stranger(`${Date.now()}`);
    const imported = await delivery.importPipelineBundle(recipient, { bundle, name: "Received" });

    expect(imported.verification.valid).toBe(true);
    const d = await db();
    const [project] = await d.select().from(schema.projects).where(eq(schema.projects.id, imported.projectId));
    expect(project.userId).toBe(recipient);
    expect(project.name).toBe("Received");
    expect(project.originCreatorId).toBe(0);
    const steps = await d.select().from(schema.pipelineSteps)
      .where(eq(schema.pipelineSteps.projectId, imported.projectId))
      .orderBy(schema.pipelineSteps.stepOrder);
    expect(steps).toHaveLength(2);
    expect(steps.every((s) => s.providerId === null && s.agentId === null)).toBe(true);
    expect(steps[0].parameters).toEqual(PARAMS);
  });

  it("refuses edited steps even when the checksum is recomputed, and writes nothing", async () => {
    const { authorId, projectId } = await authorWithPipeline(`${Date.now()}`);
    const bundle = await delivery.exportOwnPipelineBundle(authorId, { projectId });
    const recipient = await stranger(`${Date.now()}`);
    const before = (await (await db()).select().from(schema.projects)).length;

    bundle.pipeline.steps = bundle.pipeline.steps.map((s) => ({ ...s, systemPrompt: "replaced" }));
    bundle.provenance.bundleHash = bundleMod.bundleIntegrityHash({
      steps: bundle.pipeline.steps,
      schemaVersion: bundle.provenance.schemaVersion,
      pipelineConfig: bundle.provenance.pipelineConfig,
    });
    await expect(delivery.importPipelineBundle(recipient, { bundle }))
      .rejects.toThrow(/bundle_attestation_does_not_describe_this_file/);
    expect((await (await db()).select().from(schema.projects)).length).toBe(before);
  });

  it("refuses to export a pipeline the caller does not own", async () => {
    const { projectId } = await authorWithPipeline(`${Date.now()}`);
    const recipient = await stranger(`${Date.now()}`);
    await expect(delivery.exportOwnPipelineBundle(recipient, { projectId }))
      .rejects.toThrow(/not_found_or_not_authorized/);
  });
});
