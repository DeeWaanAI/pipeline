import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTableColumns, type Column, type SQL, type Table } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { users } from "@db/schema";
import type { McpAuthContext } from "../types";

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), resolveCapabilities: vi.fn() }));
// Never import the real connection/environment or entitlement dependencies.
vi.mock("../../queries/connection", () => ({ getDb: mocks.getDb }));
vi.mock("../../services/entitlements", () => ({ resolveCapabilities: mocks.resolveCapabilities }));

import { getSettings, setDefaultModel } from "./settings";

type Row = Record<string, unknown>;
const dialect = new MySqlDialect();
let accounts: Row[];
let providers: Row[];
let updates: Array<{ table: Table; values: Row; sql: string; params: unknown[] }>;
let fetchSpy: ReturnType<typeof vi.fn>;
const sample = vi.fn();
const ctx: McpAuthContext = {
  userId: 1, scopes: new Set(["mcp:read", "mcp:write"]),
  clientId: "settings-test", requestId: "settings-test", locale: "en",
  runtime: { sample, samplingSupported: () => true },
};

// An in-memory query double that evaluates the real Drizzle ownership predicates,
// not queued canned responses: dropping a tenant filter makes isolation tests fail.
function matchingRows(table: Table, condition: SQL) {
  const query = dialect.sqlToQuery(condition);
  const comparisons = [...query.sql.matchAll(/`[^`]+`\.`([^`]+)` = \?/g)];
  expect(comparisons.length).toBe(query.params.length);
  expect(comparisons.length).toBeGreaterThan(0);
  const columns = getTableColumns(table);
  return (table === users ? accounts : providers).filter((row) =>
    comparisons.every((match, index) => {
      const property = Object.keys(columns).find((key) => columns[key].name === match[1]);
      const value = row[property!];
      const param = query.params[index];
      return (typeof value === "boolean" ? Number(value) : value)
        === (typeof param === "boolean" ? Number(param) : param);
    }),
  );
}

const queryDb = {
  select: (fields: Record<string, Column>) => ({
    from: (table: Table) => ({
      where: (condition: SQL) => {
        const rows = matchingRows(table, condition).map((row) => Object.fromEntries(
          Object.entries(fields).map(([key, column]) => {
            const property = Object.keys(getTableColumns(table))
              .find((name) => getTableColumns(table)[name].name === column.name);
            return [key, row[property!]];
          }),
        ));
        return Object.assign(Promise.resolve(rows), {
          limit: (count: number) => Object.assign(Promise.resolve(rows.slice(0, count)), {
            for: () => Promise.resolve(rows.slice(0, count)),
          }),
        });
      },
    }),
  }),
  update: (table: Table) => ({
    set: (values: Row) => ({
      where: async (condition: SQL) => {
        const query = dialect.sqlToQuery(condition);
        updates.push({ table, values, sql: query.sql, params: query.params });
        for (const row of matchingRows(table, condition)) Object.assign(row, values);
      },
    }),
  }),
};
const db = {
  ...queryDb,
  transaction: vi.fn(async (callback: (tx: typeof queryDb) => Promise<void>) => {
    const previousAccounts = structuredClone(accounts);
    const previousProviders = structuredClone(providers);
    try {
      await callback(queryDb);
    } catch (error) {
      accounts = previousAccounts;
      providers = previousProviders;
      throw error;
    }
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
  accounts = [
    { id: 1, defaultModel: "account-model", defaultProviderId: 10 },
    { id: 2, defaultModel: "private-account-model", defaultProviderId: 20 },
  ];
  providers = [
    { id: 10, userId: 1, name: "Chosen", slug: "compatible", defaultModel: "provider-model", models: ["catalog-model"], isEnabled: true },
    { id: 11, userId: 1, name: "Other", slug: "compatible", defaultModel: "other-model", isEnabled: true },
    { id: 12, userId: 1, name: "Disabled", slug: "compatible", defaultModel: "disabled-model", isEnabled: false },
    { id: 20, userId: 2, name: "Private provider", slug: "compatible", defaultModel: "private-provider-model", isEnabled: true, apiKeyRef: "synthetic-secret" },
  ];
  updates = [];
  mocks.getDb.mockReturnValue(db);
  mocks.resolveCapabilities.mockResolvedValue({ tier: "standard", capabilities: {} });
  fetchSpy = vi.fn(() => { throw new Error("Network calls forbidden in settings tests"); });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(sample).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

const save = (args: unknown) => setDefaultModel.handler(args, ctx);
const snapshot = () => getSettings.handler({}, ctx);

describe("set_default_model route validation", () => {
  it.each([
    [20, /not one of your configured providers/],
    [999, /not one of your configured providers/],
    [12, /disabled/],
  ])("rejects supplied foreign, absent or disabled provider %s", async (providerId, error) => {
    await expect(save({ model: "exact-model", providerId, setProviderDefault: true })).rejects.toThrow(error);
    expect(updates).toEqual([]);
  });

  it.each([null, 999, 20, 12])("does not guess when current provider is invalid (%s)", async (providerId) => {
    accounts[0].defaultProviderId = providerId;
    await expect(save({ model: "exact-model" })).rejects.toThrow(/provider/i);
    expect(updates).toEqual([]);
  });

  it("rejects a provider with unknown enabled state", async () => {
    providers[0].isEnabled = null;
    await expect(save({ model: "exact-model" })).rejects.toThrow(/disabled/);
    expect(updates).toEqual([]);
  });

  it("requires an existing account", async () => {
    accounts = accounts.filter((row) => row.id !== 1);
    await expect(save({ model: "exact-model", providerId: 10 })).rejects.toThrow(/Account not found/);
    expect(updates).toEqual([]);
  });

  it.each([undefined, false])("saves exact model/current-provider pair without changing provider defaults (%s)", async (setProviderDefault) => {
    const beforeProviders = structuredClone(providers);
    const result = await save({ model: "  unlisted-model  ", setProviderDefault });
    expect(accounts[0]).toEqual({ id: 1, defaultModel: "unlisted-model", defaultProviderId: 10 });
    expect(accounts[1].defaultModel).toBe("private-account-model");
    expect(providers).toEqual(beforeProviders);
    expect(updates).toHaveLength(1);
    expect(updates[0].values).toEqual({ defaultModel: "unlisted-model", defaultProviderId: 10 });
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ updated: true, modelAccessVerified: false,
      resolvedDefault: { model: "unlisted-model", providerId: 10, source: "account" } });
  });

  it("persists an explicit route even when no current provider exists", async () => {
    accounts[0].defaultProviderId = null;
    await save({ model: "exact-model", providerId: 11 });
    expect(accounts[0]).toEqual({ id: 1, defaultModel: "exact-model", defaultProviderId: 11 });
    expect(providers[1].defaultModel).toBe("other-model");
  });

  it.each([undefined, 11])("updates only the chosen provider with explicit opt-in (provider %s)", async (providerId) => {
    const chosenId = providerId ?? 10;
    const untouched = structuredClone(providers.filter((row) => row.id !== chosenId));
    const result = await save({ model: "exact-model", providerId, setProviderDefault: true });
    expect(accounts[0].defaultProviderId).toBe(chosenId);
    expect(providers.find((row) => row.id === chosenId)?.defaultModel).toBe("exact-model");
    expect(providers.filter((row) => row.id !== chosenId)).toEqual(untouched);
    expect(updates).toHaveLength(2);
    expect(updates[1].values).toEqual({ defaultModel: "exact-model" });
    expect(updates[1].sql).toContain("`user_id` = ?");
    expect(updates[1].sql).toContain("`is_enabled` = ?");
    expect(updates[1].params).toEqual([chosenId, 1, true]);
    expect(JSON.stringify(result)).not.toContain("account model differs");
  });

  it("requires a real boolean opt-in, not a truthy string", async () => {
    await expect(save({ model: "exact-model", setProviderDefault: "true" })).rejects.toThrow();
    expect(updates).toEqual([]);
  });
});

describe("get_settings default resolution", () => {
  it("reports account precedence, mismatch and honest access guidance without calling an adapter", async () => {
    const result = await snapshot();
    expect(result).toMatchObject({
      resolvedDefault: { model: "account-model", providerId: 10, source: "account" },
      modelAccessVerified: false,
      warnings: expect.arrayContaining([
        expect.stringContaining("account model differs"),
        expect.stringContaining("not verified until a provider call"),
        expect.stringContaining("catalog listings do not prove access"),
      ]),
      nextSteps: expect.arrayContaining([
        expect.stringContaining("setProviderDefault: true"),
        expect.stringContaining("if access is denied"),
      ]),
    });
    expect(updates).toEqual([]);
  });

  it.each([null, "", "  "])("uses only the selected owned provider default when account model is %s", async (model) => {
    accounts[0].defaultModel = model;
    expect(await snapshot()).toMatchObject({ resolvedDefault: {
      model: "provider-model", providerId: 10, source: "provider",
    } });
  });

  it.each([null, 999, 20, 12])("reports unset for invalid selected routes (%s) without leaking foreign defaults", async (providerId) => {
    accounts[0].defaultProviderId = providerId;
    const result = await snapshot();
    expect(result).toMatchObject({
      defaultProviderId: providerId === 12 ? 12 : null,
      resolvedDefault: { model: null, providerId: null, source: "unset" },
      warnings: expect.arrayContaining([expect.stringContaining("no default route can be resolved")]),
      nextSteps: expect.arrayContaining([expect.stringContaining("providerId and your chosen model")]),
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private-provider-model");
    expect(serialized).not.toContain("private-account-model");
    expect(serialized).not.toContain("Private provider");
    expect(serialized).not.toContain("apiKeyRef");
    expect(serialized).not.toContain("synthetic-secret");
  });

  it("reports unset with guidance when both models are empty", async () => {
    accounts[0].defaultModel = null;
    providers[0].defaultModel = "";
    expect(await snapshot()).toMatchObject({
      resolvedDefault: { model: null, providerId: 10, source: "unset" },
      warnings: expect.arrayContaining([expect.stringContaining("Neither the account")]),
    });
  });
});
