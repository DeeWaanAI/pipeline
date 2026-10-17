// Parity gate for the dual-schema setup (V3 L0): db/schema.ts is the source of
// truth and db/schema.sqlite.ts is GENERATED from it (scripts/gen-sqlite-schema.mjs).
// If anyone edits the MySQL schema without regenerating, this test fails — the
// SQLite copy a local install runs on must be column-for-column identical.
import { describe, expect, it } from "vitest";
import { getTableConfig as mysqlConfig } from "drizzle-orm/mysql-core";
import { getTableConfig as sqliteConfig } from "drizzle-orm/sqlite-core";
import * as mysql from "@db/schema";
import * as sqlite from "@db/schema.sqlite";

function tables(mod: Record<string, unknown>, dialect: "mysql" | "sqlite") {
  const out = new Map<string, { columns: string[] }>();
  for (const value of Object.values(mod)) {
    if (!value || typeof value !== "object") continue;
    try {
      const cfg = dialect === "mysql"
        ? mysqlConfig(value as never)
        : sqliteConfig(value as never);
      out.set(cfg.name, { columns: cfg.columns.map((c) => c.name).sort() });
    } catch { /* not a table */ }
  }
  return out;
}

describe("schema parity: mysql source vs generated sqlite mirror", () => {
  const a = tables(mysql, "mysql");
  const b = tables(sqlite, "sqlite");

  it("same table set", () => {
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
  });

  it("every table has identical column names", () => {
    const diffs: string[] = [];
    for (const [name, t] of a) {
      const s = b.get(name);
      if (!s) continue; // caught by the table-set test
      if (s.columns.join(",") !== t.columns.join(",")) {
        diffs.push(`${name}: mysql=[${t.columns}] sqlite=[${s.columns}]`);
      }
    }
    expect(diffs).toEqual([]);
  });

  it("table count matches the hand-audited figure", () => {
    // Update this number deliberately when a table is added or dropped — it is
    // the tripwire that forces a conscious regen, not a silent drift.
    expect(a.size).toBe(88);
  });
});
