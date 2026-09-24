// Pipeline sharing + publish lineage — DB-backed integration battery (owner
// decisions, 2026-09-22).
//
// What this proves, with NO LLM CALL ANYWHERE (the provider adapter is the only
// mock, exactly as in a12Leakage):
//  1. a `run_only` grant lets the recipient RUN the pipeline and returns them
//     no prompt text — a distinctive secret sits in a step's system prompt and
//     the fake adapter ECHOES it into that step's output, so the redaction
//     assertions are doing real work rather than the model never having seen
//     the text (the A12 pattern);
//  2. a `full` grant lets them READ but not MODIFY, until `canModify` is true;
//  3. revoking removes access immediately — including a run that was already
//     queued, which stops at the grant re-check before its first call;
//  4. a recipient, even `full` + `canModify`, is refused at BOTH publish
//     boundaries, and the refusal is a plain code plus what to do instead;
//  5. the original creator can still publish, and a clone carries their
//     lineage forward as data;
//  6. a pre-lineage version resolves to "owner is the original creator" and is
//     not newly blocked.
//
// Own throwaway schema (`swarm_v2test_share`) + GET_LOCK: vitest runs files in
// parallel and every integration file here gets its own database.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import { and, eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import * as schema from "@db/schema";
import * as relations from "@db/relations";
import type { McpAuthContext } from "../mcp/types";

const TEST_DB = "swarm_v2test_share";

/** Distinctive fragments, so a leak cannot be a false positive on common words. */
const SECRET = "SHAREOWNER PROMPT CHARLIE: read /vault/deeds and sign with key sk-SHARE-7f3d9a";
const SECRET_MARKERS = /SHAREOWNER|sk-SHARE|vault\/deeds/;
const FINAL_TEXT = "The deed is translated into French.";
const OWNER_KEY = "sk-owner-OWN-KEY-1234567890123";
const GRANTEE_KEY = "sk-grantee-OWN-KEY-123456789012";

type SeenCall = { slug: string; apiKey: string; baseUrl: string; system: string; model: string | undefined };
const seen = vi.hoisted(() => ({ calls: [] as SeenCall[] }));
const isolated = vi.hoisted(() => ({ db: null as MySql2Database<typeof schema & typeof relations> | null }));

vi.mock("../queries/connection", () => ({
  getDb: () => {
    if (!isolated.db) throw new Error("Isolated sharing test database is not initialized");
    return isolated.db;
  },
}));

// The only adapter in the process: asserting on `seen.calls` is therefore
// proof that no real provider was contacted, and the echo makes the hardest
// leakage case real — a stored intermediate that CONTAINS the secret.
vi.mock("../lib/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/providers")>();
  return {
    ...actual,
    createProviderAdapter: (slug: string, apiKey: string, baseUrl: string, defaultModel: string) => ({
      name: "Fake", slug, defaultBaseUrl: baseUrl, supportedModels: [defaultModel],
      async chat(messages: Array<{ role: string; content: string }>, options?: { model?: string }) {
        const system = String(messages[0]?.content ?? "");
        seen.calls.push({ slug, apiKey, baseUrl, system, model: options?.model });
        return {
          content: system.includes("SHAREOWNER") ? `ECHO: ${system}` : FINAL_TEXT,
          // A real host names the model it SERVED, which is the one that was
          // asked for. Reporting the adapter's own default instead would hide
          // the case the model withholding exists for: a `run_only` recipient
          // whose step row carries the grantor's pinned model name.
          usage: { promptTokens: 9, completionTokens: 4, totalTokens: 13, complete: true },
          model: options?.model ?? defaultModel, latencyMs: 3,
        };
      },
      async validateKey() { return { valid: true }; },
      async listModels() { return [defaultModel]; },
    }),
  };
});

// The slot allocator prorates a brand-new window to one call, so a two-step run
// in the same millisecond would throttle on step 2. Rate limiting is not what
// this battery is about.
vi.mock("../lib/providerThrottle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/providerThrottle")>();
  return {
    ...actual,
    acquireProviderSlot: async () => ({ ok: true as const }),
    reportProviderResult: async () => undefined,
  };
});

let share: typeof import("./pipelineSharing");
let lineage: typeof import("./workflowLineage");
let sw: typeof import("./swarmService");
let appMod: typeof import("../router");
let TOOLS: typeof import("../mcp/tools/index").TOOLS;
let encryptKey: (plain: string) => string;
let admin: mysql.Connection | undefined;
let pool: mysql.Pool | undefined;
let ownsDatabase = false;

