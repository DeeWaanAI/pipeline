// Consented feedback attachments (D11, ticket #22) — DB-backed integration
// battery.
//
// What this proves, against the REAL tables and the REAL tRPC routers, with no
// LLM call anywhere (the provider adapter is the only mock, exactly as in
// a12Leakage and pipelineSharing):
//
//  (a) an OWNED object's attachment carries the real detail — the prompt text is
//      in the stored snapshot, because that is what its owner can already read;
//  (b) an attachment on a run of a `run_only` SHARED pipeline, and on the
//      borrowed DEFINITION itself, carries NO prompt text, NO provider key and
//      NOT the grantor's model — the same markers the a12 / pipelineSharing
//      batteries use — and is still useful (the answer and the progress are
//      there), so redaction is proven without gutting the feature. The secret
//      really is in the database for that run (the fake adapter echoes it into a
//      stored intermediate), which is what makes the absence assertions mean
//      something instead of being vacuous;
//  (c) no consent → refused, and NOTHING is written: no feedback row either,
//      because a half-attached receipt is not a receipt;
//  (d) another account's object by guessed id → `not_found_or_not_authorized`,
//      for all three kinds, so existence is not revealed;
//  (e) the support read returns the summaries and refuses a non-admin; the
//      summary list carries NO snapshot payload, and the payload is a separate,
//      audited, admin-only read;
// plus: the author reads back their own attachments and nobody else can; the
//      recorded consent version is the server's own constant; a credential in
//      the text is refused rather than filed; and the MCP workbench tool obeys
//      exactly the same rules because it calls the same service.
//
// Own throwaway schema (`swarm_v2test_feedback`) plus a `GET_LOCK` guard, so it
// cannot collide with the other integration files and cannot touch the local
// `swarm` database. The schema is pushed from `db/schema.ts` — migration 033 is
// applied by a human, never by a test.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import { and, count, eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import * as schema from "@db/schema";
import * as relations from "@db/relations";
import type { McpAuthContext } from "../mcp/types";

const TEST_DB = "swarm_v2test_feedback";

/** Distinctive fragments, so a leak cannot be a false positive on common words.
 *  TWO different secrets: the owner's own prompt (which MUST appear in their
 *  attachment — redaction is scoped, not switched on globally) and the lender's
 *  prompt (which must never appear in a `run_only` recipient's attachment). */
const OWN_PROMPT = "OWN PROMPT TANGO: restate the user's own brief 3f9c21";
const OWN_CONTEXT = "OWN CONTEXT SIERRA 8b44";
const LENDER_PROMPT = "LENDER PROMPT NOVEMBER: read /vault/deeds and sign with key sk-LENDER-7f3d9a";
const LENDER_MARKERS = /LENDER PROMPT NOVEMBER|sk-LENDER|vault\/deeds/;
const LENDER_MODEL = "lender-secret-model";
const LENDER_KEY = "sk-lender-OWN-KEY-1234567890123";
const GRANTEE_KEY = "sk-grantee-OWN-KEY-123456789012";
const LEAKABLE_KEY = "sk-LEAKABLECREDENTIAL0123456789";
const FINAL_TEXT = "The deed is translated, and the answer is the recipient's own.";

type SeenCall = { slug: string; apiKey: string; baseUrl: string; system: string };
const seen = vi.hoisted(() => ({ calls: [] as SeenCall[] }));
const isolated = vi.hoisted(() => ({ db: null as MySql2Database<typeof schema & typeof relations> | null }));

vi.mock("../queries/connection", () => ({
  getDb: () => {
    if (!isolated.db) throw new Error("Isolated feedback-attachment test database is not initialized");
    return isolated.db;
  },
}));

// The only adapter in the process: asserting on `seen.calls` is proof that no
// real provider was contacted, and the echo makes the hardest leakage case real.
vi.mock("../lib/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/providers")>();
  return {
    ...actual,
    createProviderAdapter: (slug: string, apiKey: string, baseUrl: string, defaultModel: string) => ({
      name: "Fake", slug, defaultBaseUrl: baseUrl, supportedModels: [defaultModel],
      async chat(messages: Array<{ role: string; content: string }>) {
        const system = String(messages[0]?.content ?? "");
        seen.calls.push({ slug, apiKey, baseUrl, system });
        return {
          content: system.includes("NOVEMBER") ? `ECHO: ${system}` : FINAL_TEXT,
          usage: { promptTokens: 9, completionTokens: 4, totalTokens: 13 },
          model: defaultModel, latencyMs: 3,
        };
      },
      async validateKey() { return { valid: true }; },
      async listModels() { return [defaultModel]; },
    }),
  };
});

// Provider rate limiting is not part of this battery; without this a two-step
// run in the same millisecond throttles on step 2.
vi.mock("../lib/providerThrottle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/providerThrottle")>();
  return {
    ...actual,
    acquireProviderSlot: async () => ({ ok: true as const }),
    reportProviderResult: async () => undefined,
  };
});

import { DEFAULT_CONSENT_VERSION } from "../services/evidenceService";

let fb: typeof import("./feedback");
let adminMod: typeof import("./admin");
let share: typeof import("../services/pipelineSharing");
let sw: typeof import("../services/swarmService");
let TOOLS: typeof import("../mcp/tools/index").TOOLS;
let encryptKey: (plain: string) => string;
let admin: mysql.Connection | undefined;
let pool: mysql.Pool | undefined;
let ownsDatabase = false;

