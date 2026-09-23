// Consented feedback attachments (D11, ticket #22) — SERVICE-level DB-backed
// battery.
//
// The router file `api/routers/feedbackAttachments.integration.test.ts` proves
// the feature through tRPC and the MCP workbench. This one drives the module
// that actually decides what an attachment may hold —
// `api/services/feedbackAttachments.ts` — directly, against the real tables, so
// the guarantees are shown to belong to the service and not to whichever surface
// happens to call it. No LLM call anywhere: the provider adapter is the only
// mock (the `a12Leakage` / `pipelineSharing` pattern), and it echoes the
// grantor's/seller's step prompt into a STORED intermediate, which is what makes
// every "no leak" assertion below do real work instead of passing because the
// secret never existed.
//
// The invariants, which are the ones `db/migrations/033_feedback_attachments.sql`
// states — an attachment cannot widen anyone's entitlement, because the snapshot
// is built from projections the consenting account can already read:
//
//  1. CONSENT IS PER ITEM AND CANNOT BE ASSUMED. No consent → refused, and
//     neither a feedback row nor an attachment row is written. Consent → exactly
//     one row, whose `consentVersion` is the SERVER's `DEFAULT_CONSENT_VERSION`;
//     a caller that supplies its own consent string is stripped at the schema and
//     ignored at the service, so no one can pick an older or invented version.
//  2. AN OWNED OBJECT CARRIES ITS REAL CONTENT (the positive control that makes
//     3–4 meaningful rather than vacuous): the owner's own distinctive system and
//     user prompts, context input, answer and model are in the stored snapshot.
//  3. A `run_only` SHARED run — and the borrowed DEFINITION — carry NOTHING of
//     the lender's prompt text, model binding or credential, and say why.
//  4. A MARKETPLACE BUYER run carries NOTHING of the seller's definition, for the
//     same reason (the buyer's own projection, not the owner's).
//  5. NO PROBING BY ID: another account's pipeline / run / benchmark produces a
//     refusal BYTE-IDENTICAL to a non-existent id, for all three kinds.
//  6. THE SUPPORT READ IS GATED: the payload read is admin-only at the one place
//     that exposes it, the summaries carry no payload, and a plain read leaves
//     every table exactly as it found it.
//  7. THE CAP IS ENFORCED as a whole-submission decision: MAX+1 distinct,
//     genuinely attachable objects are refused with no partial set written, while
//     exactly MAX is accepted.
//
// Plus the module's own smaller promises: a benchmark attachment is the owner's
// STATUS shape and not the frozen plan's case texts, the picker returns labels
// only, an unparsable snapshot is reported rather than handed over as bytes, and
// a credential-shaped string in a snapshot is refused by category without being
// echoed.
//
// Own throwaway schema (`swarm_v2test_fbattach`) plus a `GET_LOCK` guard, so it
// cannot collide with the other integration files and cannot touch the local
// `swarm` database. The schema is pushed from `db/schema.ts`; migration 033 is
// applied by a human, never by a test.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import { count, eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import * as schema from "@db/schema";
import * as relations from "@db/relations";

const TEST_DB = "swarm_v2test_fbattach";

// Distinctive fragments, so a leak cannot be a false positive on common words —
// three separate secrets, because three separate entitlements are in play. The
// `sk-<name>-OWN-KEY-<digits>` shape is deliberately hyphen-broken inside the
// first 12 characters: it must be recognisable to a human as a credential and
// NOT api-key-shaped to `scanForSecrets`, which is what the positive-control
// snapshots have to survive.
const MY_PROMPT = "MYPROMPT WHISKEY: restate the user's own brief 4a71c3";
// The brief the owner typed. Deliberately NOT one of the markers below: the
// picker is allowed to show the first line of it as a label (it is the caller's
// own text), and only the step's system prompt, context input and answer are
// supposed to stay out of a label list.
const MY_USER_PROMPT = "MYBRIETTE: translate clause 4 into French 4a71c5";
const MY_CONTEXT = "MYCONTEXT SIERRA: the owner's own attached note 8b44";
const MY_ANSWER = "MYANSWER VICTOR: the owner's own finished text 2e19";
const MY_MODEL = "owner-visible-model";
const MY_KEY = "sk-owner-OWN-KEY-abcdef0123456789";
const MY_MARKERS = /MYPROMPT WHISKEY|MYCONTEXT SIERRA|MYANSWER VICTOR/;

const LENDER_PROMPT = "LENDER ZULU: read /vault/lenderdocs and stamp them 6d31";
const LENDER_MODEL = "lender-hidden-model";
const LENDER_KEY = "sk-lender-OWN-KEY-1234567890123";
const GRANTEE_KEY = "sk-grantee-OWN-KEY-123456789012";
const LENDER_MARKERS = /LENDER ZULU|vault\/lenderdocs|lender-hidden-model/;
const SHARED_FINAL = "The recipient's own finished answer.";

const SELLER_PROMPT = "SELLER XRAY: recite /vault/sellertable verbatim 5c27";
const SELLER_MODEL = "seller-hidden-model";
const SELLER_KEY = "sk-seller-OWN-KEY-123456789012";
const SELLER_MARKERS = /SELLER XRAY|vault\/sellertable|seller-hidden-model/;
const BUYER_FINAL = "The buyer's own finished answer.";

const BENCH_CASE = "BENCH CASE NOVEMBER: the owner's private case text 9f64";
const LEAKABLE_KEY = "sk-LEAKABLECREDENTIAL01234567890";
const APPROVED_URL = "https://api.example-provider.com/v1";

type SeenCall = { slug: string; apiKey: string; baseUrl: string; system: string };
const seen = vi.hoisted(() => ({ calls: [] as SeenCall[] }));
const isolated = vi.hoisted(() => ({ db: null as MySql2Database<typeof schema & typeof relations> | null }));

vi.mock("../queries/connection", () => ({
  getDb: () => {
    if (!isolated.db) throw new Error("Isolated feedback-attachment service test database is not initialized");
    return isolated.db;
  },
}));

// The only adapter in the process, so `seen.calls` is the proof that no real
// provider was contacted. The echo is the point: it puts the grantor's prompt
// text into a row the attachment must then drop.
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
          content: /LENDER ZULU/.test(system) || /SELLER XRAY/.test(system) ? `ECHO: ${system}`
            : /POLISH TANGO/.test(system) ? SHARED_FINAL : BUYER_FINAL,
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
// run dispatched in the same millisecond throttles on step 2.
vi.mock("../lib/providerThrottle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/providerThrottle")>();
  return {
    ...actual,
    acquireProviderSlot: async () => ({ ok: true as const }),
    reportProviderResult: async () => undefined,
  };
});

import { DEFAULT_CONSENT_VERSION } from "./evidenceService";

let fa: typeof import("./feedbackAttachments");
let share: typeof import("./pipelineSharing");
let ex: typeof import("./marketplaceExecutionService");
let sw: typeof import("./swarmService");
let adminMod: typeof import("../routers/admin");
let encryptKey: (plain: string) => string;
let admin: mysql.Connection | undefined;
let pool: mysql.Pool | undefined;
let ownsDatabase = false;

