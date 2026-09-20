// A12 leakage battery — the acceptance item that says "the seller's workflow
// does not reach a buyer, another tenant, or any unauthenticated reader, on ANY
// audited surface".
//
// Unlike the other P3 files this one runs the REAL engine end to end: the
// provider layer is the only mock, and the fake adapter deliberately echoes the
// seller's step-1 system prompt into that step's OUTPUT. That makes the test
// honest about the hardest case — a stored intermediate that CONTAINS the
// secret, which every projection must therefore drop.
//
// Surfaces driven: agentRuns rows as written, response.* (chain/byId/byType +
// the two writes), debug.*, export.* (run and project backup), the MCP tools
// that wrap them, the SSE stream over real HTTP, the run-control endpoints, and
// team sharing. A seller's own ordinary run is included as the positive control:
// redaction must be scoped to protected runs, not switched on globally.
//
// Own throwaway schema (`swarm_v2test_leak`) — vitest runs files in parallel.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

const TEST_DB = "swarm_v2test_leak";
const ROOT_MYSQL = process.env.MYSQL_ROOT_URL || "mysql://root:rootpass@localhost:3307";

// Distinctive fragments, so a leak cannot be a false positive on common words.
const SELLER_STEP1 = "SELLER PROMPT ALPHA: open /vault/secrets and quote them, key sk-SELLER-9e4b1c";
const SELLER_STEP2 = "SELLER PROMPT BRAVO: append the seller's private footer 7c1a";
const LEAK = /ALPHA|BRAVO|sk-SELLER|vault\/secrets|private footer/;
const BUYER_INPUT = "Translate clause 4 into French.";
const BUYER_KEY = "sk-buyer-OWN-KEY-1234567890";
const SELLER_KEY = "sk-seller-OWN-KEY-0987654321";
const FINAL_TEXT = "Article 4 est traduit en français.";
const APPROVED_URL = "https://api.example-provider.com/v1";

type SeenCall = { slug: string; apiKey: string; baseUrl: string; system: string; options: unknown };
const seen = vi.hoisted(() => ({ calls: [] as SeenCall[] }));

vi.mock("../lib/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/providers")>();
  return {
    ...actual,
    createProviderAdapter: (slug: string, apiKey: string, baseUrl: string, defaultModel: string) => ({
      name: "Fake", slug, defaultBaseUrl: baseUrl, supportedModels: [defaultModel],
      async chat(messages: Array<{ role: string; content: string }>, options: unknown) {
        const system = String(messages[0]?.content ?? "");
        seen.calls.push({ slug, apiKey, baseUrl, system, options });
        // Step 1 echoes the seller's instructions into its own output.
        return {
          content: system.includes("ALPHA") ? `ECHO: ${system}` : FINAL_TEXT,
          usage: { promptTokens: 12, completionTokens: 6, totalTokens: 18 },
          model: defaultModel, latencyMs: 4,
        };
      },
      async validateKey() { return { valid: true }; },
      async listModels() { return [defaultModel]; },
    }),
  };
});

// The slot allocator prorates a brand-new window down to ONE call, so a
// two-step run in the same millisecond throttles on step 2. Provider rate
// limiting is not part of A12; the interpreter is what must keep running.
vi.mock("../lib/providerThrottle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/providerThrottle")>();
  return {
    ...actual,
    acquireProviderSlot: async () => ({ ok: true as const }),
    reportProviderResult: async () => undefined,
  };
});

let ex: typeof import("./marketplaceExecutionService");
let sw: typeof import("./swarmService");
let st: typeof import("../lib/streamToken");
let schema: typeof import("@db/schema");
let appMod: typeof import("../router");
let TOOLS: typeof import("../mcp/tools/index").TOOLS;
let registerStreamRoute: typeof import("../stream-route").registerStreamRoute;
let encryptKey: (plain: string) => string;
let admin: mysql.Connection;

type User = import("@db/schema").User;
type Fixture = {
  seller: User; buyer: User; outsider: User; teammate: User;
  sellerProjectId: number; containerProjectId: number;
  buyerProviderId: number; sellerProviderId: number;
  versionId: number; listingId: number;
  swarmRunId: number; intermediateId: number; finalId: number;
  ownRunId: number;
};
let f: Fixture;
/** Provider calls made by the protected run only (the positive-control run's
 *  calls are recorded separately in `seen`). */