beforeAll(async () => {
  if (process.env.NODE_ENV === "production") throw new Error("Feedback attachment tests refuse production mode");
  process.env.NODE_ENV = "development";
  process.env.REDIS_URL = "";
  process.env.APP_SECRET ||= "1".repeat(64);
  process.env.AI_SWARM_MASTER_KEY ||= "2".repeat(64);
  process.env.MARKETPLACE_MASTER_KEY ||= "3".repeat(64);

  // Same local root URL (and same refusal-without-it convention) as every other
  // throwaway-DB integration file here.
  const url = new URL(process.env.MYSQL_ROOT_URL || "mysql://root:rootpass@localhost:3307");
  const connection = {
    host: url.hostname, port: Number(url.port || 3307),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
  };
  admin = await mysql.createConnection(connection);
  const [lock] = await admin.query<mysql.RowDataPacket[]>("SELECT GET_LOCK(?, 0) AS acquired", [TEST_DB]);
  if (lock[0].acquired !== 1) throw new Error("Another feedback-attachment fixture is running");
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

  fb = await import("./feedback");
  adminMod = await import("./admin");
  share = await import("../services/pipelineSharing");
  sw = await import("../services/swarmService");
  TOOLS = (await import("../mcp/tools/index")).TOOLS;
  const crypto = await import("../services/cryptoService");
  encryptKey = (plain) => crypto.encrypt(plain, crypto.getMasterKey()).encrypted;

  await seed();
}, 420_000);

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
const insertId = (res: unknown) => Number((res as { insertId: number }).insertId);
type UserRow = schema.User;

function asUser(user: UserRow) {
  return fb.feedbackRouter.createCaller({
    req: new Request("http://localhost"), resHeaders: new Headers(),
    user, requestId: `d11-${user.id}`, remoteIp: "test-fixture",
  } as unknown as Parameters<typeof fb.feedbackRouter.createCaller>[0]);
}
function asAdmin(user: UserRow) {
  return adminMod.adminRouter.createCaller({
    req: new Request("http://localhost"), resHeaders: new Headers(),
    user, requestId: `d11-admin-${user.id}`, remoteIp: "test-fixture",
  } as unknown as Parameters<typeof adminMod.adminRouter.createCaller>[0]);
}
const mcpCtx = (userId: number): McpAuthContext => ({
  userId, scopes: new Set(["mcp:read", "mcp:write", "mcp:run"]),
  clientId: "d11-test", requestId: `d11-${userId}`, locale: "en",
});
const mcpTool = (name: string) => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`MCP tool ${name} is not registered`);
  return tool;
};

/** The refusal a call produced, code and message both, so a TRPCError
 *  (FORBIDDEN) and a plain service code (`consent_required`) can each be
 *  matched on what is actually distinctive about them. */
async function refusal(call: Promise<unknown>): Promise<string> {
  return await call.then(
    () => "<resolved — no refusal>",
    (err: unknown) => {
      const e = err as { code?: string; message?: string; data?: { code?: string } };
      return `${e.code ?? e.data?.code ?? ""} ${e.message ?? String(err)}`.trim();
    },
  );
}
const feedbackCount = async () => Number((await db()
  .select({ total: count() }).from(schema.feedback))[0].total);
const attachmentCount = async () => Number((await db()
  .select({ total: count() }).from(schema.feedbackAttachments))[0].total);
const attachmentRows = async (feedbackId: number) => db().select().from(schema.feedbackAttachments)
  .where(eq(schema.feedbackAttachments.feedbackId, feedbackId))
  .orderBy(schema.feedbackAttachments.id);

async function mkUser(label: string, role: "user" | "admin" = "user"): Promise<UserRow> {
  const stamp = `${Date.now()}-${Math.random()}`;
  const [res] = await db().insert(schema.users).values({
    name: label, email: `${label}-${stamp}@example.test`,
    username: `${label.replace(/\W+/g, "").toLowerCase()}-${stamp}`.slice(0, 100),
    role, tier: "standard",
  });
  const [row] = await db().select().from(schema.users).where(eq(schema.users.id, insertId(res))).limit(1);
  return row;
}

let users: { owner: UserRow; lender: UserRow; grantee: UserRow; outsider: UserRow; adminUser: UserRow };
let ownerProjectId = 0;
let ownerRunId = 0;
let ownerResponseId = 0;
let ownerBenchmarkId = 0;
let lenderProjectId = 0;
let sharedRunId = 0;
let leakyProjectId = 0;