beforeAll(async () => {
  if (process.env.NODE_ENV === "production") throw new Error("Feedback attachment service tests refuse production mode");
  process.env.NODE_ENV = "development";
  process.env.REDIS_URL = "";
  process.env.APP_SECRET ||= "1".repeat(64);
  process.env.AI_SWARM_MASTER_KEY ||= "2".repeat(64);
  process.env.MARKETPLACE_MASTER_KEY ||= "3".repeat(64);

  // Same local root URL (and same localhost fallback) as every other
  // throwaway-DB integration file here.
  const url = new URL(process.env.MYSQL_ROOT_URL || "mysql://root:rootpass@localhost:3307");
  const connection = {
    host: url.hostname, port: Number(url.port || 3307),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
  };
  admin = await mysql.createConnection(connection);
  const [lock] = await admin.query<mysql.RowDataPacket[]>("SELECT GET_LOCK(?, 0) AS acquired", [TEST_DB]);
  if (lock[0].acquired !== 1) throw new Error("Another feedback-attachment service fixture is running");
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
    stdio: "pipe", timeout: 300_000,
  });
  pool = mysql.createPool({ ...connection, database: TEST_DB, connectionLimit: 4 });
  isolated.db = drizzle(pool, { schema: { ...schema, ...relations }, mode: "default" });

  fa = await import("./feedbackAttachments");
  share = await import("./pipelineSharing");
  ex = await import("./marketplaceExecutionService");
  sw = await import("./swarmService");
  adminMod = await import("../routers/admin");
  const crypto = await import("./cryptoService");
  encryptKey = (plain) => crypto.encrypt(plain, crypto.getMasterKey()).encrypted;

  await seed();
}, 480_000);

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

async function mkUser(label: string, role: "user" | "admin" = "user"): Promise<UserRow> {
  const stamp = `${Date.now()}-${Math.random()}`;
  const [res] = await db().insert(schema.users).values({
    name: label, email: `${label.replace(/\s+/g, "").toLowerCase()}-${stamp}@example.test`,
    username: `${label.replace(/\W+/g, "").toLowerCase()}-${stamp}`.slice(0, 100),
    role, tier: "standard",
  });
  const [row] = await db().select().from(schema.users).where(eq(schema.users.id, insertId(res))).limit(1);
  return row;
}

async function setFlag(key: string, enabled: boolean) {
  const d = db();
  const [existing] = await d.select({ id: schema.featureFlags.id }).from(schema.featureFlags)
    .where(eq(schema.featureFlags.key, key)).limit(1);
  if (existing) await d.update(schema.featureFlags).set({ enabled }).where(eq(schema.featureFlags.id, existing.id));
  else await d.insert(schema.featureFlags).values({ key, name: key, description: "test", enabled, rolloutPercent: 0 });
  (await import("../plugins/featureFlags")).resetFlagCache();
}

/** The support-side caller. `readAttachmentForSupport` has no gate of its own —
 *  the gate is `adminQuery`, and this is the one surface that exposes the
 *  payload — so the admin test needs a router, not a service call. */
function asAdmin(user: UserRow) {
  return adminMod.adminRouter.createCaller({
    req: new Request("http://localhost"), resHeaders: new Headers(),
    user, requestId: `d11-svc-${user.id}`, remoteIp: "test-fixture",
  } as unknown as Parameters<typeof adminMod.adminRouter.createCaller>[0]);
}

/** A refusal's message, so two refusals that must be indistinguishable can be
 *  compared byte for byte. Every error this module can raise — the domain codes
 *  (`consent_required`, `too_many_attachments`, `attachment_credential_refused`),
 *  `runAccess.NotVisibleError` and the sharing service's own error — puts its
 *  code first, so the code is asserted with `^code:`. */
async function refusal(call: Promise<unknown>): Promise<string> {
  return await call.then(
    () => "<resolved — no refusal>",
    (err: unknown) => {
      const e = err as { message?: string };
      return String(e.message ?? String(err));
    },
  );
}

/** Every table this module can touch, counted so "a read is a read" and "the
 *  refusal wrote nothing" are measured claims. `admin_audit_log` is NOT here on
 *  purpose: the audited support read is expected to add exactly one row, and
 *  that row is checked separately. */
const COUNT_QUERIES = [
  () => one(schema.feedback), () => one(schema.feedbackAttachments), () => one(schema.users),
  () => one(schema.projects), () => one(schema.swarmRuns), () => one(schema.agentRuns),
  () => one(schema.agentResponses), () => one(schema.pipelineSteps), () => one(schema.pipelineShares),
  () => one(schema.pipelineVersions), () => one(schema.benchmarks), () => one(schema.callAttempts),
];
type Countable = import("drizzle-orm/mysql-core").MySqlTable;
async function one(table: Countable): Promise<number> {
  const [row] = await db().select({ total: count() }).from(table);
  return Number(row.total);
}
async function tableCounts(): Promise<number[]> {
  const out: number[] = [];
  for (const q of COUNT_QUERIES) out.push(await q());
  return out;
}
const feedbackCount = () => one(schema.feedback);
const attachmentCount = () => one(schema.feedbackAttachments);
const attachmentRows = (feedbackId: number) => db().select().from(schema.feedbackAttachments)
  .where(eq(schema.feedbackAttachments.feedbackId, feedbackId))
  .orderBy(schema.feedbackAttachments.id);

// ─── fixtures ────────────────────────────────────────────────────────
let owner!: UserRow;
let grantee!: UserRow;
let lender!: UserRow;
let buyer!: UserRow;
let seller!: UserRow;
let outsider!: UserRow;
let supportAdmin!: UserRow;

let ownerProjectId = 0;
let ownerRunId = 0;
let ownerBenchmarkId = 0;
let capRunIds: number[] = [];
let leakyProjectId = 0;
let lenderProjectId = 0;
let sharedRunId = 0;
let sharedRunFinalId = 0;
let buyerRunId = 0;
let buyerRunListingId = 0;
let buyerRunFinalId = 0;

const base = (content: string) => ({
  targetType: "general" as const, feedbackType: "bug" as const,
  severity: "major" as const, content,
});