let protectedCalls: SeenCall[] = [];

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
  sw = await import("./swarmService");
  st = await import("../lib/streamToken");
  schema = await import("@db/schema");
  TOOLS = (await import("../mcp/tools/index")).TOOLS;
  appMod = await import("../router");
  registerStreamRoute = (await import("../stream-route")).registerStreamRoute;
  const crypto = await import("./cryptoService");
  encryptKey = (plain) => crypto.encrypt(plain, crypto.getMasterKey()).encrypted;

  f = await seedAndRun();
}, 420_000);

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

/** tRPC caller with loose typings so the battery can drive every procedure
 *  from one table and cast the results per assertion. */
type LooseCaller = Record<string, Record<string, (input: Record<string, unknown>) => Promise<unknown>>>;
const caller = (user: User): LooseCaller => appMod.appRouter.createCaller({
  req: new Request("http://localhost"), resHeaders: new Headers(),
  user, requestId: `a12-${user.id}`,
}) as unknown as LooseCaller;

const mcpCtx = (userId: number) => ({
  userId, scopes: new Set(["mcp:read", "mcp:run", "mcp:write"]),
  clientId: "a12-test", requestId: `a12-${userId}`, locale: "en" as const,
});

const mcpTool = (name: string) => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`MCP tool ${name} is not registered`);
  return tool;
};