async function seed() {
  const d = db();
  const owner = await mkUser("Attachment owner");
  const lender = await mkUser("Lender");
  const grantee = await mkUser("Grantee");
  const outsider = await mkUser("Outsider");
  const adminUser = await mkUser("Support admin", "admin");
  users = { owner, lender, grantee, outsider, adminUser };

  // ── the owner's own pipeline, and a completed run of it (positive control) ──
  const [proj] = await d.insert(schema.projects).values({ userId: owner.id, name: "Owner pipeline" });
  ownerProjectId = insertId(proj);
  const [ownerProvider] = await d.insert(schema.llmProviders).values({
    userId: owner.id, name: `owner-${owner.id}`, slug: "openai", baseUrl: "https://api.owner.test/v1",
    apiKeyRef: encryptKey("sk-owner-OWN-KEY-abcdef0123456789"), defaultModel: "owner-model",
  });
  await d.insert(schema.pipelineSteps).values({
    projectId: ownerProjectId, stepOrder: 1, stepType: "agent", name: "Draft", role: "builder",
    systemPrompt: OWN_PROMPT, isEnabled: true,
    providerId: insertId(ownerProvider), model: "owner-model",
  });
  const [run] = await d.insert(schema.swarmRuns).values({
    projectId: ownerProjectId, userId: owner.id, userPrompt: "my own brief",
    status: "completed", currentStep: "done", pipelineVersion: "custom-v2",
    runParams: { source: "execute", prompt: "my own brief", stateless: true },
    totalTokensUsed: 18, totalLatencyMs: 42,
  });
  ownerRunId = insertId(run);
  const [agentRun] = await d.insert(schema.agentRuns).values({
    swarmRunId: ownerRunId, projectId: ownerProjectId, agentName: "Draft", agentRole: "builder",
    pipelineStep: 1, userPrompt: "my own brief", systemPrompt: OWN_PROMPT,
    contextInput: OWN_CONTEXT, status: "completed", tokensUsed: 18, latencyMs: 42,
    modelUsed: "owner-model",
  });
  const [resp] = await d.insert(schema.agentResponses).values({
    agentRunId: insertId(agentRun), swarmRunId: ownerRunId, projectId: ownerProjectId,
    responseType: "raw", content: "the owner's own answer",
    metadata: {
      model: "owner-model", provider: "openai", providerSlug: "openai",
      tokensUsed: { prompt: 9, completion: 4, total: 13 }, latencyMs: 42,
      temperature: 0.7, maxTokens: 1024, agentName: "Draft", agentRole: "builder",
      agentSlug: "draft", pipelineStep: 1, iteration: 1, buildMethod: "manual",
      sourceResponseIds: [],
    },
  });
  await d.update(schema.swarmRuns).set({ finalResponseId: insertId(resp) })
    .where(eq(schema.swarmRuns.id, ownerRunId));
  ownerResponseId = insertId(resp);

  // ── the owner's own benchmark (no frozen plan, so no case texts to carry) ──
  const [bench] = await d.insert(schema.benchmarks).values({
    ownerId: owner.id, executionMode: "grade_only", state: "completed",
    summary: '{"cases":3,"meanScore":0.8}', sourceProjectId: ownerProjectId,
  });
  ownerBenchmarkId = insertId(bench);

  // ── the lender's pipeline, shared `run_only`, and a REAL run of it ──
  const [lenderProvider] = await d.insert(schema.llmProviders).values({
    userId: lender.id, name: `lender-${lender.id}`, slug: "openai", baseUrl: "https://api.lender.test/v1",
    apiKeyRef: encryptKey(LENDER_KEY), defaultModel: LENDER_MODEL,
  });
  const [grantProvider] = await d.insert(schema.llmProviders).values({
    userId: grantee.id, name: `grantee-${grantee.id}`, slug: "openai", baseUrl: "https://api.grantee.test/v1",
    apiKeyRef: encryptKey(GRANTEE_KEY), defaultModel: "grantee-model",
  });
  const [lproj] = await d.insert(schema.projects).values({ userId: lender.id, name: "Lender pipeline" });
  lenderProjectId = insertId(lproj);
  // TWO steps, exactly as the a12 and pipelineSharing batteries do: the fake
  // adapter echoes step 1's prompt into step 1's OUTPUT, so the secret is
  // genuinely stored for this run and only a real projection can be relied on
  // to drop it — while step 2 still produces a clean final answer.
  await d.insert(schema.pipelineSteps).values([
    {
      projectId: lenderProjectId, stepOrder: 1, stepType: "agent", name: "Draft", role: "builder",
      systemPrompt: LENDER_PROMPT, isEnabled: true,
      providerId: insertId(lenderProvider), model: LENDER_MODEL,
    },
    {
      projectId: lenderProjectId, stepOrder: 2, stepType: "agent", name: "Polish", role: "polisher",
      systemPrompt: "Make the translation presentation-ready.", isEnabled: true,
      providerId: insertId(lenderProvider), model: LENDER_MODEL,
    },
  ]);
  await share.sharePipeline(lender.id, { projectId: lenderProjectId, granteeId: grantee.id, mode: "run_only" });

  seen.calls.length = 0;
  const receipt = await share.startSharedRun({
    granteeId: grantee.id, projectId: lenderProjectId, input: "Translate clause 4.",
    providerId: insertId(grantProvider),
    dispatch: async (runId, userId) => { await sw.executeSwarmRun({ swarmRunId: runId, userId }); },
  });
  const [sharedRun] = await d.select().from(schema.swarmRuns)
    .where(eq(schema.swarmRuns.id, receipt.swarmRunId)).limit(1);
  if (sharedRun.status !== "completed") {
    throw new Error(`shared run did not complete: ${sharedRun.status} ${sharedRun.error ?? ""}`);
  }
  sharedRunId = sharedRun.id;
  // Execution really happened on the LENDER's prompt, through the lender's own
  // step, on the recipient's key: without this every "no leak" assertion below
  // would be vacuous.
  expect(seen.calls.map((c) => c.system)).toEqual([LENDER_PROMPT, "Make the translation presentation-ready."]);
  expect([...new Set(seen.calls.map((c) => c.apiKey))]).toEqual([GRANTEE_KEY]);
  expect([...new Set(seen.calls.map((c) => c.baseUrl))]).toEqual(["https://api.grantee.test/v1"]);
  // The echoed secret IS in the database for this run, in a stored
  // intermediate — the attachment has to drop it, not never have met it.
  const intermediates = await d.select().from(schema.agentResponses)
    .where(eq(schema.agentResponses.swarmRunId, sharedRunId));
  expect(intermediates.some((r) => /LENDER PROMPT NOVEMBER/.test(r.content))).toBe(true);
  expect(intermediates.length).toBeGreaterThan(1);

  // ── a pipeline whose own text carries a credential, for the refusal case ──
  const [leaky] = await d.insert(schema.projects).values({ userId: owner.id, name: "Leaky pipeline" });
  leakyProjectId = insertId(leaky);
  await d.insert(schema.pipelineSteps).values({
    projectId: leakyProjectId, stepOrder: 1, stepType: "agent", name: "Draft", role: "builder",
    systemPrompt: `Paste your key ${LEAKABLE_KEY} into the request.`, isEnabled: true,
  });
}