async function seed() {
  const d = db();
  owner = await mkUser("Attachment owner");
  grantee = await mkUser("Share recipient");
  lender = await mkUser("Lender");
  buyer = await mkUser("Marketplace buyer");
  seller = await mkUser("Seller");
  outsider = await mkUser("Outsider");
  supportAdmin = await mkUser("Support admin", "admin");

  // ── 2: the owner's own pipeline and a completed run of it ──
  const [proj] = await d.insert(schema.projects).values({ userId: owner.id, name: "Owner pipeline" });
  ownerProjectId = insertId(proj);
  const [ownerProvider] = await d.insert(schema.llmProviders).values({
    userId: owner.id, name: `owner-${owner.id}`, slug: "openai", baseUrl: "https://api.owner.test/v1",
    apiKeyRef: encryptKey(MY_KEY), defaultModel: MY_MODEL,
  });
  await d.insert(schema.pipelineSteps).values({
    projectId: ownerProjectId, stepOrder: 1, stepType: "agent", name: "Draft", role: "builder",
    systemPrompt: MY_PROMPT, isEnabled: true, providerId: insertId(ownerProvider), model: MY_MODEL,
  });
  const [run] = await d.insert(schema.swarmRuns).values({
    projectId: ownerProjectId, userId: owner.id, userPrompt: MY_USER_PROMPT,
    status: "completed", currentStep: "done", pipelineVersion: "custom-v2",
    runParams: { source: "execute", prompt: MY_USER_PROMPT, stateless: true },
    totalTokensUsed: 13, totalLatencyMs: 42,
    startedAt: new Date("2026-09-01T08:00:00Z"), completedAt: new Date("2026-09-01T08:00:42Z"),
  });
  ownerRunId = insertId(run);
  const [agentRun] = await d.insert(schema.agentRuns).values({
    swarmRunId: ownerRunId, projectId: ownerProjectId, agentName: "Draft", agentRole: "builder",
    pipelineStep: 1, userPrompt: MY_USER_PROMPT, systemPrompt: MY_PROMPT, contextInput: MY_CONTEXT,
    status: "completed", tokensUsed: 13, latencyMs: 42, modelUsed: MY_MODEL, providerUsed: "openai",
  });
  const [resp] = await d.insert(schema.agentResponses).values({
    agentRunId: insertId(agentRun), swarmRunId: ownerRunId, projectId: ownerProjectId,
    responseType: "raw", content: MY_ANSWER,
    metadata: {
      model: MY_MODEL, provider: "openai", providerSlug: "openai",
      tokensUsed: { prompt: 9, completion: 4, total: 13 }, latencyMs: 42,
      temperature: 0.7, maxTokens: 1024, agentName: "Draft", agentRole: "builder",
      agentSlug: "draft", pipelineStep: 1, iteration: 1, buildMethod: "manual",
      sourceResponseIds: [],
    },
  });
  await d.update(schema.swarmRuns).set({ finalResponseId: insertId(resp) }).where(eq(schema.swarmRuns.id, ownerRunId));

  // ── 7: six more of the owner's OWN runs, so the cap is tested against real,
  //    individually attachable objects rather than a padded duplicate list ──
  capRunIds = [];
  for (let i = 0; i < 6; i++) {
    const [extra] = await d.insert(schema.swarmRuns).values({
      projectId: ownerProjectId, userId: owner.id, userPrompt: `cap run ${i}`,
      status: "completed", currentStep: "done", pipelineVersion: "custom-v2",
      runParams: { source: "execute", prompt: `cap run ${i}`, stateless: true },
    });
    capRunIds.push(insertId(extra));
  }

  // ── 8: the owner's benchmark, WITH a frozen plan whose case text is a
  //     distinctive secret: the attachment is the status shape, not the plan ──
  const [bench] = await d.insert(schema.benchmarks).values({
    ownerId: owner.id, executionMode: "grade_only", state: "completed",
    planHash: "e".repeat(64),
    plan: JSON.stringify({
      schemaVersion: 1, executionMode: "grade_only", judgmentKind: "rubric", generationRepeats: 1,
      cases: [{ stableCaseId: "c1", inputText: BENCH_CASE, origin: "user" }],
      candidates: [{ stableCandidateId: "pipeline-as-configured", strategy: "pipeline", baseVersionId: 1, decoding: {} }],
      judges: [{ slot: 1, providerId: 1, model: "judge-model-a" }],
      rubric: { versionRef: "rubric-fixture-1", dimensions: [], normalizedWeights: [] },
      validators: [], limits: { maxConcurrency: 1, deadlineMs: 1000, maxTokensPerCall: 100 },
      counts: {
        cases: 1, candidates: 1, generationRepeats: 1, judges: 1, stepsPerGeneration: 1,
        generationCalls: 1, judgingCalls: 1, generationPerCandidate: [],
      },
    }),
    summary: '{"cases":1,"meanScore":0.8,"BENCHSUMMARY":"GOLF 1c77"}',
    sourceProjectId: ownerProjectId,
  });
  ownerBenchmarkId = insertId(bench);

  // ── a pipeline whose own text carries a credential, for the last bar ──
  const [leaky] = await d.insert(schema.projects).values({ userId: owner.id, name: "Leaky pipeline" });
  leakyProjectId = insertId(leaky);
  await d.insert(schema.pipelineSteps).values({
    projectId: leakyProjectId, stepOrder: 1, stepType: "agent", name: "Draft", role: "builder",
    systemPrompt: `Paste your key ${LEAKABLE_KEY} into the request.`, isEnabled: true,
  });

  // ── 3: a real `run_only` share, granted and RUN through the interpreter ──
  const [lenderProvider] = await d.insert(schema.llmProviders).values({
    userId: lender.id, name: `lender-${lender.id}`, slug: "openai", baseUrl: "https://api.lender.test/v1",
    apiKeyRef: encryptKey(LENDER_KEY), defaultModel: LENDER_MODEL,
  });
  const [granteeProvider] = await d.insert(schema.llmProviders).values({
    userId: grantee.id, name: `grantee-${grantee.id}`, slug: "openai", baseUrl: "https://api.grantee.test/v1",
    apiKeyRef: encryptKey(GRANTEE_KEY), defaultModel: "grantee-model",
  });
  const [lproj] = await d.insert(schema.projects).values({ userId: lender.id, name: "Lender pipeline" });
  lenderProjectId = insertId(lproj);
  await d.insert(schema.pipelineSteps).values([
    {
      projectId: lenderProjectId, stepOrder: 1, stepType: "agent", name: "Draft", role: "builder",
      systemPrompt: LENDER_PROMPT, isEnabled: true, providerId: insertId(lenderProvider), model: LENDER_MODEL,
    },
    {
      projectId: lenderProjectId, stepOrder: 2, stepType: "agent", name: "Polish", role: "polisher",
      systemPrompt: "POLISH TANGO: make the translation presentation-ready.", isEnabled: true,
      providerId: insertId(lenderProvider), model: LENDER_MODEL,
    },
  ]);
  await share.sharePipeline(lender.id, { projectId: lenderProjectId, granteeId: grantee.id, mode: "run_only" });
  seen.calls.length = 0;
  const shared = await share.startSharedRun({
    granteeId: grantee.id, projectId: lenderProjectId, input: "Translate clause 4.",
    providerId: insertId(granteeProvider),
    dispatch: async (runId, userId) => { await sw.executeSwarmRun({ swarmRunId: runId, userId }); },
  });
  const [sharedRow] = await d.select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, shared.swarmRunId)).limit(1);
  if (sharedRow.status !== "completed") {
    throw new Error(`shared run did not complete: ${sharedRow.status} ${sharedRow.error ?? ""}`);
  }
  sharedRunId = sharedRow.id;
  sharedRunFinalId = Number(sharedRow.finalResponseId);
  // Execution really happened ON THE LENDER'S PROMPT and the echoed secret is
  // stored for this run: the attachment has to drop it, not never have met it.
  expect(seen.calls.map((c) => c.system)).toEqual([LENDER_PROMPT, "POLISH TANGO: make the translation presentation-ready."]);
  expect([...new Set(seen.calls.map((c) => c.apiKey))]).toEqual([GRANTEE_KEY]);
  const sharedIntermediates = await d.select().from(schema.agentResponses).where(eq(schema.agentResponses.swarmRunId, sharedRunId));
  expect(sharedIntermediates.filter((r) => r.content.includes("LENDER ZULU"))).toHaveLength(1);
  expect(sharedIntermediates.length).toBeGreaterThan(1);

  // ── 4: a real marketplace buyer run, through the protected execution path ──
  const [sellerProvider] = await d.insert(schema.llmProviders).values({
    userId: seller.id, name: `seller-${seller.id}`, slug: "openai", baseUrl: APPROVED_URL,
    apiKeyRef: encryptKey(SELLER_KEY), defaultModel: SELLER_MODEL,
  });
  const [sellerProject] = await d.insert(schema.projects).values({ userId: seller.id, name: "Seller pipeline" });
  const sellerProjectId = insertId(sellerProject);
  await d.insert(schema.pipelineSteps).values({
    projectId: sellerProjectId, stepOrder: 1, stepType: "agent", name: "Draft", role: "builder",
    systemPrompt: SELLER_PROMPT, isEnabled: true,
    providerId: insertId(sellerProvider), model: SELLER_MODEL,
  });
  const [version] = await d.insert(schema.pipelineVersions).values({
    ownerId: seller.id, sourceProjectId: sellerProjectId, versionNumber: 1,
    definition: JSON.stringify({
      steps: [
        {
          stepOrder: 1, name: "Draft", role: "builder", systemPrompt: SELLER_PROMPT,
          providerId: insertId(sellerProvider), model: SELLER_MODEL, temperature: "0.7",
          maxTokens: 1024, stepType: "agent", ifConfig: null, whileConfig: null,
        },
        {
          stepOrder: 2, name: "Finalize", role: "polisher", systemPrompt: "FINISH ROMAN: produce the closing note.",
          providerId: insertId(sellerProvider), model: SELLER_MODEL, temperature: "0.7",
          maxTokens: 1024, stepType: "agent", ifConfig: null, whileConfig: null,
        },
      ],
      sourceAgentIds: [],
    }),
    definitionHash: "a".repeat(64),
  });
  const [tpl] = await d.insert(schema.pipelineTemplates).values({
    userId: seller.id, name: `tpl-${seller.id}`, sourceProjectId: sellerProjectId,
    steps: [{ name: "Draft", role: "builder", systemPrompt: SELLER_PROMPT }],
  });
  const [listing] = await d.insert(schema.marketplaceListings).values({
    creatorId: seller.id, templateId: insertId(tpl), title: "Contract Redliner", price: "4.99", status: "published",
  });
  buyerRunListingId = insertId(listing);
  await d.insert(schema.marketplaceListingV2).values({
    listingId: buyerRunListingId, publicationMode: "v2", currentWorkflowVersionId: insertId(version),
    evidenceSummaryRevision: 1,
  });
  await d.insert(schema.marketplacePurchases).values({
    buyerId: buyer.id, listingId: buyerRunListingId, amountPaid: "4.99", platformFee: "1.50",
    creatorEarnings: "3.49", status: "active",
  });
  const [buyerProvider] = await d.insert(schema.llmProviders).values({
    userId: buyer.id, name: `buyer-${buyer.id}`, slug: "openai", baseUrl: APPROVED_URL,
    apiKeyRef: encryptKey("sk-buyer-OWN-KEY-1234567890"), defaultModel: "buyer-model",
  });
  await d.insert(schema.trustedProviderEndpoints).values({
    provider: "openai", baseUrl: APPROVED_URL, adapterKind: "openai_compatible", endpointClass: "first_party",
    loggingDisclosure: "Provider retains request logs.", protectionClass: "standard",
    approvedBy: seller.id, policyVersion: "fbattach-1", enabled: true,
  });
  await setFlag("v2ProtectedExecution", true);
  seen.calls.length = 0;
  const protectedReceipt = await ex.startProtectedRun({
    buyerId: buyer.id, listingId: buyerRunListingId, input: "Translate clause 4 into French.",
    providerId: insertId(buyerProvider),
    dispatch: async (runId, buyerId) => { await sw.executeSwarmRun({ swarmRunId: runId, userId: buyerId }); },
  });
  const [buyerRow] = await d.select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, protectedReceipt.swarmRunId)).limit(1);
  if (buyerRow.status !== "completed") {
    throw new Error(`protected run did not complete: ${buyerRow.status} ${buyerRow.error ?? ""}`);
  }
  buyerRunId = buyerRow.id;
  buyerRunFinalId = Number(buyerRow.finalResponseId);
  expect(seen.calls.map((c) => c.system)).toEqual([SELLER_PROMPT, "FINISH ROMAN: produce the closing note."]);
  const buyerIntermediates = await d.select().from(schema.agentResponses).where(eq(schema.agentResponses.swarmRunId, buyerRunId));
  expect(buyerIntermediates.filter((r) => r.content.includes("SELLER XRAY"))).toHaveLength(1);
  expect(buyerIntermediates.length).toBeGreaterThan(1);
}

