// One-time drift check: compare the hosted MySQL schema against db/schema.ts
// and print the missing columns (table, column, SQL type) — nothing is written.
import { getTableConfig } from "drizzle-orm/mysql-core";
import * as schema from "../db/schema";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";

const url = Object.fromEntries(
  readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }),
).DATABASE_URL!;

const conn = await mysql.createConnection(url);
for (const value of Object.values(schema)) {
  let cfg;
  try { cfg = getTableConfig(value as any); } catch { continue; }
  const [cols] = await conn.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?",
    [cfg.name],
  );
  const present = new Set((cols as any[]).map((c) => c.COLUMN_NAME));
  const missing = cfg.columns.filter((c) => !present.has(c.name))
    .map((c) => `${c.name} ${c.getSQLType()}`);
  if (missing.length) console.log(`${cfg.name}: MISSING ${missing.join(" | ")}`);
}
await conn.end();
console.log("— scan complete");