async function seedAndRun(): Promise<Fixture> {
  const d = await db();
  const stamp = `${Date.now()}-${Math.random()}`;
  const mkUser = async (label: string): Promise<User> => {
    const [r] = await d.insert(schema.users)
      .values({ name: label, email: `${label}-${stamp}@example.test`, tier: "standard" });
    const id = Number((r as { insertId: number }).insertId);
    const [row] = await d.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    return row;
  };
  const seller = await mkUser("Seller");
  const buyer = await mkUser("Buyer");
  const outsider = await mkUser("Outsider");
  const teammate = await mkUser("Teammate");

  const [proj] = await d.insert(schema.projects).values({ userId: seller.id, name: "Seller Pipeline" });
  const sellerProjectId = Number((proj as { insertId: number }).insertId);
  const [sellerProv] = await d.insert(schema.llmProviders).values({
    userId: seller.id, name: `seller-${stamp}`, slug: "openai", baseUrl: APPROVED_URL,
    apiKeyRef: encryptKey(SELLER_KEY), defaultModel: "seller-model",
  });
  const sellerProviderId = Number((sellerProv as { insertId: number }).insertId);
  // The seller's own pipeline: the positive-control run uses these steps.
  await d.insert(schema.pipelineSteps).values({
    projectId: sellerProjectId, stepOrder: 1, stepType: "agent", name: "Draft", role: "builder",
    systemPrompt: SELLER_STEP1, isEnabled: true, providerId: sellerProviderId, model: "seller-model",
  });

  const [ver] = await d.insert(schema.pipelineVersions).values({
    ownerId: seller.id, sourceProjectId: sellerProjectId, versionNumber: 1,
    definition: JSON.stringify({
      steps: [
        { stepOrder: 1, name: "Draft", role: "builder", systemPrompt: SELLER_STEP1, providerId: sellerProviderId, model: "seller-model", temperature: "0.7", maxTokens: 1024, stepType: "agent", ifConfig: null, whileConfig: null },
        { stepOrder: 2, name: "Polish", role: "polisher", systemPrompt: SELLER_STEP2, providerId: sellerProviderId, model: "seller-model", temperature: "0.7", maxTokens: 1024, stepType: "agent", ifConfig: null, whileConfig: null },
      ],
      sourceAgentIds: [],
    }),
    definitionHash: "a".repeat(64),
  });
  const versionId = Number((ver as { insertId: number }).insertId);

  const [tpl] = await d.insert(schema.pipelineTemplates).values({
    userId: seller.id, name: `tpl-${stamp}`, steps: [{ name: "Draft", role: "builder", systemPrompt: SELLER_STEP1 }],
    sourceProjectId: sellerProjectId,
  });
  const [listing] = await d.insert(schema.marketplaceListings).values({
    creatorId: seller.id, templateId: Number((tpl as { insertId: number }).insertId),
    title: "Contract Redliner", price: "4.99", status: "published",
  });
  const listingId = Number((listing as { insertId: number }).insertId);
  await d.insert(schema.marketplaceListingV2).values({
    listingId, publicationMode: "v2", currentWorkflowVersionId: versionId, evidenceSummaryRevision: 1,
  });
  await d.insert(schema.marketplacePurchases).values({
    buyerId: buyer.id, listingId, amountPaid: "4.99", platformFee: "1.50",
    creatorEarnings: "3.49", status: "active",
  });

  const [buyerProv] = await d.insert(schema.llmProviders).values({
    userId: buyer.id, name: `buyer-${stamp}`, slug: "openai", baseUrl: APPROVED_URL,
    apiKeyRef: encryptKey(BUYER_KEY), defaultModel: "buyer-model",
  });
  const buyerProviderId = Number((buyerProv as { insertId: number }).insertId);

  const [already] = await d.select({ id: schema.trustedProviderEndpoints.id }).from(schema.trustedProviderEndpoints)
    .where(and(eq(schema.trustedProviderEndpoints.provider, "openai"), eq(schema.trustedProviderEndpoints.baseUrl, APPROVED_URL)))
    .limit(1);
  if (!already) {
    await d.insert(schema.trustedProviderEndpoints).values({
      provider: "openai", baseUrl: APPROVED_URL, adapterKind: "openai_compatible",
      endpointClass: "first_party", loggingDisclosure: "Provider retains request logs.",
      protectionClass: "standard", approvedBy: seller.id, policyVersion: "a12-1", enabled: true,
    });
  }

  // The buyer shares their run container with a teammate, as any project can be.
  const [team] = await d.insert(schema.teams).values({ name: `team-${stamp}`, ownerId: buyer.id });
  const teamId = Number((team as { insertId: number }).insertId);
  await d.insert(schema.teamMembers).values([{ teamId, userId: buyer.id, role: "owner" }, { teamId, userId: teammate.id, role: "tester" }]);

  await setFlag("v2ProtectedExecution", true);

  // ─── The protected run, through the real interpreter ───
  const receipt = await ex.startProtectedRun({
    buyerId: buyer.id, listingId, input: BUYER_INPUT, providerId: buyerProviderId,
    dispatch: async (runId, buyerId) => { await sw.executeSwarmRun({ swarmRunId: runId, userId: buyerId }); },
  });
  const [run] = await d.select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, receipt.swarmRunId)).limit(1);
  if (run.status !== "completed") throw new Error(`protected run did not complete: ${run.status} ${run.error ?? ""}`);
  const [container] = await d.select().from(schema.projects).where(eq(schema.projects.id, run.projectId)).limit(1);
  await d.insert(schema.teamProjects).values({ teamId, projectId: container.id, addedBy: buyer.id });

  const steps = await d.select().from(schema.agentResponses).where(eq(schema.agentResponses.swarmRunId, run.id));
  const ordered = steps.sort((a, b) => a.id - b.id);
  const finalId = Number(run.finalResponseId);
  const intermediate = ordered.find((r) => r.id !== finalId);
  if (!intermediate) throw new Error("expected an intermediate response to withhold");

  protectedCalls = [...seen.calls];
  seen.calls.length = 0;

  // ─── The seller's own ordinary run (positive control) ───
  const [ownRun] = await d.insert(schema.swarmRuns).values({
    projectId: sellerProjectId, userId: seller.id, userPrompt: "my own work", status: "pending",
    pipelineVersion: "custom-v2", runParams: { source: "execute", prompt: "my own work", stateless: true },
  });
  const ownRunId = Number((ownRun as { insertId: number }).insertId);
  await sw.executeSwarmRun({ swarmRunId: ownRunId, userId: seller.id });

  return {
    seller, buyer, outsider, teammate, sellerProjectId, containerProjectId: container.id,
    buyerProviderId, sellerProviderId, versionId, listingId,
    swarmRunId: run.id, intermediateId: intermediate.id, finalId, ownRunId,
  };
}