// ─────────────────────────────────────────────────────────────────────

describe("D11 consented feedback attachments at the service boundary (isolated localhost MySQL)", () => {
  it("refuses an attachment with no consent and writes neither feedback row nor attachment row", async () => {
    expect(fa.ATTACHMENT_KINDS).toEqual(["pipeline", "run", "benchmark"]);
    const beforeFeedback = await feedbackCount();
    const beforeAttachments = await attachmentCount();

    // `consent: false` — an explicit "no" — is a refusal, and the whole
    // submission goes with it: a half-attached receipt is not a receipt.
    const refused = await refusal(fa.submitFeedbackWithAttachments(owner.id, {
      ...base("please attach nothing"),
      attachments: [{ kind: "run", refId: ownerRunId, consent: false }],
    }));
    expect(refused).toMatch(/^consent_required: nothing can be attached/);
    expect(refused).toContain(`run ${String(ownerRunId)}`);
    expect(await feedbackCount()).toBe(beforeFeedback);
    expect(await attachmentCount()).toBe(beforeAttachments);

    // Consent is per ITEM: two good opt-ins and one missing one refuse all three,
    // and the second item's own text is what the refusal names.
    const mixed = await refusal(fa.submitFeedbackWithAttachments(owner.id, {
      ...base("one unticked item"),
      attachments: [
        { kind: "run", refId: ownerRunId, consent: true },
        { kind: "pipeline", refId: ownerProjectId, consent: false },
        { kind: "benchmark", refId: ownerBenchmarkId, consent: true },
      ],
    }));
    expect(mixed).toMatch(/^consent_required:/);
    expect(await feedbackCount()).toBe(beforeFeedback);
    expect(await attachmentCount()).toBe(beforeAttachments);

    // An ABSENT consent field is not "consent by default": the one input shape
    // shared by the router and the MCP tool has no default for it, so a call
    // that omits it does not even parse. A string or a number is not consent
    // either.
    const input = fa.attachmentInputSchema;
    expect(input.safeParse({ kind: "run", refId: ownerRunId }).success).toBe(false);
    expect(input.safeParse({ kind: "run", refId: ownerRunId, consent: "true" }).success).toBe(false);
    expect(input.safeParse({ kind: "run", refId: ownerRunId, consent: 1 }).success).toBe(false);
    expect(input.safeParse({ kind: "run", refId: ownerRunId, consent: undefined }).success).toBe(false);
    expect(await feedbackCount()).toBe(beforeFeedback);
    expect(await attachmentCount()).toBe(beforeAttachments);
  });

  it("stamps the server's own consent version, which no caller-supplied string can move", async () => {
    const beforeAttachments = await attachmentCount();
    // A caller that invents its own consent field (an older text, a made-up
    // version, a policy string) is stripped by the shared input shape…
    const parsed = fa.attachmentInputSchema.parse({
      kind: "run", refId: ownerRunId, consent: true,
      consentVersion: "consent-v0", policyVersion: "whatever-the-client-claims",
    }) as Record<string, unknown>;
    expect(parsed).toEqual({ kind: "run", refId: ownerRunId, consent: true });
    expect(parsed).not.toHaveProperty("consentVersion");

    // …and even a service call carrying such extra keys cannot choose the stored
    // version, because `attachmentReceiptRows` never reads one.
    const res = await fa.submitFeedbackWithAttachments(owner.id, {
      ...base("consent recorded on my terms"),
      attachments: [{
        kind: "run", refId: ownerRunId, consent: true,
        consentVersion: "consent-v0",
      } as unknown as import("./feedbackAttachments").AttachmentInput],
    });
    expect(res.attachments).toHaveLength(1);
    const rows = await attachmentRows(res.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].consentVersion).toBe(DEFAULT_CONSENT_VERSION);
    expect(rows[0].consentVersion).toBe("consent-v1");
    expect(rows[0].userId).toBe(owner.id);
    expect(rows[0].refId).toBe(ownerRunId);
    expect(rows[0].kind).toBe("run");
    expect(await attachmentCount()).toBe(beforeAttachments + 1);
    // The invented version appears nowhere in what was written.
    expect(rows[0].snapshot).not.toContain("consent-v0");
    expect(rows[0].snapshot).not.toContain("whatever-the-client-claims");
    // The receipt handed back matches the row without a second read.
    expect(res.attachments[0]).toMatchObject({
      id: rows[0].id, kind: "run", refId: ownerRunId, consentVersion: DEFAULT_CONSENT_VERSION,
      visibility: "owner_full",
    });
  });

  it("carries an owned run's and pipeline's real content into the snapshot — the positive control", async () => {
    const res = await fa.submitFeedbackWithAttachments(owner.id, {
      ...base("my own run stops after step 1"),
      projectId: ownerProjectId,
      attachments: [
        { kind: "run", refId: ownerRunId, consent: true },
        { kind: "pipeline", refId: ownerProjectId, consent: true },
      ],
    });
    const rows = await attachmentRows(res.id);
    expect(rows.map((r) => r.kind)).toEqual(["run", "pipeline"]);

    const runRow = rows.find((r) => r.kind === "run")!;
    const runSnap = fa.parseSnapshot(runRow.snapshot) as Record<string, unknown>;
    // The whole point of the rest of this file: an owner's own attachment does
    // hold the prompts, so the redaction assertions below are scoped, not global.
    expect(runRow.snapshot).toContain(MY_PROMPT);
    expect(runRow.snapshot).toContain(MY_CONTEXT);
    expect(runRow.snapshot).toContain(MY_ANSWER);
    expect(runRow.snapshot).toContain(MY_MODEL);
    expect(runSnap).toMatchObject({
      kind: "run", visibility: "owner_full", source: "runAccess.projectRunDetail",
      swarmRunId: ownerRunId, projectName: "Owner pipeline", status: "completed",
      userPrompt: MY_USER_PROMPT, stepCount: 1, responseCount: 1,
    });
    const steps = runSnap.steps as Array<Record<string, unknown>>;
    expect(steps[0]).toMatchObject({ systemPrompt: MY_PROMPT, contextInput: MY_CONTEXT, modelUsed: MY_MODEL });
    const responses = runSnap.responses as Array<Record<string, unknown>>;
    expect(responses[0].content).toBe(MY_ANSWER);
    // The credential on the owner's OWN provider row is still not collected:
    // attachments describe work, they do not gather secrets.
    expect(runRow.snapshot).not.toContain(MY_KEY);

    const pipelineRow = rows.find((r) => r.kind === "pipeline")!;
    const pipeSnap = fa.parseSnapshot(pipelineRow.snapshot) as Record<string, unknown>;
    expect(pipeSnap).toMatchObject({
      kind: "pipeline", visibility: "owner_full", projectId: ownerProjectId,
      projectName: "Owner pipeline", definitionOwnerId: owner.id, accessGrantedToCaller: "owner",
      canModify: true, stepCount: 1,
    });
    expect(pipelineRow.snapshot).toContain(MY_PROMPT);
    expect((pipeSnap.steps as Array<Record<string, unknown>>)[0]).toMatchObject({ name: "Draft", model: MY_MODEL });
    expect(pipeSnap.withheld).toBeNull();
  });

  it("carries NOTHING of the lender's definition into a run_only shared run or the borrowed pipeline", async () => {
    // Non-vacuity: the lender's secret really is stored for that run — in the
    // final answer's sibling intermediate — and the lender's model really is on
    // the shared steps. Only a working projection can keep it out.
    const stored = await db().select().from(schema.agentResponses).where(eq(schema.agentResponses.swarmRunId, sharedRunId));
    expect(stored.some((r) => r.content.includes("LENDER ZULU"))).toBe(true);
    expect(stored.find((r) => r.id === sharedRunFinalId)?.content).toBe(SHARED_FINAL);
    const lenderSteps = await db().select().from(schema.pipelineSteps).where(eq(schema.pipelineSteps.projectId, lenderProjectId));
    expect(lenderSteps.map((s) => s.model)).toEqual([LENDER_MODEL, LENDER_MODEL]);

    const before = await tableCounts();
    const built = await fa.prepareConsentedAttachments(grantee.id, [
      { kind: "run", refId: sharedRunId, consent: true },
      { kind: "pipeline", refId: lenderProjectId, consent: true },
    ]);
    expect(built.map((b) => b.visibility)).toEqual(["redacted_run_only_share", "redacted_run_only_share"]);
    expect(built.map((b) => b.consentVersion)).toEqual([DEFAULT_CONSENT_VERSION, DEFAULT_CONSENT_VERSION]);
    // Preparing writes nothing at all.
    expect(await tableCounts()).toEqual(before);

    for (const item of built) {
      expect(`${item.kind}: ${item.snapshot}`).not.toMatch(LENDER_MARKERS);
      expect(item.snapshot).not.toContain(LENDER_KEY);
      expect(item.snapshot).not.toContain(GRANTEE_KEY);
      expect(item.snapshot).not.toMatch(MY_MARKERS);
    }

    // The RUN attachment is the recipient's own projection, and it is still
    // useful: the answer and the sanitized progress are there, the definition
    // is not, and the withholding is stated rather than silent.
    const runSnap = built[0].detail as Record<string, unknown>;
    expect(runSnap).toMatchObject({
      source: "pipelineSharing.getSharedRunView", mode: "run_only",
      swarmRunId: sharedRunId, projectId: lenderProjectId, projectName: "Lender pipeline",
      status: "completed", finalOutput: SHARED_FINAL,
    });
    expect(runSnap).not.toHaveProperty("userPrompt");
    expect(runSnap).not.toHaveProperty("systemPrompt");
    expect(String(runSnap.visibility)).toBe("redacted_run_only_share");
    // The machine-readable enum is what a later reader keys on, and the human
    // reason rides beside it rather than under the same key: nothing here is
    // silent redaction.
    expect(String(runSnap.recipientVisibilityNote)).toMatch(/run_only/);
    expect(String(runSnap.recipientVisibilityNote)).toContain("never stored");
    const progress = runSnap.progress as Array<Record<string, unknown>>;
    expect(progress).toHaveLength(2);
    expect(JSON.stringify(progress)).not.toContain("modelUsed");
    expect(progress.map((p) => p.name)).toEqual(["Draft", "Polish"]);
    expect((runSnap.totals as Record<string, unknown>).tokensUsed).not.toBeNull();

    // The DEFINITION attachment is step IDENTITY plus a stated reason.
    const pipeSnap = built[1].detail as Record<string, unknown>;
    expect(pipeSnap).toMatchObject({
      kind: "pipeline", visibility: "redacted_run_only_share",
      projectId: lenderProjectId, definitionOwnerId: lender.id,
      accessGrantedToCaller: "run_only", canModify: false, stepCount: 2,
    });
    expect(String(pipeSnap.withheld)).toContain("shared with you to run, not to read");
    const steps = pipeSnap.steps as Array<Record<string, unknown>>;
    expect(steps.map((s) => s.name)).toEqual(["Draft", "Polish"]);
    expect(steps[0]).not.toHaveProperty("systemPrompt");
    expect(steps[0]).not.toHaveProperty("model");
    expect(steps[0]).not.toHaveProperty("providerId");

    // Written through the same submit path, the stored rows are those snapshots
    // byte for byte — the persistence layer redacts nothing further and widens
    // nothing either.
    const res = await fa.submitFeedbackWithAttachments(grantee.id, {
      ...base("the shared pipeline gave a strange answer"),
      attachments: [
        { kind: "run", refId: sharedRunId, consent: true },
        { kind: "pipeline", refId: lenderProjectId, consent: true },
      ],
    });
    const rows = await attachmentRows(res.id);
    expect(rows).toHaveLength(2);
    expect(rows[0].snapshot).toBe(built[0].snapshot);
    expect(rows[1].snapshot).toBe(built[1].snapshot);
    for (const row of rows) {
      expect(row.userId).toBe(grantee.id);
      expect(row.snapshot).not.toMatch(LENDER_MARKERS);
    }
    // The lender's own run of the lender's own project was never involved: the
    // grant row still names the lender, and the recipient got a redacted copy.
    const [project] = await db().select({ userId: schema.projects.userId, originCreatorId: schema.projects.originCreatorId })
      .from(schema.projects).where(eq(schema.projects.id, lenderProjectId)).limit(1);
    expect(project.userId).toBe(lender.id);
  });

  it("carries NOTHING of the seller's definition into a marketplace buyer run", async () => {
    const stored = await db().select().from(schema.agentResponses).where(eq(schema.agentResponses.swarmRunId, buyerRunId));
    expect(stored.some((r) => r.content.includes("SELLER XRAY"))).toBe(true);
    expect(stored.find((r) => r.id === buyerRunFinalId)?.content).toBe(BUYER_FINAL);

    const built = await fa.prepareConsentedAttachments(buyer.id, [
      { kind: "run", refId: buyerRunId, consent: true },
    ]);
    expect(built[0].visibility).toBe("redacted_protected_marketplace_run");
    expect(built[0].title).toContain(`protected marketplace run ${buyerRunId}`);
    expect(built[0].title).toContain(`listing ${buyerRunListingId}`);
    const snap = built[0].detail as Record<string, unknown>;
    expect(snap).toMatchObject({
      source: "marketplaceExecutionService.getProtectedRunView",
      swarmRunId: buyerRunId, listingId: buyerRunListingId, status: "completed",
      finalOutput: BUYER_FINAL,
    });
    expect(built[0].snapshot).not.toMatch(SELLER_MARKERS);
    expect(built[0].snapshot).not.toContain(SELLER_KEY);
    expect(built[0].snapshot).not.toMatch(MY_MARKERS);
    expect(built[0].snapshot).not.toMatch(/LENDER ZULU/);
    // Structurally, as well as by marker: the buyer's projection does not SELECT
    // the prompt-bearing or model-bearing columns, so there is no key here for a
    // later edit to forget to strip.
    for (const column of ["systemPrompt", "userPrompt", "contextInput", "modelUsed", "providerUsed"]) {
      expect(built[0].snapshot).not.toContain(`"${column}"`);
    }
    expect((snap.progress as Array<Record<string, unknown>>).map((p) => p.name)).toEqual(["Draft", "Finalize"]);
    expect(String(snap.error ?? "")).toBe("");

    // And the buyer's own protected context is not spread into the receipt
    // either: the seller's id, the seller's endpoint and the seller's model are
    // not what the buyer consented to send, and the buyer's projection never
    // named them.
    expect(built[0].snapshot).not.toContain("protectedRun");
    for (const key of ["sellerId", "endpoint", "workflowVersionId", "purchaseId", "grantId", "providerId"]) {
      expect(snap).not.toHaveProperty(key);
    }

    // The reason IS stated, on the surface that renders it for the author: the
    // workbench tool that wraps this same service says plainly that the object
    // belongs to another account and was redacted, rather than returning a
    // silently short snapshot.
    const { TOOLS } = await import("../mcp/tools/index");
    const tool = TOOLS.find((t) => t.name === "send_feedback");
    if (!tool) throw new Error("send_feedback is not registered");
    const narrated = await tool.handler({
      ...base("why is my purchase empty?"),
      attachments: [{ kind: "run", refId: buyerRunId, consent: true }],
    }, {
      userId: buyer.id, scopes: new Set(["mcp:read", "mcp:write"]), clientId: "fbattach-svc",
      requestId: "fbattach-svc", locale: "en" as const,
    }) as { attachmentsWithMeaning: Array<{ redacted: boolean; note: string }> };
    expect(narrated.attachmentsWithMeaning[0].redacted).toBe(true);
    expect(narrated.attachmentsWithMeaning[0].note).toMatch(/another account/);
    expect(narrated.attachmentsWithMeaning[0].note).toMatch(/not to read|redacted/i);

    const res = await fa.submitFeedbackWithAttachments(buyer.id, {
      ...base("the listing I bought misread the clause"),
      attachments: [{ kind: "run", refId: buyerRunId, consent: true }],
    });
    const rows = await attachmentRows(res.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].snapshot).not.toMatch(SELLER_MARKERS);
    expect(rows[0].snapshot).toContain(BUYER_FINAL);
    expect(JSON.parse(rows[0].snapshot).visibility).toBe("redacted_protected_marketplace_run");
  });

  it("refuses another account's objects and a non-existent id with the identical answer, for all three kinds", async () => {
    const beforeFeedback = await feedbackCount();
    const beforeAttachments = await attachmentCount();
    const GHOST = { pipeline: 987_654_321, run: 987_654_322, benchmark: 987_654_323 };
    const REAL = { pipeline: ownerProjectId, run: ownerRunId, benchmark: ownerBenchmarkId } as const;

    for (const kind of fa.ATTACHMENT_KINDS) {
      const mine = await refusal(fa.prepareConsentedAttachments(outsider.id, [{ kind, refId: REAL[kind], consent: true }]));
      const ghost = await refusal(fa.prepareConsentedAttachments(outsider.id, [{ kind, refId: GHOST[kind], consent: true }]));
      // Byte-identical: guessing an id teaches an attacker nothing, and the
      // refusal is the codebase-wide shape rather than a new one invented here.
      expect(`${kind}: ${mine}`).toBe(`${kind}: ${ghost}`);
      expect(mine).toMatch(/^not_found_or_not_authorized: /);
      // Nothing of the object's content leaks into the refusal text itself.
      expect(mine).not.toMatch(MY_MARKERS);
      expect(mine).not.toMatch(LENDER_MARKERS);
    }

    // A grant names its recipient: the lender's pipeline is not the outsider's,
    // and even the grantee cannot attach the LENDER's own run of it.
    expect(await refusal(fa.prepareConsentedAttachments(outsider.id, [
      { kind: "pipeline", refId: lenderProjectId, consent: true },
    ]))).toMatch(/^not_found_or_not_authorized:/);
    const lenderRun = await db().select({ id: schema.swarmRuns.id }).from(schema.swarmRuns)
      .where(eq(schema.swarmRuns.userId, lender.id)).limit(1);
    expect(lenderRun).toHaveLength(0); // the lender never ran it; the recipient did
    expect(await refusal(fa.prepareConsentedAttachments(grantee.id, [
      { kind: "run", refId: capRunIds[0], consent: true },
    ]))).toMatch(/^not_found_or_not_authorized: run/);
    // A benchmark is owner-only: the buyer cannot attach the owner's.
    expect(await refusal(fa.prepareConsentedAttachments(buyer.id, [
      { kind: "benchmark", refId: ownerBenchmarkId, consent: true },
    ]))).toMatch(/^not_found_or_not_authorized: benchmark/);

    // Through the submit path the same refusals write nothing.
    for (const kind of fa.ATTACHMENT_KINDS) {
      expect(await refusal(fa.submitFeedbackWithAttachments(outsider.id, {
        ...base(`I would like to attach someone else's ${kind}`),
        attachments: [{ kind, refId: REAL[kind], consent: true }],
      }))).toMatch(/^not_found_or_not_authorized:/);
    }
    expect(await feedbackCount()).toBe(beforeFeedback);
    expect(await attachmentCount()).toBe(beforeAttachments);
  });

  it("gates the support read, keeps the payload out of the summaries, and writes nothing while reading", async () => {
    const submitted = await fa.submitFeedbackWithAttachments(owner.id, {
      ...base("read back what I consented to"),
      attachments: [{ kind: "run", refId: ownerRunId, consent: true }],
    });
    const [row] = await attachmentRows(submitted.id);

    const before = await tableCounts();
    const auditBefore = await db().select().from(schema.adminAuditLog)
      .where(eq(schema.adminAuditLog.action, "feedback.read_attachment"));

    // Summaries: what was attached, under which consent, redacted or not — and
    // NOT the payload, so a list screen cannot pull every attached prompt by
    // accident.
    const summaries = await fa.summarizeAttachments([submitted.id]);
    const list = summaries.get(submitted.id) ?? [];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: row.id, feedbackId: submitted.id, kind: "run", refId: ownerRunId,
      consentVersion: DEFAULT_CONSENT_VERSION, visibility: "owner_full",
    });
    expect(list[0]).not.toHaveProperty("snapshot");
    expect(JSON.stringify(list)).not.toMatch(MY_MARKERS);

    // The author reads their own consented copy; nobody else learns it exists.
    const own = await fa.listOwnAttachments(owner.id, submitted.id);
    expect(own.attachments).toHaveLength(1);
    expect(JSON.stringify(own.attachments[0].snapshot)).toContain(MY_PROMPT);
    expect(await refusal(fa.listOwnAttachments(outsider.id, submitted.id)))
      .toMatch(/^not_found_or_not_authorized: feedback/);

    // The payload read is admin-gated at the only surface that exposes it.
    const support = asAdmin(supportAdmin);
    const detail = await support.feedbackAttachmentDetail({ attachmentId: row.id });
    expect(detail).toMatchObject({ id: row.id, kind: "run", refId: ownerRunId, visibility: "owner_full" });
    // …and it returns the stored bytes exactly: support is not shown more than
    // the consenting author could already read, nor less.
    expect(detail.snapshot).toEqual(fa.parseSnapshot(row.snapshot));
    expect(JSON.stringify(detail.snapshot)).toContain(MY_PROMPT);
    await expect(asAdmin(outsider).feedbackAttachmentDetail({ attachmentId: row.id }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(asAdmin(outsider).listAllFeedback({ page: 1, pageSize: 10 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });

    // Reading changed no content row, and the refused calls changed none either.
    expect(await tableCounts()).toEqual(before);
    const auditAfter = await db().select().from(schema.adminAuditLog)
      .where(eq(schema.adminAuditLog.action, "feedback.read_attachment"));
    // Exactly the ONE audited admin read is new, and the audit names ids and
    // shape — never the prompt it just disclosed.
    expect(auditAfter.length).toBe(auditBefore.length + 1);
    const added = auditAfter[auditAfter.length - 1];
    expect(added).toMatchObject({
      adminUserId: supportAdmin.id, action: "feedback.read_attachment",
      targetType: "feedback_attachment", targetId: String(row.id),
    });
    expect(JSON.stringify(added)).not.toMatch(MY_MARKERS);

    // An attachment id that does not exist is the same not-found shape.
    expect(await refusal(fa.readAttachmentForSupport(987_654_324)))
      .toMatch(/^not_found_or_not_authorized: attachment/);
  });

  it("refuses more than the documented number of opt-ins without writing a partial set", async () => {
    const beforeFeedback = await feedbackCount();
    const beforeAttachments = await attachmentCount();
    expect(fa.MAX_ATTACHMENTS_PER_FEEDBACK).toBe(5);
    // Six DISTINCT, genuinely attachable objects of the caller's own — so the cap
    // is proved against real work, not against a padded duplicate list that the
    // duplicate check would catch first.
    const six = capRunIds.map((id) => ({ kind: "run" as const, refId: id, consent: true as const }));
    expect(six).toHaveLength(fa.MAX_ATTACHMENTS_PER_FEEDBACK + 1);

    expect(await refusal(fa.prepareConsentedAttachments(owner.id, six))).toMatch(/^too_many_attachments:/);
    expect(await refusal(fa.submitFeedbackWithAttachments(owner.id, {
      ...base("too many attachments"), attachments: six,
    }))).toMatch(/^too_many_attachments:/);
    expect(await feedbackCount()).toBe(beforeFeedback);
    expect(await attachmentCount()).toBe(beforeAttachments);
    // The shared input shape refuses it at the boundary too, so no surface has
    // to remember the number.
    expect(fa.feedbackSubmitInputSchema.safeParse({ ...base("x"), attachments: six }).success).toBe(false);
    expect(fa.feedbackSubmitInputSchema.safeParse({ ...base("x"), attachments: six.slice(0, 5) }).success).toBe(true);

    // The boundary itself is allowed, and all five rows land.
    const five = await fa.submitFeedbackWithAttachments(owner.id, {
      ...base("exactly at the cap"), attachments: six.slice(0, 5),
    });
    expect(five.attachments).toHaveLength(5);
    expect(await attachmentCount()).toBe(beforeAttachments + 5);
    const feedbackAfterCapOk = await feedbackCount();
    expect((await attachmentRows(five.id)).map((r) => r.refId)).toEqual(six.slice(0, 5).map((s) => s.refId));

    // One object ticked twice is its own refusal — "tick it once" — and again
    // writes nothing.
    expect(await refusal(fa.prepareConsentedAttachments(owner.id, [
      { kind: "run", refId: ownerRunId, consent: true },
      { kind: "run", refId: ownerRunId, consent: true },
    ]))).toMatch(/^duplicate_attachment:/);
    expect(await refusal(fa.submitFeedbackWithAttachments(owner.id, {
      ...base("ticked twice"),
      attachments: [
        { kind: "run", refId: ownerRunId, consent: true },
        { kind: "run", refId: ownerRunId, consent: true },
      ],
    }))).toMatch(/^duplicate_attachment:/);
    expect(await feedbackCount()).toBe(feedbackAfterCapOk);
    expect(await attachmentCount()).toBe(beforeAttachments + 5);

    // The picker states the same two numbers, so no surface invents its own.
    const picker = await fa.attachableObjectsFor(owner.id);
    expect(picker.maxPerFeedback).toBe(fa.MAX_ATTACHMENTS_PER_FEEDBACK);
    expect(picker.consentVersion).toBe(DEFAULT_CONSENT_VERSION);
  });

  it("attaches a benchmark as the owner's STATUS shape, not the frozen plan's case texts", async () => {
    const [built] = await fa.prepareConsentedAttachments(owner.id, [
      { kind: "benchmark", refId: ownerBenchmarkId, consent: true },
    ]);
    expect(built.visibility).toBe("owner_full");
    expect(built.title).toContain("grade_only");
    const snap = built.detail as Record<string, unknown>;
    expect(snap).toMatchObject({
      source: "benchmarkService.getBenchmarkProgress", id: ownerBenchmarkId,
      state: "completed", executionMode: "grade_only", planHash: "e".repeat(64),
    });
    expect(snap.summary).toEqual({ cases: 1, meanScore: 0.8, BENCHSUMMARY: "GOLF 1c77" });
    // The SHAPE of the plan, so support can see what was measured…
    expect(snap.planRef).toMatchObject({
      executionMode: "grade_only", judgmentKind: "rubric", cases: 1, candidates: 1,
      generationRepeats: 1, plannedCalls: { generation: 1, judging: 1 }, rubric: "rubric-fixture-1",
    });
    // …and not the plan's own texts, which are the user's private inputs.
    expect(built.snapshot).not.toContain(BENCH_CASE);
    expect(snap).not.toHaveProperty("plan");
    expect(built.snapshot).not.toMatch(MY_MARKERS);
    expect(built.snapshot).not.toMatch(LENDER_MARKERS);
  });

  it("offers only labels in the picker and reports an unparsable snapshot instead of bytes", async () => {
    const picker = await fa.attachableObjectsFor(owner.id, ownerProjectId);
    expect(picker.pipelines.map((p) => p.refId)).toContain(ownerProjectId);
    expect(picker.runs.map((r) => r.refId)).toContain(ownerRunId);
    expect(picker.benchmarks.map((b) => b.refId)).toContain(ownerBenchmarkId);
    // Labels, not content: the picker cannot become a side door around the
    // projection functions that build every snapshot. The only user text it
    // carries is the first line of the caller's OWN brief, as a label.
    const pickerJson = JSON.stringify(picker);
    expect(pickerJson).not.toMatch(MY_MARKERS);
    expect(pickerJson).not.toContain("systemPrompt");
    expect(pickerJson).not.toContain("contextInput");
    expect(pickerJson).not.toContain(MY_ANSWER);

    const granteePicker = await fa.attachableObjectsFor(grantee.id);
    const sharedEntry = granteePicker.pipelines.find((p) => p.refId === lenderProjectId);
    expect(sharedEntry).toMatchObject({ kind: "pipeline", owned: false });
    expect(granteePicker.runs.map((r) => r.refId)).toContain(sharedRunId);
    // The outsider is offered nothing of either account's.
    const outsiderPicker = await fa.attachableObjectsFor(outsider.id);
    expect(outsiderPicker.pipelines.map((p) => p.refId)).not.toContain(ownerProjectId);
    expect(outsiderPicker.runs.map((r) => r.refId)).not.toContain(sharedRunId);
    expect(outsiderPicker.benchmarks.map((b) => b.refId)).not.toContain(ownerBenchmarkId);

    // A snapshot that no longer parses is reported, not rendered as "no
    // attachments" and not handed over as raw bytes.
    expect(fa.parseSnapshot("{ not json")).toEqual({ unparsable: true });
    expect(fa.parseSnapshot("null")).toEqual({});
    expect(fa.parseSnapshot('{"visibility":"owner_full"}')).toEqual({ visibility: "owner_full" });
  });

  it("refuses to file a credential that rode along in the text, naming the category only", async () => {
    const before = await attachmentCount();
    const message = await refusal(fa.prepareConsentedAttachments(owner.id, [
      { kind: "pipeline", refId: leakyProjectId, consent: true },
    ]));
    expect(message).toMatch(/^attachment_credential_refused: the snapshot of this pipeline/);
    expect(message).toContain("api-key-shaped token");
    // Named by category, never echoed back into a log line or a UI.
    expect(message).not.toContain(LEAKABLE_KEY);
    expect(await attachmentCount()).toBe(before);
    // A refusal on the ONE item that carried it refuses the whole batch, so a
    // later reader never finds a receipt with the object missing.
    expect(await refusal(fa.submitFeedbackWithAttachments(owner.id, {
      ...base("one leaky item in a good batch"),
      attachments: [
        { kind: "run", refId: ownerRunId, consent: true },
        { kind: "pipeline", refId: leakyProjectId, consent: true },
      ],
    }))).toMatch(/^attachment_credential_refused:/);
    expect(await attachmentCount()).toBe(before);
  });

  it("caps long strings without ever adding content, and keeps the receipt's own fields intact", async () => {
    const long = "LONGFIELD DELTA ".repeat(2_000); // ~30 kB, well past the 6 kB cap
    const [project] = await db().insert(schema.projects).values({ userId: owner.id, name: "Long prompt pipeline" });
    const projectId = insertId(project);
    await db().insert(schema.pipelineSteps).values({
      projectId, stepOrder: 1, stepType: "agent", name: "Draft", role: "builder",
      systemPrompt: long, isEnabled: true,
    });
    const before = await attachmentCount();
    const [built] = await fa.prepareConsentedAttachments(owner.id, [
      { kind: "pipeline", refId: projectId, consent: true },
    ]);
    const steps = built.detail.steps as Array<Record<string, unknown>>;
    const stored = String(steps[0].systemPrompt);
    // Truncation only ever makes text SHORTER, and says so in place.
    expect(stored.length).toBeLessThan(long.length);
    expect(stored).toContain("…[truncated in the feedback snapshot]");
    expect(stored.startsWith("LONGFIELD DELTA")).toBe(true);
    expect(built.snapshot.length).toBeLessThan(long.length);
    // The cap did not touch what the receipt is for: kind, id and version are
    // the caller's own values, and consent is still recorded server-side.
    expect(built).toMatchObject({
      kind: "pipeline", refId: projectId, consentVersion: DEFAULT_CONSENT_VERSION,
      visibility: "owner_full",
    });
    const res = await fa.submitFeedbackWithAttachments(owner.id, {
      ...base("the long one"), attachments: [{ kind: "pipeline", refId: projectId, consent: true }],
    });
    const [row] = await attachmentRows(res.id);
    expect(row.kind).toBe("pipeline");
    expect(row.refId).toBe(projectId);
    expect(row.consentVersion).toBe(DEFAULT_CONSENT_VERSION);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(await attachmentCount()).toBe(before + 1);
    // Deleting the object the receipt describes keeps the receipt: that is why
    // `ref_id` is not a foreign key (see migration 033).
    await db().delete(schema.pipelineSteps).where(eq(schema.pipelineSteps.projectId, projectId));
    await db().delete(schema.projects).where(eq(schema.projects.id, projectId));
    expect(await attachmentRows(res.id)).toHaveLength(1);
  });

  // ─── timestamps survive the size cap ───────────────────────────────
  // This case was written as "CHARACTERISATION, NOT AN APPROVAL" for a real
  // defect: `capStrings` walked plain objects and arrays, and a `Date` is an
  // object with no own enumerable properties, so `Object.entries(new Date())` is
  // `[]` and EVERY timestamp in a stored snapshot collapsed to `{}` — support
  // could not see when the run happened, though the author had consented to
  // sending exactly that. The walker now passes a Date through untouched and
  // this asserts the value, per that comment's own instruction to invert it
  // rather than delete it.
  it("keeps every timestamp of the run the user consented to send", async () => {
    const [run] = await db().select().from(schema.swarmRuns)
      .where(eq(schema.swarmRuns.id, ownerRunId)).limit(1);
    expect(run.startedAt).toBeInstanceOf(Date);
    expect(run.completedAt).toBeInstanceOf(Date);

    const [built] = await fa.prepareConsentedAttachments(owner.id, [
      { kind: "run", refId: ownerRunId, consent: true },
    ]);
    const snap = built.detail as Record<string, unknown>;
    const stored = JSON.parse(built.snapshot) as Record<string, unknown>;

    expect(snap.startedAt).toBeInstanceOf(Date);
    expect(snap.completedAt).toBeInstanceOf(Date);
    // In the JSON that is actually written to the column, a date is its ISO
    // string — never an empty object, which is what used to be stored.
    expect(stored.startedAt).toBe((run.startedAt as Date).toISOString());
    expect(stored.completedAt).toBe((run.completedAt as Date).toISOString());
    const firstResponse = (stored.responses as Array<Record<string, unknown>>)[0];
    expect(firstResponse.createdAt).toBeTruthy();
    expect(firstResponse.createdAt).not.toEqual({});
    // And the fields around them are still intact, so this is preservation
    // rather than a different kind of loss.
    expect(stored.status).toBe("completed");
    expect(stored.stepCount).toBe(1);
  });
});