// ─────────────────────────────────────────────────────────────────────

describe("D11 consented feedback attachments (isolated localhost MySQL)", () => {
  it("(a) attaches an OWNED run, pipeline and benchmark with the real detail, recording the consent version", async () => {
    const res = await asUser(users.owner).submit({
      projectId: ownerProjectId, targetType: "general", feedbackType: "bug", severity: "major",
      content: "my run stops after step 1",
      attachments: [
        { kind: "run", refId: ownerRunId, consent: true },
        { kind: "pipeline", refId: ownerProjectId, consent: true },
        { kind: "benchmark", refId: ownerBenchmarkId, consent: true },
      ],
    });
    expect(res.success).toBe(true);
    expect(res.attachments.map((a) => a.kind)).toEqual(["run", "pipeline", "benchmark"]);
    // Consent is RECORDED, and the version is the server's own constant — not a
    // second literal invented for this feature.
    for (const a of res.attachments) {
      expect(a.consentVersion).toBe(DEFAULT_CONSENT_VERSION);
      expect(a.visibility).toBe("owner_full");
    }

    const rows = await attachmentRows(res.id);
    expect(rows).toHaveLength(3);
    const runRow = rows.find((r) => r.kind === "run")!;
    // The positive control: redaction is scoped to protected objects, so an
    // owner's own attachment carries their own prompts and context.
    expect(runRow.snapshot).toContain(OWN_PROMPT);
    expect(runRow.snapshot).toContain(OWN_CONTEXT);
    expect(runRow.snapshot).toContain("the owner's own answer");
    expect(JSON.parse(runRow.snapshot).visibility).toBe("owner_full");
    // The provider credential on the owner's own row is not carried either:
    // attachments describe work, they do not collect secrets.
    expect(runRow.snapshot).not.toContain("sk-owner-OWN-KEY");
    const pipelineRow = rows.find((r) => r.kind === "pipeline")!;
    expect(pipelineRow.snapshot).toContain(OWN_PROMPT);
    expect(pipelineRow.snapshot).toContain("Owner pipeline");
    const benchmarkRow = rows.find((r) => r.kind === "benchmark")!;
    expect(JSON.parse(benchmarkRow.snapshot)).toMatchObject({ state: "completed", executionMode: "grade_only" });
  });

  it("(b) attaches a run_only shared run and the borrowed definition with NOTHING of the lender's", async () => {
    const before = await attachmentCount();
    const res = await asUser(users.grantee).submit({
      targetType: "general", feedbackType: "confusion", severity: "minor",
      content: "the shared pipeline gave a strange answer",
      attachments: [
        { kind: "run", refId: sharedRunId, consent: true },
        { kind: "pipeline", refId: lenderProjectId, consent: true },
      ],
    });
    expect(res.attachments.map((a) => a.visibility))
      .toEqual(["redacted_run_only_share", "redacted_run_only_share"]);
    expect(await attachmentCount()).toBe(before + 2);

    const rows = await attachmentRows(res.id);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // Not the lender's prompt text, not their provider credential (plaintext
      // or ciphertext), not the model their step pins.
      expect(row.snapshot).not.toMatch(LENDER_MARKERS);
      expect(row.snapshot).not.toContain(LENDER_KEY);
      expect(row.snapshot).not.toContain("sk-lender");
      expect(row.snapshot).not.toContain(LENDER_MODEL);
      // The recipient's own key is theirs, but a provider binding has no
      // business in an attachment either.
      expect(row.snapshot).not.toContain(GRANTEE_KEY);
    }
    // …and the attachment is still USEFUL, which is the other half of the
    // invariant: it is what this run's own owner can see, and nothing more.
    const runSnapshot = JSON.parse(rows.find((r) => r.kind === "run")!.snapshot) as {
      mode: string; visibility: string; recipientVisibilityNote: string;
      finalOutput: string | null; progress: unknown[];
    };
    expect(runSnapshot.mode).toBe("run_only");
    // The snapshot's OWN record of which entitlement produced it, not the
    // borrowed projection's prose field — a summary read depends on telling
    // these two apart, so the marker has to survive the merge.
    expect(runSnapshot.visibility).toBe("redacted_run_only_share");
    expect(runSnapshot.recipientVisibilityNote).toContain("never stored");
    expect(runSnapshot.finalOutput).toBe(FINAL_TEXT);
    expect(runSnapshot.progress).toHaveLength(2);
    // The step rows the projection reaches for carry no model column at all,
    // so there is no `modelUsed` to withhold on this surface either.
    expect(JSON.stringify(runSnapshot.progress)).not.toContain("modelUsed");
    // The definition attachment is step IDENTITY only, with the reason stated.
    const pipelineSnapshot = JSON.parse(rows.find((r) => r.kind === "pipeline")!.snapshot) as {
      steps: Array<Record<string, unknown>>; withheld: string | null; accessGrantedToCaller: string;
    };
    expect(pipelineSnapshot.accessGrantedToCaller).toBe("run_only");
    expect(pipelineSnapshot.steps.map((s) => s.name)).toEqual(["Draft", "Polish"]);
    expect(pipelineSnapshot.steps[0]).not.toHaveProperty("systemPrompt");
    expect(pipelineSnapshot.steps[0]).not.toHaveProperty("model");
    expect(pipelineSnapshot.withheld).toContain("not to read");
  });

  it("(c) refuses an unconsented attachment and writes nothing at all", async () => {
    const caller = asUser(users.owner);
    const beforeFeedback = await feedbackCount();
    const beforeAttachments = await attachmentCount();

    const message = await refusal(caller.submit({
      targetType: "general", feedbackType: "bug", severity: "minor",
      content: "please attach nothing",
      attachments: [{ kind: "run", refId: ownerRunId, consent: false }],
    }));
    // tRPC wraps a thrown domain code as INTERNAL_SERVER_ERROR, exactly as
    // every other refusal in this codebase does; the CODE is the contract, and
    // it is the first thing in the message.
    expect(message).toMatch(/consent_required: nothing can be attached/);
    // A half-attached receipt is not a receipt: the feedback row is refused too.
    expect(await feedbackCount()).toBe(beforeFeedback);
    expect(await attachmentCount()).toBe(beforeAttachments);

    // An absent consent field is the same refusal, never a default.
    const missing = await refusal((async () => {
      return caller.submit({
        targetType: "general", feedbackType: "bug", severity: "minor", content: "x",
        // @ts-expect-error — `consent` is deliberately omitted.
        attachments: [{ kind: "run", refId: ownerRunId }],
      });
    })());
    expect(missing).toMatch(/consent|invalid_type|expected boolean/i);
    expect(await feedbackCount()).toBe(beforeFeedback);
    expect(await attachmentCount()).toBe(beforeAttachments);
  });

  it("(d) refuses another account's object with the not-found-shaped code, for all three kinds", async () => {
    const outsider = asUser(users.outsider);
    const beforeFeedback = await feedbackCount();
    const beforeAttachments = await attachmentCount();
    for (const [kind, refId] of [
      ["run", ownerRunId], ["pipeline", ownerProjectId], ["benchmark", ownerBenchmarkId],
    ] as const) {
      const message = await refusal(outsider.submit({
        targetType: "general", feedbackType: "bug", severity: "minor",
        content: `I would like to attach someone else's ${kind}`,
        attachments: [{ kind, refId, consent: true }],
      }));
      // The same refusal shape as the rest of the codebase: no existence leak.
      expect(`${kind}: ${message}`).toMatch(/not_found_or_not_authorized/);
    }
    // A grant names its recipient: the lender's pipeline is not the outsider's.
    expect(await refusal(outsider.submit({
      targetType: "general", feedbackType: "bug", severity: "minor", content: "not mine",
      attachments: [{ kind: "pipeline", refId: lenderProjectId, consent: true }],
    }))).toMatch(/not_found_or_not_authorized/);
    // Even the grantee cannot attach the LENDER's own run of it.
    expect(await refusal(asUser(users.grantee).submit({
      targetType: "general", feedbackType: "bug", severity: "minor", content: "not my run",
      attachments: [{ kind: "run", refId: ownerRunId, consent: true }],
    }))).toMatch(/not_found_or_not_authorized/);

    expect(await feedbackCount()).toBe(beforeFeedback);
    expect(await attachmentCount()).toBe(beforeAttachments);
  });

  it("lets the author read their own attachments back and refuses anyone else", async () => {
    const caller = asUser(users.owner);
    const submitted = await caller.submit({
      targetType: "general", feedbackType: "suggestion", severity: "minor",
      content: "read back what I consented to",
      attachments: [{ kind: "run", refId: ownerRunId, consent: true }],
    });
    const mine = await caller.attachments({ feedbackId: submitted.id });
    expect(mine.attachments).toHaveLength(1);
    expect(mine.attachments[0]).toMatchObject({
      kind: "run", refId: ownerRunId, consentVersion: DEFAULT_CONSENT_VERSION, visibility: "owner_full",
    });
    expect(JSON.stringify(mine.attachments[0].snapshot)).toContain(OWN_PROMPT);
    // Another account cannot read it by a guessed feedback id, and cannot
    // learn whether the id exists.
    expect(await refusal(asUser(users.outsider).attachments({ feedbackId: submitted.id })))
      .toMatch(/not_found_or_not_authorized/);
  });

  it("(e) gives support the summaries without the payload, and the payload only to an audited admin read", async () => {
    const support = asAdmin(users.adminUser);
    const list = await support.listAllFeedback({ page: 1, pageSize: 50 });
    const withAttachments = list.items.filter((i) => i.attachmentCount > 0);
    expect(withAttachments.length, "the support list shows no attachments at all").toBeGreaterThan(0);
    for (const item of withAttachments) {
      expect(item.attachments).toHaveLength(item.attachmentCount);
      expect(item.attachments[0]).toMatchObject({
        consentVersion: DEFAULT_CONSENT_VERSION,
        kind: expect.stringMatching(/^(pipeline|run|benchmark)$/),
      });
      expect(typeof item.attachments[0].title).toBe("string");
    }
    // A list screen does not drag every attached prompt across the wire: the
    // summary carries kind, id, consent version and visibility, the payload is
    // a separate read.
    expect(JSON.stringify(list.items)).not.toContain(OWN_PROMPT);
    expect(JSON.stringify(list.items)).not.toMatch(LENDER_MARKERS);
    // And the summary still says WHICH of the two cases each attachment is, so
    // support knows before opening anything that a borrowed object arrived
    // redacted. This is the field a projection's own prose `visibility` used to
    // overwrite.
    const redactedSummaries = withAttachments
      .flatMap((i) => i.attachments)
      .filter((a) => a.visibility !== "owner_full");
    expect(redactedSummaries.length).toBeGreaterThanOrEqual(2);
    expect(redactedSummaries.every((a) => a.visibility === "redacted_run_only_share")).toBe(true);

    // `attachmentCount` is a CORRELATED count. Written with an interpolated
    // `${feedback.id}` — which drizzle emits UNQUALIFIED, and MySQL then binds
    // to the subquery's own table (finding #36, fixed in `99ffa9b`) — every row
    // would come back with the same constant. So the exact numbers are pinned.
    const counts = list.items.map((i) => i.attachmentCount);
    expect(counts).toContain(3);
    expect(counts).toContain(2);
    expect(counts).toContain(1);
    expect(new Set(counts.filter((c) => c > 0)).size).toBeGreaterThan(1);

    // The payload read is admin-only and audited, and the audit names the ids
    // rather than the content it just disclosed.
    const [row] = await db().select().from(schema.feedbackAttachments)
      .where(eq(schema.feedbackAttachments.kind, "pipeline"))
      .orderBy(schema.feedbackAttachments.id).limit(1);
    const detail = await support.feedbackAttachmentDetail({ attachmentId: row.id });
    expect(detail).toMatchObject({ id: row.id, kind: "pipeline", consentVersion: DEFAULT_CONSENT_VERSION });
    expect(JSON.stringify(detail.snapshot)).toContain(OWN_PROMPT);
    const audit = await db().select().from(schema.adminAuditLog)
      .where(eq(schema.adminAuditLog.action, "feedback.read_attachment"));
    expect(audit.length).toBeGreaterThan(0);
    // The audit names the ids it disclosed, never the content itself.
    expect(JSON.stringify(audit)).not.toContain(OWN_PROMPT);

    // A non-admin is refused on both, and the refusal writes no audit row.
    const beforeAudit = audit.length;
    expect(await refusal(asAdmin(users.outsider).listAllFeedback({ page: 1, pageSize: 10 })))
      .toMatch(/FORBIDDEN|Insufficient permissions/);
    expect(await refusal(asAdmin(users.outsider).feedbackAttachmentDetail({ attachmentId: row.id })))
      .toMatch(/FORBIDDEN|Insufficient permissions/);
    const afterAudit = await db().select().from(schema.adminAuditLog)
      .where(eq(schema.adminAuditLog.action, "feedback.read_attachment"));
    expect(afterAudit.length).toBe(beforeAudit);
  });

  it("refuses to file a credential that rides along in the text, and does not echo it back", async () => {
    const before = await attachmentCount();
    const message = await refusal(asUser(users.owner).submit({
      targetType: "general", feedbackType: "bug", severity: "minor",
      content: "attaching the pipeline that embeds a key",
      attachments: [{ kind: "pipeline", refId: leakyProjectId, consent: true }],
    }));
    expect(message).toMatch(/attachment_credential_refused: the snapshot of this pipeline/);
    expect(message).not.toContain(LEAKABLE_KEY);
    expect(await attachmentCount()).toBe(before);
  });

  it("offers the caller a picker of LABELS only, and caps a submission at the documented number of opt-ins", async () => {
    const picker = await asUser(users.owner).attachable({ projectId: ownerProjectId });
    expect(picker.maxPerFeedback).toBe(5);
    expect(picker.consentVersion).toBe(DEFAULT_CONSENT_VERSION);
    expect(picker.pipelines.map((p) => p.refId)).toContain(ownerProjectId);
    expect(picker.runs.map((r) => r.refId)).toContain(ownerRunId);
    expect(picker.benchmarks.map((b) => b.refId)).toContain(ownerBenchmarkId);
    // Labels, not content: the picker is not a way around the projections.
    expect(JSON.stringify(picker)).not.toContain(OWN_PROMPT);
    expect(JSON.stringify(picker)).not.toContain(OWN_CONTEXT);

    // An account a pipeline was shared onto is offered it — and gets the
    // redacted snapshot, as the router case above proves.
    const granteePicker = await asUser(users.grantee).attachable({});
    const shared = granteePicker.pipelines.find((p) => p.refId === lenderProjectId);
    expect(shared).toBeDefined();
    expect(shared?.owned).toBe(false);
    expect(granteePicker.runs.map((r) => r.refId)).toContain(sharedRunId);

    const message = await refusal(asUser(users.owner).submit({
      targetType: "general", feedbackType: "bug", severity: "minor", content: "too many",
      attachments: Array.from({ length: 6 }, () => ({ kind: "run" as const, refId: ownerRunId, consent: true as const })),
    }));
    // ONE wording at both boundaries (#38): the input schema's bound now carries
    // the service's own message, so a caller cannot get "too_big" from one
    // surface and `too_many_attachments` from another — and it stays a 4xx, not
    // the 500 a plain thrown error would have become.
    expect(message).toContain(
      "too_many_attachments: a feedback item may carry at most 5 attachments — each one is a separate opt-in, not an export",
    );
    expect(message.startsWith("BAD_REQUEST ")).toBe(true);
  });

  it("holds the same two rules from the MCP workbench, and registers the tool ungated with a guide entry", async () => {
    const tool = mcpTool("send_feedback");
    expect(tool.requiredScopes).toEqual(["mcp:write"]);
    // An account-scoped write carries no flag, so the guide cannot promise a
    // lock the server does not enforce (`registry.test.ts` pins the pair).
    expect(tool.featureFlag).toBeUndefined();
    expect(tool.description.length).toBeGreaterThan(30);

    const result = await tool.handler({
      targetType: "general", feedbackType: "bug", severity: "minor",
      content: "sent from the workbench",
      attachments: [{ kind: "run", refId: sharedRunId, consent: true }],
    }, mcpCtx(users.grantee.id)) as {
      id: number;
      attachments: Array<{ kind: string; refId: number; consentVersion: string; visibility: string }>;
      attachmentsWithMeaning: Array<{ redacted: boolean; note: string }>;
    };
    expect(result.attachments[0]).toMatchObject({
      kind: "run", refId: sharedRunId, consentVersion: DEFAULT_CONSENT_VERSION,
      visibility: "redacted_run_only_share",
    });
    expect(result.attachmentsWithMeaning[0].redacted).toBe(true);
    const [row] = await db().select().from(schema.feedbackAttachments)
      .where(and(
        eq(schema.feedbackAttachments.feedbackId, result.id),
        eq(schema.feedbackAttachments.kind, "run"),
      )).limit(1);
    expect(row.snapshot).not.toMatch(LENDER_MARKERS);
    expect(row.snapshot).not.toContain(LENDER_MODEL);

    // The same consent rule, the same ownership rule, from this surface too.
    await expect(tool.handler({
      targetType: "general", feedbackType: "bug", severity: "minor", content: "no consent",
      attachments: [{ kind: "run", refId: sharedRunId, consent: false }],
    }, mcpCtx(users.grantee.id))).rejects.toThrow(/^consent_required:/);
    await expect(tool.handler({
      targetType: "general", feedbackType: "bug", severity: "minor", content: "not mine",
      attachments: [{ kind: "run", refId: ownerRunId, consent: true }],
    }, mcpCtx(users.outsider.id))).rejects.toThrow(/not_found_or_not_authorized/);
  });

  it("refuses to file a report against a project or message the caller cannot see", async () => {
    const before = await feedbackCount();
    // A stranger cannot attribute a report to the owner's pipeline…
    expect(await refusal(asUser(users.outsider).submit({
      targetType: "general", feedbackType: "bug", severity: "minor",
      content: "naming a project that is not mine", projectId: ownerProjectId,
    }))).toMatch(/not_found_or_not_authorized/);
    // …nor to one of the owner's messages.
    expect(await refusal(asUser(users.outsider).submit({
      targetType: "message", feedbackType: "bug", severity: "minor",
      content: "naming a message that is not mine", targetMessageId: ownerResponseId,
    }))).toMatch(/not_found_or_not_authorized/);
    expect(await refusal(asUser(users.outsider).reactToMessage({
      projectId: ownerProjectId, messageId: ownerResponseId, reaction: "down",
    }))).toMatch(/not_found_or_not_authorized/);
    // An id that resolves to nothing answers identically: nothing is probeable.
    expect(await refusal(asUser(users.owner).submit({
      targetType: "message", feedbackType: "bug", severity: "minor",
      content: "no such message", targetMessageId: 999_999,
    }))).toMatch(/not_found_or_not_authorized/);
    expect(await feedbackCount()).toBe(before);

    // The owner, on their own project and their own message: filed, both kept.
    const filed = await asUser(users.owner).submit({
      targetType: "message", feedbackType: "bug", severity: "minor",
      content: "my own message in my own project", projectId: ownerProjectId, targetMessageId: ownerResponseId,
    });
    expect(await feedbackCount()).toBe(before + 1);
    const [row] = await db().select().from(schema.feedback).where(eq(schema.feedback.id, filed.id));
    expect(row).toMatchObject({ userId: users.owner.id, projectId: ownerProjectId, targetMessageId: ownerResponseId });
    const reacted = await asUser(users.owner).reactToMessage({
      projectId: ownerProjectId, messageId: ownerResponseId, reaction: "up",
    });
    const [reaction] = await db().select().from(schema.feedback).where(eq(schema.feedback.id, reacted.id));
    expect(reaction).toMatchObject({ projectId: ownerProjectId, targetMessageId: ownerResponseId, feedbackType: "praise" });
  });

  it("scopes feedback lists, signed screenshots and stats to the author even with project filters", async () => {
    const author = await mkUser("Feedback isolation author");
    const other = await mkUser("Feedback isolation stranger");
    const [project] = await db().insert(schema.projects).values({ userId: author.id, name: "Private reports" });
    const projectId = insertId(project);
    const [report] = await db().insert(schema.feedback).values({
      userId: author.id, projectId, targetType: "ui", feedbackType: "bug", status: "new",
      content: "private feedback isolation marker", screenshotUrl: "/feedback-screenshots/isolation.png",
    });
    const reportId = insertId(report);
    const [otherReport] = await db().insert(schema.feedback).values({
      userId: other.id, targetType: "general", feedbackType: "praise", status: "closed", content: "other report",
    });
    const mine = await asUser(author).list({});
    expect(mine.map((r) => r.id)).toEqual([reportId]);
    expect(mine[0].screenshotUrl).toMatch(/^\/feedback-screenshots\/isolation\.png\?exp=\d+&sig=/);
    expect(await asUser(author).list({ projectId, status: "closed" })).toEqual([]);
    expect((await asUser(author).list({ projectId, feedbackType: "bug" })).map((r) => r.id)).toEqual([reportId]);
    expect((await asUser(other).list({})).map((r) => r.id)).toEqual([insertId(otherReport)]);
    expect(await asUser(other).list({ projectId })).toEqual([]);
    expect(await asUser(other).list({ projectId, limit: 1, offset: 0 })).toEqual([]);
    expect(await asUser(author).stats({})).toMatchObject({
      total: 1, open: 1, resolved: 0, byType: { bug: 1, praise: 0 }, byStatus: { new: 1, closed: 0 },
    });
    expect(await asUser(other).stats({})).toMatchObject({ total: 1, open: 0, resolved: 1 });
    expect(await asUser(other).stats({ projectId })).toMatchObject({ total: 0, open: 0, resolved: 0 });
    const support = await asAdmin(users.adminUser).listAllFeedback({ page: 1, pageSize: 100 });
    expect(support.items.map((r) => r.id)).toContain(reportId);
  });

  it("restricts feedback status and assignment to admins, including for the report author", async () => {
    const [report] = await db().insert(schema.feedback).values({
      userId: users.owner.id, targetType: "general", feedbackType: "bug", status: "new", content: "status boundary",
    });
    const feedbackId = insertId(report);
    for (const user of [users.owner, users.outsider]) {
      await expect(asUser(user).updateStatus({ feedbackId, status: "closed", assignedTo: user.id }))
        .rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    const [unchanged] = await db().select().from(schema.feedback).where(eq(schema.feedback.id, feedbackId));
    expect(unchanged).toMatchObject({ status: "new", assignedTo: null, resolvedAt: null });
    await asUser(users.adminUser).updateStatus({ feedbackId, status: "resolved", assignedTo: users.adminUser.id });
    const [updated] = await db().select().from(schema.feedback).where(eq(schema.feedback.id, feedbackId));
    expect(updated).toMatchObject({ status: "resolved", assignedTo: users.adminUser.id });
    expect(updated.resolvedAt).not.toBeNull();
  });

  it("restricts feedback issue conversion to admins without writing on refusal", async () => {
    const [report] = await db().insert(schema.feedback).values({
      userId: users.owner.id, projectId: ownerProjectId, targetType: "general",
      feedbackType: "bug", status: "new", content: "private issue conversion marker",
    });
    const feedbackId = insertId(report);
    const before = Number((await db().select({ total: count() }).from(schema.issues))[0].total);
    for (const user of [users.owner, users.outsider]) {
      await expect(asUser(user).convertToIssue({ feedbackId, title: "Unauthorized issue" }))
        .rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(Number((await db().select({ total: count() }).from(schema.issues))[0].total)).toBe(before);
    const [unchanged] = await db().select().from(schema.feedback).where(eq(schema.feedback.id, feedbackId));
    expect(unchanged).toMatchObject({ status: "new", convertedToIssueId: null });
    const result = await asUser(users.adminUser).convertToIssue({ feedbackId, title: "Support issue" });
    const [issue] = await db().select().from(schema.issues).where(eq(schema.issues.id, result.issueId));
    expect(issue).toMatchObject({ createdBy: users.adminUser.id, projectId: ownerProjectId, description: "private issue conversion marker" });
    const [converted] = await db().select().from(schema.feedback).where(eq(schema.feedback.id, feedbackId));
    expect(converted).toMatchObject({ status: "triaged", convertedToIssueId: result.issueId });
  });
});
