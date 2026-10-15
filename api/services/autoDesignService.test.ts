import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, getTableColumns, type SQL } from "drizzle-orm";
import { QueryBuilder, type MySqlTable } from "drizzle-orm/mysql-core";
import { llmProviders, pipelineSteps, projects } from "@db/schema";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(), decryptApiKey: vi.fn(), createProviderAdapter: vi.fn(),
  callWithRetry: vi.fn(), chat: vi.fn(), persist: vi.fn(), fetch: vi.fn(),
}));
// Keep connection/env, credential handling and provider code out of this suite.
vi.mock("../queries/connection", () => ({ getDb: mocks.getDb }));
vi.mock("./swarmService", () => ({
  decryptApiKey: mocks.decryptApiKey, callWithRetry: mocks.callWithRetry,
}));
vi.mock("../lib/providers", () => ({ createProviderAdapter: mocks.createProviderAdapter }));
vi.mock("../lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
vi.mock("./designJobService", async () => ({
  ...await import("./designJobMeta"),
  validateDesignGraph: vi.fn(() => []),
  persistDesignToProject: mocks.persist,
}));

import { runAutoDesign } from "./autoDesignService";

const USER_ID = 1;
const PROJECT_ID = 100;
const TASK = "Draft a short summary";
const design = {
  agents: [{ name: "Draft", role: "builder", systemPrompt: "Write a summary" }],
  pipeline: [{ name: "Draft", role: "builder", type: "agent" }],
  explanation: "One drafting step",
};
const response = { content: JSON.stringify(design) };
type Row = Record<string, unknown>;
let project: Row;
let providers: Row[];
let queries: Array<{ table: MySqlTable; sql: string; params: unknown[] }>;

// The existing DB harness provisions MySQL schemas and modifies process env.
// Instead, evaluate the service's actual Drizzle SELECT predicates via toSQL(),
// against adversarial rows. This double supports only equality joined by AND;
// it fails loudly on other expressions rather than silently ignoring them.
function selectRows(table: MySqlTable, condition: SQL) {
  const query = new QueryBuilder().select().from(table).where(condition).toSQL();
  queries.push({ table, ...query });
  const where = query.sql.split(" where ")[1];
  expect(where).toBeDefined();
  const comparisons = [...where.matchAll(/`[^`]+`\.`([^`]+)` = \?/g)];
  expect(comparisons.length).toBeGreaterThan(0);
  expect(comparisons).toHaveLength(query.params.length);
  expect(where.replace(/`[^`]+`\.`[^`]+` = \?/g, "").replace(/\band\b|[()\s]/g, "")).toBe("");
  const columns = getTableColumns(table);
  const rows = table === projects ? [project] : table === llmProviders ? providers : [{
    projectId: PROJECT_ID, stepOrder: 1, name: "Draft", role: "builder", stepType: "agent",
  }];
  expect([projects, llmProviders, pipelineSteps]).toContain(table);
  return rows.filter((row) => comparisons.every((match, index) => {
    const property = Object.keys(columns).find((key) => columns[key].name === match[1]);
    expect(property).toBeDefined();
    return row[property!] === query.params[index];
  }));
}

const db = {
  select: () => ({
    from: (table: MySqlTable) => ({
      where: (condition: SQL) => {
        const rows = selectRows(table, condition);
        return Object.assign(Promise.resolve(rows), {
          limit: (count: number) => Promise.resolve(rows.slice(0, count)),
          orderBy: () => Promise.resolve(rows),
        });
      },
    }),
  }),
  transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
};

beforeEach(() => {
  vi.clearAllMocks();
  project = { id: PROJECT_ID, userId: USER_ID, defaultProviderId: null };
  // Put ineligible rows first so an under-scoped fallback cannot pass by luck.
  providers = [
    { id: 20, userId: 2, isEnabled: true, apiKeyRef: "foreign-ciphertext" },
    { id: 12, userId: USER_ID, isEnabled: false, apiKeyRef: "disabled-ciphertext" },
    { id: 13, userId: USER_ID, isEnabled: null, apiKeyRef: "unknown-state-ciphertext" },
    {
      id: 10, userId: USER_ID, isEnabled: true, apiKeyRef: "owned-ciphertext",
      slug: "fake", baseUrl: "https://provider.invalid", defaultModel: "fake-model",
    },
  ];
  queries = [];
  mocks.getDb.mockReturnValue(db);
  mocks.decryptApiKey.mockReturnValue("fake-decrypted-key");
  mocks.createProviderAdapter.mockReturnValue({ chat: mocks.chat });
  mocks.callWithRetry.mockImplementation((call: () => Promise<unknown>) => call());
  mocks.chat.mockResolvedValue(response);
  mocks.persist.mockResolvedValue({ agentsCreated: 1 });
  mocks.fetch.mockImplementation(() => { throw new Error("Network forbidden in auto-design tests"); });
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  expect(mocks.fetch).not.toHaveBeenCalled();
});

function expectNoProviderUse() {
  expect(mocks.decryptApiKey).not.toHaveBeenCalled();
  expect(mocks.createProviderAdapter).not.toHaveBeenCalled();
  expect(mocks.callWithRetry).not.toHaveBeenCalled();
  expect(mocks.chat).not.toHaveBeenCalled();
}

function expectRefusedBeforeSideEffects() {
  expectNoProviderUse();
  expect(db.transaction).not.toHaveBeenCalled();
  expect(mocks.persist).not.toHaveBeenCalled();
}

function expectScopedLookup(providerId: number) {
  const lookup = queries.filter((query) => query.table === llmProviders).at(-1)!;
  expect(lookup.sql).toContain("where (`llm_providers`.`id` = ? and `llm_providers`.`user_id` = ? and `llm_providers`.`is_enabled` = ?)");
  expect(lookup.params).toEqual([providerId, USER_ID, true]);
}

function expectOwnedProviderUsed() {
  expect(mocks.decryptApiKey).toHaveBeenCalledExactlyOnceWith("owned-ciphertext");
  expect(mocks.createProviderAdapter).toHaveBeenCalledExactlyOnceWith(
    "fake", "fake-decrypted-key", "https://provider.invalid", "fake-model",
  );
  expect(mocks.chat).toHaveBeenCalledExactlyOnceWith(
    expect.any(Array), { temperature: 0.3, maxTokens: 4096 },
  );
  expect(mocks.persist).toHaveBeenCalledExactlyOnceWith(
    db, USER_ID, PROJECT_ID, expect.objectContaining({ explanation: design.explanation }), TASK, 10,
  );
  expectScopedLookup(10);
}

describe("runAutoDesign provider authorization", () => {
  it.each([
    ["foreign", 20], ["disabled", 12], ["unknown enabled state", 13], ["missing", 999],
  ])("refuses an explicit %s provider before decryption, adapter creation or calls", async (_, providerId) => {
    await expect(runAutoDesign(USER_ID, PROJECT_ID, TASK, providerId as number)).rejects.toThrow("Provider not found");
    expectScopedLookup(providerId as number);
    expectRefusedBeforeSideEffects();
  });

  it.each([20, 12])("also refuses an ineligible project-default provider (%s)", async (providerId) => {
    project.defaultProviderId = providerId;
    await expect(runAutoDesign(USER_ID, PROJECT_ID, TASK)).rejects.toThrow("Provider not found");
    expectScopedLookup(providerId);
    expectRefusedBeforeSideEffects();
  });

  it.each(["explicit", "project-default"])("accepts an owned enabled %s provider", async (source) => {
    project.defaultProviderId = source === "explicit" ? 20 : 10;
    const result = await runAutoDesign(USER_ID, PROJECT_ID, TASK, source === "explicit" ? 10 : undefined);
    expect(result).toEqual({
      agentsCreated: 1, stepsCreated: 1, explanation: design.explanation,
      pipeline: [{ name: "Draft", role: "builder", stepType: "agent" }], designedBy: "provider",
    });
    expectOwnedProviderUsed();
  });

  it("falls back only to an owned enabled provider", async () => {
    await expect(runAutoDesign(USER_ID, PROJECT_ID, TASK)).resolves.toMatchObject({ designedBy: "provider" });
    const fallback = queries.find((query) => query.table === llmProviders)!;
    expect(fallback.sql).toContain("where (`llm_providers`.`user_id` = ? and `llm_providers`.`is_enabled` = ?)");
    expect(fallback.params).toEqual([USER_ID, true]);
    expectOwnedProviderUsed();
  });

  it("refuses fallback when only foreign or non-enabled providers exist", async () => {
    providers = providers.filter((provider) => provider.id !== 10);
    await expect(runAutoDesign(USER_ID, PROJECT_ID, TASK)).rejects.toThrow("No LLM provider configured");
    expectRefusedBeforeSideEffects();
  });
});

describe("runAutoDesign desktop sampling", () => {
  it.each(["none", "ineligible", "mixed"])("works with %s providers without touching credentials", async (fixture) => {
    if (fixture === "none") providers = [];
    if (fixture === "ineligible") providers = providers.filter((provider) => provider.id !== 10);
    const chatFn = vi.fn().mockResolvedValue(response);
    await expect(runAutoDesign(USER_ID, PROJECT_ID, TASK, undefined, { chatFn })).resolves.toMatchObject({
      designedBy: "desktop-llm", agentsCreated: 1, stepsCreated: 1,
    });
    expect(chatFn).toHaveBeenCalledExactlyOnceWith(expect.any(Array));
    expect(mocks.persist).toHaveBeenCalledExactlyOnceWith(
      db, USER_ID, PROJECT_ID, expect.any(Object), TASK, fixture === "mixed" ? 10 : null,
    );
    expectNoProviderUse();
  });

  it("keeps JSON-repair retries on chatFn, not a configured provider", async () => {
    const chatFn = vi.fn().mockResolvedValueOnce({ content: "not JSON" }).mockResolvedValueOnce(response);
    await expect(runAutoDesign(USER_ID, PROJECT_ID, TASK, 10, { chatFn })).resolves.toMatchObject({
      designedBy: "desktop-llm", stepsCreated: 1,
    });
    expect(chatFn).toHaveBeenCalledTimes(2);
    expect(chatFn.mock.calls[1][0]).toEqual(expect.arrayContaining([
      { role: "assistant", content: "not JSON" },
      { role: "user", content: expect.stringContaining("That was not valid JSON") },
    ]));
    expectNoProviderUse();
  });
});

describe("SQL fixture negative controls", () => {
  it.each([
    { name: "old ID-only lookup", condition: eq(llmProviders.id, 20), exposedId: 20 },
    { name: "missing ownership", condition: and(eq(llmProviders.id, 20), eq(llmProviders.isEnabled, true))!, exposedId: 20 },
    { name: "missing enabled predicate", condition: and(eq(llmProviders.id, 12), eq(llmProviders.userId, USER_ID))!, exposedId: 12 },
    { name: "old owner-only fallback", condition: eq(llmProviders.userId, USER_ID), exposedId: 12 },
  ])("exposes an ineligible row with $name", async ({ condition, exposedId }) => {
    // Proves the fixture does not enforce access independently of the query:
    // restoring the old service predicates would reach decryption and fail above.
    const [row] = await db.select().from(llmProviders).where(condition).limit(1);
    expect(row.id).toBe(exposedId);
  });
});