beforeAll(async () => {
  if (process.env.NODE_ENV === "production") throw new Error("Pipeline sharing tests refuse production mode");
  process.env.NODE_ENV = "development";
  process.env.REDIS_URL = "";
  process.env.APP_SECRET ||= "1".repeat(64);
  process.env.AI_SWARM_MASTER_KEY ||= "2".repeat(64);
  process.env.MARKETPLACE_MASTER_KEY ||= "3".repeat(64);

  // Same local root URL (and same refusal-without-it convention) as every other
  // throwaway-DB integration file here.
  const url = new URL(process.env.MYSQL_ROOT_URL || "mysql://root:rootpass@localhost:3307");
  const connection = { host: url.hostname, port: Number(url.port || 3307), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  admin = await mysql.createConnection(connection);
  const [lock] = await admin.query<mysql.RowDataPacket[]>("SELECT GET_LOCK(?, 0) AS acquired", [TEST_DB]);
  if (lock[0].acquired !== 1) throw new Error("Another pipeline-sharing fixture is running");
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

  share = await import("./pipelineSharing");
  lineage = await import("./workflowLineage");
  sw = await import("./swarmService");
  appMod = await import("../router");
  TOOLS = (await import("../mcp/tools/index")).TOOLS;
  const crypto = await import("./cryptoService");
  encryptKey = (plain) => crypto.encrypt(plain, crypto.getMasterKey()).encrypted;
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

/** Feature flags are read from the DB through the flag cache; the v2 publish
 *  boundary checks one, so a test that drives it has to be able to say so. */
async function setFlag(key: string, enabled: boolean) {
  const d = db();
  const [existing] = await d.select({ id: schema.featureFlags.id }).from(schema.featureFlags)
    .where(eq(schema.featureFlags.key, key)).limit(1);
  if (existing) await d.update(schema.featureFlags).set({ enabled }).where(eq(schema.featureFlags.id, existing.id));
  else await d.insert(schema.featureFlags).values({ key, name: key, description: "test", enabled, rolloutPercent: 0 });
  (await import("../plugins/featureFlags")).resetFlagCache();
}

type UserRow = schema.User;

async function mkUser(label: string): Promise<UserRow> {
  const stamp = `${Date.now()}-${Math.random()}`;
  const [res] = await db().insert(schema.users).values({ name: label, email: `${label}-${stamp}@example.test`, tier: "standard" });
  const [row] = await db().select().from(schema.users).where(eq(schema.users.id, Number((res as { insertId: number }).insertId))).limit(1);
  return row;
}

/** The owner's pipeline: two steps, the first carrying the secret, bound to the
 *  OWNER's provider and pinning `owner-model`, so a run that used either instead
 *  of the recipient's own would be visible in `seen.calls`. */
async function fixture(mode: "run_only" | "full" = "run_only", canModify = false) {
  const owner = await mkUser("Share owner");
  const grantee = await mkUser("Share recipient");
  const outsider = await mkUser("Share outsider");

  const [ownerProvider] = await db().insert(schema.llmProviders).values({
    userId: owner.id, name: `owner-${owner.id}`, slug: "openai", baseUrl: "https://api.owner.test/v1",
    apiKeyRef: encryptKey(OWNER_KEY), defaultModel: "owner-model",
  });
  const [granteeProvider] = await db().insert(schema.llmProviders).values({
    userId: grantee.id, name: `grantee-${grantee.id}`, slug: "openai", baseUrl: "https://api.grantee.test/v1",
    apiKeyRef: encryptKey(GRANTEE_KEY), defaultModel: "grantee-model",
  });

  const [project] = await db().insert(schema.projects).values({ userId: owner.id, name: `Lender pipeline ${owner.id}` });
  const projectId = Number((project as { insertId: number }).insertId);
  await db().insert(schema.pipelineSteps).values([
    {
      projectId, stepOrder: 1, stepType: "agent", name: "Draft", role: "builder",
      systemPrompt: SECRET, isEnabled: true,
      providerId: Number((ownerProvider as { insertId: number }).insertId), model: "owner-model",
    },
    {
      projectId, stepOrder: 2, stepType: "agent", name: "Polish", role: "polisher",
      systemPrompt: "Make the translation presentation-ready.", isEnabled: true,
      providerId: Number((ownerProvider as { insertId: number }).insertId), model: "owner-model",
    },
  ]);
  const [template] = await db().insert(schema.pipelineTemplates).values({
    userId: owner.id, name: `tpl-${projectId}`, sourceProjectId: projectId,
    steps: [{ name: "Draft", role: "builder", systemPrompt: SECRET }],
  });
  const templateId = Number((template as { insertId: number }).insertId);
  // A publishable pipeline is one its owner saved as a template, which is what
  // `publish_to_marketplace` requires before it reaches any gate.
  await db().update(schema.projects).set({ pipelineTemplateId: templateId }).where(eq(schema.projects.id, projectId));
  const grant = mode === "run_only" && !canModify
    ? await share.sharePipeline(owner.id, { projectId, granteeId: grantee.id, mode })
    : await share.sharePipeline(owner.id, { projectId, granteeId: grantee.id, mode, canModify });

  return {
    owner, grantee, outsider, projectId,
    templateId,
    ownerProviderId: Number((ownerProvider as { insertId: number }).insertId),
    granteeProviderId: Number((granteeProvider as { insertId: number }).insertId),
    grant,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Runs the shared pipeline for the recipient through the REAL interpreter. */
async function runShared(f: Fixture, opts: { dispatch?: (runId: number, userId: number) => Promise<void> } = {}) {
  seen.calls.length = 0;
  const receipt = await share.startSharedRun({
    granteeId: f.grantee.id, projectId: f.projectId, input: "Translate clause 4.",
    providerId: f.granteeProviderId,
    dispatch: opts.dispatch ?? (async (runId, userId) => { await sw.executeSwarmRun({ swarmRunId: runId, userId }); }),
  });
  const [run] = await db().select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, receipt.swarmRunId)).limit(1);
  return { receipt, run };
}

/** Everything the recipient's own surfaces can return about the shared
 *  pipeline and their run of it, serialised for one leak scan. */
async function recipientVisiblePayloads(f: Fixture, swarmRunId: number): Promise<Record<string, string>> {
  const caller = (user: UserRow) => appMod.appRouter.createCaller({
    req: new Request("http://localhost"), resHeaders: new Headers(),
    user, requestId: `share-${user.id}`,
  }) as unknown as Record<string, Record<string, (input: Record<string, unknown>) => Promise<unknown>>>;
  const ctx = (userId: number): McpAuthContext => ({
    userId, scopes: new Set(["mcp:read", "mcp:run", "mcp:write"]),
    clientId: "share-test", requestId: `share-${userId}`, locale: "en",
  });
  const tool = (name: string) => {
    const found = TOOLS.find((t) => t.name === name);
    if (!found) throw new Error(`MCP tool ${name} is not registered`);
    return found;
  };
  // The recipient's container project is where their shared run lives, and it
  // holds no copy of the definition — read the project-scoped surfaces on it.
  const [run] = await db().select({ projectId: schema.swarmRuns.projectId }).from(schema.swarmRuns)
    .where(eq(schema.swarmRuns.id, swarmRunId)).limit(1);
  const containerId = run.projectId;

  const shareCaller = caller(f.grantee);
  const out: Record<string, string> = {};
  out["pipelineShare.workflow"] = JSON.stringify(await shareCaller.pipelineShare.workflow({ projectId: f.projectId }));
  out["pipelineShare.access"] = JSON.stringify(await shareCaller.pipelineShare.access({ projectId: f.projectId }));
  out["pipelineShare.list"] = JSON.stringify(await shareCaller.pipelineShare.list({}));
  out["pipelineShare.runStatus"] = JSON.stringify(await shareCaller.pipelineShare.runStatus({ swarmRunId }));
  out["pipelineShare.lineage"] = JSON.stringify(await shareCaller.pipelineShare.lineage({ projectId: f.projectId }));
  out["response.getChain"] = JSON.stringify(await caller(f.grantee).response.getChain({ swarmRunId }));
  out["response.listByType"] = JSON.stringify(await caller(f.grantee).response.listByType({ projectId: containerId, responseType: "raw" }));
  out["debug.list"] = JSON.stringify(await caller(f.grantee).debug.list({ swarmRunId }));
  out["debug.getBySwarmRun"] = JSON.stringify(await caller(f.grantee).debug.getBySwarmRun({ swarmRunId }));
  out["debug.getRunStats"] = JSON.stringify(await caller(f.grantee).debug.getRunStats({ swarmRunId }));
  out["export.exportRun"] = JSON.stringify(await caller(f.grantee).export.exportRun({ runId: swarmRunId }));
  out["export.exportProjectBackup"] = JSON.stringify(await caller(f.grantee).export.exportProjectBackup({ projectId: containerId }));
  out["swarm.getPipeline"] = JSON.stringify(await db().select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, f.projectId)));
  for (const name of ["get_shared_pipeline", "list_pipeline_shares", "shared_run_status"]) {
    out[`mcp.${name}`] = JSON.stringify(await tool(name).handler(
      // One bag of keys: zod strips whatever each tool does not declare.
      { projectId: f.projectId, swarmRunId, shareId: f.grant.shareId }, ctx(f.grantee.id),
    ));
  }
  out["mcp.export_run"] = JSON.stringify(await tool("export_run").handler({ runId: swarmRunId }, ctx(f.grantee.id)));
  return out;
}

describe("pipeline sharing between two accounts + publish lineage (isolated localhost MySQL)", () => {
  it("lets a run_only recipient RUN the pipeline, on their own key, with the definition withheld", async () => {
    const f = await fixture("run_only");
    const { receipt, run } = await runShared(f);

    // EXECUTION really happened, on the OWNER's prompt, through the fake
    // adapter: without this every "no leak" assertion below would be vacuous.
    expect(run.status).toBe("completed");
    expect(seen.calls.map((c) => c.system)).toEqual([SECRET, "Make the translation presentation-ready."]);
    // The grantor's stored provider is never the billable route.
    expect([...new Set(seen.calls.map((c) => c.apiKey))]).toEqual([GRANTEE_KEY]);
    expect([...new Set(seen.calls.map((c) => c.baseUrl))]).toEqual(["https://api.grantee.test/v1"]);
    // No real provider was contacted: the fake adapter is the only one here.
    expect(seen.calls.every((c) => c.slug === "openai")).toBe(true);

    // The definition is still the owner's: the run executed a snapshot the
    // OWNER owns, and no step/template was copied into the recipient's account.
    const [version] = await db().select({ ownerId: schema.pipelineVersions.ownerId })
      .from(schema.pipelineVersions).where(eq(schema.pipelineVersions.id, receipt.workflowVersionId)).limit(1);
    expect(version.ownerId).toBe(f.owner.id);
    // The only project the recipient owns is the run container (the same device
    // the marketplace buyer container uses), and a container is only a container
    // if it holds no copy of the definition: no steps, no template.
    const granteeProjects = await db().select({ id: schema.projects.id, name: schema.projects.name })
      .from(schema.projects).where(eq(schema.projects.userId, f.grantee.id));
    expect(granteeProjects).toHaveLength(1);
    expect(granteeProjects[0].name).toMatch(/^Shared pipeline runs — Lender pipeline \d+$/);
    const containerId = granteeProjects[0].id;
    expect(await db().select({ id: schema.pipelineSteps.id }).from(schema.pipelineSteps)
      .where(eq(schema.pipelineSteps.projectId, containerId))).toEqual([]);
    expect(await db().select({ id: schema.pipelineTemplates.id }).from(schema.pipelineTemplates)
      .where(eq(schema.pipelineTemplates.userId, f.grantee.id))).toEqual([]);

    const view = await share.getSharedRunView({ userId: f.grantee.id, swarmRunId: receipt.swarmRunId });
    expect(view?.status).toBe("completed");
    expect(view?.finalOutput).toBe(FINAL_TEXT);
    expect(view?.progress).toHaveLength(2);
    expect(view?.mode).toBe("run_only");

    // A12: the secret appears NOWHERE the recipient can read.
    const payloads = await recipientVisiblePayloads(f, receipt.swarmRunId);
    expect(Object.keys(payloads).length).toBeGreaterThanOrEqual(17);
    for (const [surface, payload] of Object.entries(payloads)) {
      expect(`${surface}: ${payload}`).not.toMatch(SECRET_MARKERS);
      expect(`${surface}: ${payload}`).not.toContain(OWNER_KEY);
    }
    // And the redaction is at the WRITE: the step rows carry a length notice,
    // not a summary of the owner's prompt.
    const stepRows = await db().select().from(schema.agentRuns).where(eq(schema.agentRuns.swarmRunId, receipt.swarmRunId));
    expect(stepRows.length).toBeGreaterThan(0);
    for (const row of stepRows) {
      expect(`${row.systemPrompt} ${row.userPrompt} ${row.contextInput}`).not.toMatch(SECRET_MARKERS);
      expect(row.systemPrompt ?? "").toContain("not stored");
    }
    // The intermediate that DOES contain the echoed secret exists in the
    // database and is withheld from every recipient read above.
    const intermediates = await db().select().from(schema.agentResponses)
      .where(and(eq(schema.agentResponses.swarmRunId, receipt.swarmRunId)));
    expect(intermediates.some((r) => /SHAREOWNER/.test(r.content))).toBe(true);
    expect(intermediates.length).toBeGreaterThan(1);
  });

  it("withholds the definition from a run_only READ itself: identity only, and a stated reason", async () => {
    const f = await fixture("run_only");
    const workflow = await share.getSharedWorkflow(f.grantee.id, { projectId: f.projectId });
    expect(JSON.stringify(workflow)).not.toMatch(SECRET_MARKERS);
    expect(workflow.access).toBe("run_only");
    expect(workflow.canModify).toBe(false);
    expect(workflow.steps.map((s) => s.stepOrder)).toEqual([1, 2]);
    expect(workflow.steps[0].name).toBe("Draft");
    expect(workflow.steps[0]).not.toHaveProperty("systemPrompt");
    expect(workflow.withheld).toContain("shared with you to run, not to read");
    // Running it is still theirs to do, and the refusal to share stays polite.
    await expect(share.updateSharedWorkflow(f.grantee.id, {
      projectId: f.projectId, steps: [{ name: "Hijack", role: "builder", systemPrompt: "mine" }],
    })).rejects.toThrow(/^run_only_cannot_modify:/);
    // An account with no grant learns nothing, not even that it exists.
    await expect(share.getSharedWorkflow(f.outsider.id, { projectId: f.projectId }))
      .rejects.toThrow(/^not_found_or_not_authorized:/);
  });

  it("lets a full recipient READ, refuses to MODIFY until canModify is true, then edits the owner's steps", async () => {
    const readOnly = await fixture("full", false);
    const workflow = await share.getSharedWorkflow(readOnly.grantee.id, { projectId: readOnly.projectId });
    expect(workflow.access).toBe("full");
    expect(workflow.steps[0].systemPrompt).toBe(SECRET);
    expect(workflow.canModify).toBe(false);
    await expect(share.updateSharedWorkflow(readOnly.grantee.id, {
      projectId: readOnly.projectId, steps: [{ name: "Hijack", role: "builder", systemPrompt: "rewritten" }],
    })).rejects.toThrow(/^share_is_read_only:/);
    // The definition was NOT changed by the refused write.
    const ownerSteps = await db().select().from(schema.pipelineSteps).where(eq(schema.pipelineSteps.projectId, readOnly.projectId));
    expect(ownerSteps.map((s) => s.name)).toEqual(["Draft", "Polish"]);

    // Now with canModify, on a second fixture so the read-only grant stays as it was.
    const f = await fixture("full", true);
    const updated = await share.updateSharedWorkflow(f.grantee.id, {
      projectId: f.projectId,
      steps: [
        { name: "Draft", role: "builder", systemPrompt: "Rewritten draft instructions." },
        { name: "Audit", role: "critic", systemPrompt: "Check it.", stepType: "agent" },
      ],
    });
    expect(updated.stepCount).toBe(2);
    const stored = await db().select().from(schema.pipelineSteps).where(eq(schema.pipelineSteps.projectId, f.projectId));
    expect(stored.map((s) => [s.stepOrder, s.name])).toEqual([[1, "Draft"], [2, "Audit"]]);
    expect(stored[0].systemPrompt).toBe("Rewritten draft instructions.");
    // EDITING borrowed work does not move ownership or provenance.
    const [project] = await db().select({
      userId: schema.projects.userId, originCreatorId: schema.projects.originCreatorId,
    }).from(schema.projects).where(eq(schema.projects.id, f.projectId)).limit(1);
    expect(project.userId).toBe(f.owner.id);
    expect(project.originCreatorId).toBeNull();
  });

  it("removes access the moment a grant is revoked, including a run already queued", async () => {
    const f = await fixture("run_only");
    await share.revokeShare(f.owner.id, { shareId: f.grant.shareId });

    await expect(share.getSharedWorkflow(f.grantee.id, { projectId: f.projectId }))
      .rejects.toThrow(/^not_found_or_not_authorized:/);
    await expect(share.startSharedRun({
      granteeId: f.grantee.id, projectId: f.projectId, input: "again", providerId: f.granteeProviderId,
      dispatch: async () => undefined,
    })).rejects.toThrow(/^not_found_or_not_authorized:/);
    // Revoking twice is a no-op, not an error, and the row survives as history.
    const again = await share.revokeShare(f.owner.id, { shareId: f.grant.shareId });
    expect(again.state).toBe("revoked");

    // The stronger case: a run queued BEFORE the revocation must not execute
    // after it. Nothing is dispatched; the worker is what reads the grant.
    seen.calls.length = 0;
    const queued = await (async () => {
      const [shareRow] = await db().select().from(schema.pipelineShares).where(eq(schema.pipelineShares.id, f.grant.shareId)).limit(1);
      expect(shareRow.state).toBe("revoked");
      // Re-issue, queue a run, revoke, then dispatch it.
      const regrant = await share.sharePipeline(f.owner.id, { projectId: f.projectId, granteeId: f.grantee.id, mode: "run_only" });
      const receipt = await share.startSharedRun({
        granteeId: f.grantee.id, projectId: f.projectId, input: "queued then revoked",
        providerId: f.granteeProviderId, dispatch: async () => undefined,
      });
      await share.revokeShare(f.owner.id, { shareId: regrant.shareId });
      await sw.executeSwarmRun({ swarmRunId: receipt.swarmRunId, userId: f.grantee.id });
      return receipt;
    })();
    const [run] = await db().select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, queued.swarmRunId)).limit(1);
    expect(["failed", "cancelled"]).toContain(run.status);
    expect(run.error ?? "").toMatch(/share_revoked/);
    // Not one provider call was made after the revocation.
    expect(seen.calls).toEqual([]);
  });

  it("refuses a full+canModify recipient at BOTH publish boundaries, naming the reason and the alternative", async () => {
    const f = await fixture("full", true);
    const cloned = await share.cloneSharedPipeline(f.grantee.id, { projectId: f.projectId });

    // ── legacy listing boundary (the MCP tool the desktop pass found ungated) ──
    const publishTool = TOOLS.find((t) => t.name === "publish_to_marketplace");
    if (!publishTool) throw new Error("publish_to_marketplace is not registered");
    await expect(publishTool.handler({
      projectId: cloned.projectId, title: "Stolen thunder", price: 4.99,
    }, {
      userId: f.grantee.id, scopes: new Set(["mcp:write"]), clientId: "t", requestId: "r", locale: "en",
    } satisfies McpAuthContext)).rejects.toThrow(
      /^publish_origin_required: only the account that originally created a workflow may list it on the marketplace, and this pipeline derives from work originally created by another account \(\d+\) — keep running it under the access you were given, and ask that account to publish it themselves\.$/,
    );
    // Nothing was written by the refusal.
    expect(await db().select({ id: schema.marketplaceListings.id }).from(schema.marketplaceListings)
      .where(eq(schema.marketplaceListings.creatorId, f.grantee.id))).toEqual([]);

    // ── v2 evidence/version boundary (the real service, not its helper) ──
    // The publication flag gate runs FIRST, so turn it on to reach the lineage
    // gate at all: an absent capability check is exactly what finding 25 was.
    await setFlag("v2Publication", true);
    const [listing] = await db().insert(schema.marketplaceListings).values({
      creatorId: f.grantee.id, templateId: cloned.templateId,
      title: "Grantee's own listing", price: "1.00", status: "draft",
    });
    const { publishVersion } = await import("./evidenceService");
    await expect(publishVersion({
      userId: f.grantee.id,
      listingId: Number((listing as { insertId: number }).insertId),
      workflowVersionId: cloned.workflowVersionId,
      benchmarkId: 999999, previewHash: "0".repeat(64), consentVersion: "consent-v1",
    })).rejects.toThrow(
      /^publish_origin_required: only the account that originally created a workflow may sell version \d+, and this version derives from work originally created by another account \(\d+\) — leave it as a private evaluation, or ask that account to publish it themselves\.$/,
    );
    // A plain code, readable by a client without matching prose.
    expect(lineage.PUBLISH_ORIGIN_CODE).toBe("publish_origin_required");
  });

  it("keeps the ORIGINAL creator able to publish, and carries their lineage through a clone", async () => {
    const f = await fixture("full", true);

    // The creator lists their own work: the same gate, and it lets them pass.
    const publishTool = TOOLS.find((t) => t.name === "publish_to_marketplace")!;
    const result = await publishTool.handler({
      projectId: f.projectId, title: "Owner's own pipeline", price: 4.99,
    }, {
      userId: f.owner.id, scopes: new Set(["mcp:write"]), clientId: "t", requestId: "r", locale: "en",
    } satisfies McpAuthContext) as { listingId: number; status: string };
    expect(result.status).toBe("draft");
    expect(result.listingId).toBeGreaterThan(0);

    const cloned = await share.cloneSharedPipeline(f.grantee.id, { projectId: f.projectId });
    // PROVENANCE AS DATA: the copy belongs to the recipient, the origin stays
    // with the account that made the work, and the earliest version is named.
    expect(cloned.originCreatorId).toBe(f.owner.id);
    expect(cloned.workflowVersionId).toBe(cloned.originVersionId);
    const [newProject] = await db().select({
      userId: schema.projects.userId, originCreatorId: schema.projects.originCreatorId,
    }).from(schema.projects).where(eq(schema.projects.id, cloned.projectId)).limit(1);
    expect(newProject.userId).toBe(f.grantee.id);
    expect(newProject.originCreatorId).toBe(f.owner.id);
    const resolved = await lineage.resolveProjectLineage(cloned.projectId);
    expect(resolved?.originCreatorId).toBe(f.owner.id);
    expect(resolved?.inferredFromOwner).toBe(false);
    // A LATER version captured from that clone inherits the lineage too: the
    // chain cannot be laundered by re-snapshotting.
    const { captureVersionFromProject } = await import("./benchmark/versionService");
    const again = await captureVersionFromProject(f.grantee.id, cloned.projectId);
    const second = await lineage.resolveVersionLineage(again.versionId);
    expect(second?.originCreatorId).toBe(f.owner.id);
    expect(second?.originVersionId).toBe(cloned.originVersionId);
    // The clone is the recipient's OWN project now, so it reads as the owner's
    // pipeline (which is what a full share entitles them to make), and the
    // lineage pointer still names the account that lent it.
    const view = await share.getSharedWorkflow(f.grantee.id, { projectId: cloned.projectId });
    expect(view.access).toBe("owner");
    expect(view.steps[0].systemPrompt).toBe(SECRET);
    const cloneLineage = await lineage.resolveProjectLineage(cloned.projectId);
    expect(cloneLineage?.originCreatorId).toBe(f.owner.id);
  });

  it("resolves a pre-lineage version to 'owner is the original creator' and does not newly block it", async () => {
    const owner = await mkUser("Legacy owner");
    const [version] = await db().insert(schema.pipelineVersions).values({
      ownerId: owner.id, versionNumber: 1, definition: '{"steps":[]}', definitionHash: "d".repeat(64),
    });
    const versionId = Number((version as { insertId: number }).insertId);
    const [project] = await db().insert(schema.projects).values({ userId: owner.id, name: "Legacy pipeline" });
    const projectId = Number((project as { insertId: number }).insertId);
    const [template] = await db().insert(schema.pipelineTemplates).values({
      userId: owner.id, name: "Legacy template", sourceProjectId: projectId,
      steps: [{ name: "Draft", role: "builder", systemPrompt: "plain" }],
    });

    const resolved = await lineage.resolveVersionLineage(versionId);
    expect(resolved?.originCreatorId).toBe(owner.id);
    expect(resolved?.inferredFromOwner).toBe(true);
    expect(resolved?.originVersionId).toBe(versionId);

    // The gate is a no-op for data that predates it.
    await expect(lineage.assertOriginalCreatorMayList({
      userId: owner.id, projectId, templateId: Number((template as { insertId: number }).insertId),
    })).resolves.toMatchObject({ originCreatorId: owner.id });
    await expect(lineage.assertOriginalCreatorMaySellVersion({
      userId: owner.id, workflowVersionId: versionId,
    })).resolves.toMatchObject({ inferredFromOwner: true });
    // A stranger gets the same answer as for a version that does not exist.
    // This assertion used to demand `publish_origin_required:` here, which was
    // the leak itself: it confirmed the row and named its creator to an account
    // entitled to neither. The real provenance mismatch — a `full` recipient who
    // owns the clone and is still not the original creator — is refused with
    // `publish_origin_required` by the case above, which is what that code is for.
    const others = await db().select({ id: schema.users.id }).from(schema.users).limit(50);
    const strangerId = others.find((u) => u.id !== owner.id)?.id ?? 2_147_483_647;
    expect(strangerId).not.toBe(owner.id);
    await expect(lineage.assertOriginalCreatorMaySellVersion({
      userId: strangerId, workflowVersionId: versionId,
    })).rejects.toThrow(/^not_found_or_not_authorized$/);
    await expect(lineage.assertOriginalCreatorMayList({
      userId: strangerId, templateId: Number((template as { insertId: number }).insertId),
    })).rejects.toThrow(/^not_found_or_not_authorized$/);
  });

  it("grants a share to exactly one named account and refuses to invent one", async () => {
    const f = await fixture("run_only");
    expect(f.grant.mode).toBe("run_only");
    // By email, when the email names exactly one account.
    const byEmail = await share.sharePipeline(f.owner.id, {
      projectId: f.projectId, granteeEmail: f.grantee.email as string, mode: "full",
    });
    expect(byEmail.shareId).toBe(f.grant.shareId);
    expect(byEmail.mode).toBe("full");
    await expect(share.sharePipeline(f.owner.id, { projectId: f.projectId, granteeEmail: "nobody@example.test" }))
      .rejects.toThrow(/^grantee_not_found:/);
    await expect(share.sharePipeline(f.owner.id, { projectId: f.projectId, granteeId: 2_147_483_647 }))
      .rejects.toThrow(/^grantee_not_found:/);
    await expect(share.sharePipeline(f.owner.id, { projectId: f.projectId, granteeId: f.owner.id }))
      .rejects.toThrow(/^cannot_share_with_self:/);
    await expect(share.sharePipeline(f.owner.id, { projectId: f.projectId, granteeId: f.grantee.id, mode: "run_only", canModify: true }))
      .rejects.toThrow(/^run_only_cannot_modify:/);
    // Only the owner may lend it.
    await expect(share.sharePipeline(f.outsider.id, { projectId: f.projectId, granteeId: f.grantee.id }))
      .rejects.toThrow(/^not_found_or_not_authorized:/);
    const listed = await share.listShares(f.grantee.id, {});
    expect(listed.incoming.map((s) => s.shareId)).toEqual([f.grant.shareId]);
    expect(listed.incoming[0].originCreatorId).toBe(f.owner.id);
  });

  // The predicate is unit-pinned elsewhere; this is the rendered surface. A
  // `run_only` recipient may see that a step ran and how it went, never WHICH
  // model the grantor pinned to it — that is part of the definition they were
  // not given, and `debug.getRunStats` is a read that bypasses the export
  // projection entirely. The `full` control matters as much: without it, a
  // blanket "always withheld" would pass this file.
  it("runs a shared pipeline on the recipient's own model and shows it to them", async () => {
    const restricted = await fixture("run_only");
    const callsBefore = seen.calls.length; // the recorder is per-process, not per-test
    const ran = await runShared(restricted);
    const callerFor = (user: UserRow) => appMod.appRouter.createCaller({
      user, remoteIp: "test-ip",
    } as unknown as Parameters<typeof appMod.appRouter.createCaller>[0]);

    // The grantor pinned `owner-model`. It must not be what their credential is
    // asked to serve: the recipient brings their own key AND their own model,
    // and a name their host does not serve would fail the run outright.
    const thisRun = seen.calls.slice(callsBefore);
    expect(thisRun.length).toBeGreaterThan(0);
    for (const call of thisRun) {
      expect(call.model ?? "grantee-model").toBe("grantee-model");
    }
    expect(thisRun.map((c) => c.model)).not.toContain("owner-model");

    // And because that value is the recipient's own, the read shows it — no
    // marker, on either share mode (ticket #40).
    const asGrantee = await callerFor(restricted.grantee).debug.getRunStats({
      swarmRunId: ran.receipt.swarmRunId,
    });
    expect(asGrantee.steps.length).toBeGreaterThan(0);
    for (const step of asGrantee.steps) {
      expect(step.modelUsed).toBe("grantee-model");
    }
    // The grantor's prompts and definition are still withheld, so dropping the
    // model restriction did not widen anything else.
    expect(JSON.stringify(asGrantee)).not.toMatch(SECRET_MARKERS);
    expect(JSON.stringify(asGrantee)).not.toMatch(/owner-model/);

    const entitled = await fixture("full");
    const ranEntitled = await runShared(entitled);
    const asFull = await callerFor(entitled.grantee).debug.getRunStats({
      swarmRunId: ranEntitled.receipt.swarmRunId,
    });
    for (const step of asFull.steps) {
      expect(step.modelUsed).toBe("grantee-model");
    }
  });

});