/** Everything the buyer's surfaces return, serialised for one leak scan. */
async function buyerVisiblePayloads(): Promise<Record<string, string>> {
  const buyer = caller(f.buyer);
  const out: Record<string, string> = {};
  out["response.getChain"] = JSON.stringify(await buyer.response.getChain({ swarmRunId: f.swarmRunId }));
  out["response.listByType"] = JSON.stringify(await buyer.response.listByType({ projectId: f.containerProjectId, responseType: "raw" }));
  out["debug.list"] = JSON.stringify(await buyer.debug.list({ swarmRunId: f.swarmRunId }));
  out["debug.getBySwarmRun"] = JSON.stringify(await buyer.debug.getBySwarmRun({ swarmRunId: f.swarmRunId }));
  out["debug.getRunStats"] = JSON.stringify(await buyer.debug.getRunStats({ swarmRunId: f.swarmRunId }));
  out["debug.getStats"] = JSON.stringify(await buyer.debug.getStats({ projectId: f.containerProjectId }));
  out["agent.list"] = JSON.stringify(await buyer.agent.list({ projectId: f.containerProjectId }));
  out["export.exportRun"] = JSON.stringify(await buyer.export.exportRun({ runId: f.swarmRunId }));
  out["export.exportProjectBackup"] = JSON.stringify(await buyer.export.exportProjectBackup({ projectId: f.containerProjectId }));
  out["export.exportPipeline"] = JSON.stringify(await buyer.export.exportPipeline({ projectId: f.containerProjectId }));
  out["swarm.getRunStatus"] = JSON.stringify(await buyer.swarm.getRunStatus({ projectId: f.containerProjectId }));
  out["marketplaceExecution.get"] = JSON.stringify(await ex.getProtectedRunView({ buyerId: f.buyer.id, swarmRunId: f.swarmRunId }));
  for (const name of ["export_run", "protected_run_status", "get_pipeline", "project_context", "run_status", "export_pipeline", "export_my_data"]) {
    out[`mcp.${name}`] = JSON.stringify(await mcpTool(name).handler(
      // One bag of keys: zod strips what each tool does not declare.
      { runId: f.swarmRunId, swarmRunId: f.swarmRunId, projectId: f.containerProjectId, id: f.containerProjectId },
      mcpCtx(f.buyer.id),
    ));
  }
  return out;
}

