// One-time hosted migration catch-up: applies db/migrations/022..036 in order
// to the hosted MySQL (59 of 89 tables present — the v2 offering tables were
// never migrated there). Additive only: CREATE TABLE / ADD COLUMN / index.
// Statements that already exist are logged and skipped (idempotent re-run).
import mysql from "mysql2/promise";
import { readFileSync, readdirSync } from "node:fs";

const url = Object.fromEntries(
  readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }),
).DATABASE_URL!;

const files = readdirSync("db/migrations")
  .filter((f) => /^02[2-9]_|^03[0-6]_/.test(f))
  .sort();

const conn = await mysql.createConnection({ uri: url, multipleStatements: false });
let applied = 0, skipped = 0, failed = 0;
for (const file of files) {
  const sql = readFileSync(`db/migrations/${file}`, "utf8");
  // Files mix "--> statement-breakpoint" and plain ";" terminators; strip
  // comment lines first, then split on both.
  const noComments = sql.replace(/^--.*$/gm, "");
  const stmts = noComments.split(/--> statement-breakpoint|;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== ";");
  console.log(`\n── ${file} (${stmts.length} statements)`);
  for (const stmt of stmts) {
    try {
      await conn.query(stmt);
      applied++;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/already exists|Duplicate column|Duplicate key|Duplicate entry|check constraint.*exists/i.test(msg)) {
        skipped++;
      } else {
        failed++;
        console.log(`  ✗ ${msg.slice(0, 160)}\n    stmt: ${stmt.slice(0, 100)}`);
      }
    }
  }
}
console.log(`\napplied=${applied} skipped(existing)=${skipped} failed=${failed}`);
await conn.end();
process.exit(failed ? 1 : 0);