describe("A12 leakage battery (DB-backed, real protected run through the engine)", () => {
  it("runs the seller's version for real, on the buyer's credential, without redirects", async () => {
    // Positive control on EXECUTION: if the adapter was never called with the
    // seller's prompt, every "no leak" assertion below would be vacuous.
    expect(protectedCalls.map((c) => c.system)).toEqual([SELLER_STEP1, SELLER_STEP2]);
    // A14: the seller's stored provider is never the billable route or the key.
    expect([...new Set(protectedCalls.map((c) => c.apiKey))]).toEqual([BUYER_KEY]);
    expect(protectedCalls.every((c) => c.baseUrl === APPROVED_URL)).toBe(true);
    // A13: protected calls refuse a redirect, so an approved origin cannot
    // hand the prompt (and the buyer's key) to another host.
    expect(protectedCalls.every((c) => (c.options as { noRedirect?: boolean }).noRedirect === true)).toBe(true);
    // The seller's own positive-control run keeps the ordinary transport policy.
    expect(seen.calls).toHaveLength(1);
    expect(seen.calls[0].apiKey).toBe(SELLER_KEY);
    expect(seen.calls[0].options).not.toHaveProperty("noRedirect");
  });

  it("stores no prompt text for a protected run, and the ordinary summary for the seller's own run", async () => {
    const d = await db();
    const protectedRows = await d.select().from(schema.agentRuns).where(eq(schema.agentRuns.swarmRunId, f.swarmRunId));
    expect(protectedRows.length).toBeGreaterThan(0);
    for (const row of protectedRows) {
      expect(`${row.systemPrompt} ${row.userPrompt} ${row.contextInput}`).not.toMatch(LEAK);
      expect(row.systemPrompt ?? "").toContain("not stored");
    }
    // The buyer's own input is still theirs to see on the run row.
    const [run] = await d.select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, f.swarmRunId)).limit(1);
    expect(run.userPrompt).toBe(BUYER_INPUT);

    // Positive control: redaction is scoped to protected runs, so an owner can
    // still read their own history ("owner editing still works").
    const ownRows = await d.select().from(schema.agentRuns).where(eq(schema.agentRuns.swarmRunId, f.ownRunId));
    expect(ownRows.length).toBe(1);
    expect(ownRows[0].systemPrompt).toContain("SELLER PROMPT ALPHA");
  });

  it("intermediates exist in the database and do contain the echoed secret", async () => {
    // Proves the projections below are doing real work rather than the model
    // simply never having produced the text.
    const d = await db();
    const [intermediate] = await d.select().from(schema.agentResponses)
      .where(eq(schema.agentResponses.id, f.intermediateId)).limit(1);
    expect(intermediate.content).toMatch(/ALPHA/);
  });

  it("no buyer-visible surface returns the seller's workflow", async () => {
    const payloads = await buyerVisiblePayloads();
    expect(Object.keys(payloads).length).toBeGreaterThanOrEqual(19);
    for (const [surface, payload] of Object.entries(payloads)) {
      expect(`${surface}: ${payload}`).not.toMatch(LEAK);
      expect(`${surface}: ${payload}`).not.toContain(SELLER_KEY);
    }
    // And they are not empty: the buyer still gets their answer and progress.
    const view = JSON.parse(payloads["marketplaceExecution.get"]) as { finalOutput: string | null; progress: unknown[] };
    expect(view.finalOutput).toBe(FINAL_TEXT);
    expect(view.progress).toHaveLength(2);
  });

  it("the buyer's export says why the intermediates are missing", async () => {
    const buyer = caller(f.buyer);
    const exported = await buyer.export.exportRun({ runId: f.swarmRunId }) as {
      agentRuns: Array<Record<string, unknown>>; agentResponses: Array<{ id: number }>; protection?: string;
    };
    expect(exported.agentResponses.map((r) => r.id)).toEqual([f.finalId]);
    expect(exported.protection).toContain("Protected marketplace run");
    expect(Object.keys(exported.agentRuns[0])).not.toContain("systemPrompt");
  });

  it("another tenant cannot read, flag or annotate the run by id", async () => {
    const other = caller(f.outsider);
    await expect(other.response.getById({ id: f.intermediateId })).rejects.toThrow(/not_found_or_not_authorized/);
    await expect(other.response.flagResponse({ responseId: f.intermediateId })).rejects.toThrow(/not_found_or_not_authorized/);
    await expect(other.response.addHumanNotes({ responseId: f.finalId, notes: "mine now" })).rejects.toThrow(/not_found_or_not_authorized/);
    await expect(other.debug.getBySwarmRun({ swarmRunId: f.swarmRunId })).rejects.toThrow(/not_found_or_not_authorized/);
    await expect(other.debug.getRunStats({ swarmRunId: f.swarmRunId })).rejects.toThrow(/not_found_or_not_authorized/);
    await expect(other.response.listByType({ projectId: f.containerProjectId, responseType: "raw" })).rejects.toThrow(/not_found_or_not_authorized/);
    await expect(other.export.exportRun({ runId: f.swarmRunId })).rejects.toThrow(/Run not found/);
    await expect(other.export.exportProjectBackup({ projectId: f.containerProjectId })).rejects.toThrow(/Project not found/);
    await expect(mcpTool("run_status").handler({ runId: f.swarmRunId }, mcpCtx(f.outsider.id))).rejects.toThrow(/Run not found/);
    // Nothing was written by the refused mutations.
    const d = await db();
    const [row] = await d.select().from(schema.agentResponses).where(eq(schema.agentResponses.id, f.finalId)).limit(1);
    expect(row.isFlagged).toBeFalsy();
    expect(row.humanNotes ?? "").toBe("");
  });

  it("even the buyer cannot fetch an intermediate response by id", async () => {
    const buyer = caller(f.buyer);
    expect(await buyer.response.getById({ id: f.intermediateId })).toBeNull();
    const final = await buyer.response.getById({ id: f.finalId }) as { content: string };
    expect(final.content).toBe(FINAL_TEXT);
  });

  it("the SSE stream requires a run-scoped signature and carries no secret", async () => {
    const app = new Hono();
    registerStreamRoute(app as never);

    const unsigned = await app.request(`/api/stream/${f.swarmRunId}`);
    expect(unsigned.status).toBe(401);
    // The minting endpoint applies the same visibility rule, so a stranger
    // cannot obtain a signature for a run they cannot see.
    await expect(caller(f.outsider).swarm.streamUrl({ swarmRunId: f.swarmRunId })).rejects.toThrow(/Run not found/);

    // A token cannot be edited to cover another run or account: the signature
    // covers the (run, user) pair, so a tampered one is rejected outright.
    const buyerPath = st.signStreamPath(f.swarmRunId, f.buyer.id);
    const tampered = buyerPath.replace(/sig=./, (m) => (m === "sig=0" ? "sig=1" : "sig=0"));
    expect((await app.request(tampered)).status).toBe(401);

    // A valid signature for a user who cannot see the run is refused too — and
    // only `swarm.streamUrl` mints them, behind that same visibility check.
    expect((await app.request(st.signStreamPath(f.swarmRunId, f.outsider.id))).status).toBe(404);
    expect((await app.request(st.signStreamPath(f.ownRunId, f.buyer.id))).status).toBe(404);

    const res = await app.request(st.signStreamPath(f.swarmRunId, f.buyer.id));
    expect(res.status).toBe(200);
    const streamed = await readUntilQuiet(res);
    expect(streamed).not.toMatch(LEAK);
    // The stream is still useful: progress and the final answer are in it.
    expect(streamed).toContain("step_start");
    expect(streamed).toContain(FINAL_TEXT);

    // Ordinary runs keep working for their owner (positive control).
    const own = await app.request(st.signStreamPath(f.ownRunId, f.seller.id));
    expect(own.status).toBe(200);
    expect(await readUntilQuiet(own)).toContain("SELLER PROMPT ALPHA");
  });

  it("a marketplace run cannot be resumed, approved or re-entered through the run endpoints", async () => {
    const buyer = caller(f.buyer);
    await expect(buyer.swarm.resumePipeline({ runId: f.swarmRunId })).rejects.toThrow(/protected_run_read_only/);
    await expect(buyer.swarm.approveStep({ runId: f.swarmRunId, action: "approve" })).rejects.toThrow(/protected_run_read_only/);
    await expect(buyer.swarm.execute({ projectId: f.containerProjectId, prompt: "again", runId: f.swarmRunId }))
      .rejects.toThrow(/protected_run_read_only/);
    // The refusal happened before run_params were rewritten.
    const d = await db();
    const [run] = await d.select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, f.swarmRunId)).limit(1);
    expect((run.runParams as { protectedRun?: unknown }).protectedRun).toBeTruthy();
  });

  it("a teammate the container is shared with sees progress, not the definition", async () => {
    const mate = caller(f.teammate);
    const stats = JSON.stringify(await mate.debug.getRunStats({ swarmRunId: f.swarmRunId }));
    expect(stats).not.toMatch(LEAK);
    // Team visibility is not ownership: the run endpoints stay closed.
    await expect(mate.export.exportRun({ runId: f.swarmRunId })).rejects.toThrow(/Run not found/);
    // The seller's own project is not shared with anyone.
    await expect(mate.debug.getStats({ projectId: f.sellerProjectId })).rejects.toThrow(/not_found_or_not_authorized/);
  });
});

/** Collects everything already queued (replay + terminal), stopping once the
 *  stream goes quiet. Never resolves the live tail indefinitely. */
async function readUntilQuiet(res: Response, quietMs = 400): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const race = await Promise.race([
      reader.read(),
      new Promise<"quiet">((resolve) => setTimeout(() => resolve("quiet"), quietMs)),
    ]);
    if (race === "quiet") break;
    const chunk = race as { done: boolean; value?: Uint8Array };
    if (chunk.done || !chunk.value) break;
    out += decoder.decode(chunk.value, { stream: true });
  }
  await reader.cancel().catch(() => undefined);
  return out;
}
