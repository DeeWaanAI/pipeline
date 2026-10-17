import { drizzle as drizzleMysql, type MySql2Database } from "drizzle-orm/mysql2";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { homedir } from "os";
import { env } from "../lib/env";
import * as schema from "@db/schema";
import * as schemaSqlite from "@db/schema.sqlite";
import * as relations from "@db/relations";

const fullSchema = { ...schema, ...relations };

/** The query surface every caller sees. The SQLite instance is created with
 *  the generated mirror schema (`db/schema.sqlite.ts`), which the parity test
 *  proves is column-for-column identical — so it is safe to present it under
 *  the MySQL-flavoured type and keep every existing call site unchanged. */
export type AppDb = MySql2Database<typeof fullSchema>;

let instance: AppDb;

function sqliteFilePath(): string {
  if (env.sqlitePath) {
    mkdirSync(dirname(env.sqlitePath), { recursive: true });
    return env.sqlitePath;
  }
  const dir = `${homedir()}/.deewaanai`;
  mkdirSync(dir, { recursive: true });
  return `${dir}/deewaanai.db`;
}

export function getDb(): AppDb {
  if (!instance) {
    if (env.dbDriver === "sqlite") {
      const file = sqliteFilePath();
      const sqlite = new Database(file);
      sqlite.pragma("journal_mode = WAL");
      // FK enforcement is OFF by default in SQLite — the MySQL schema relies on
      // onDelete cascade/restrict everywhere, so this must be unconditional.
      sqlite.pragma("foreign_keys = ON");
      instance = drizzleSqlite(sqlite, {
        schema: { ...schemaSqlite, ...relations },
      }) as unknown as AppDb;
    } else {
      instance = drizzleMysql(env.databaseUrl, {
        mode: "default",
        schema: fullSchema,
      });
    }
  }
  return instance;
}

let readInstance: AppDb | undefined;

/**
 * Read-optimized connection (Phase 3).
 *
 * Routes read-heavy queries to a dedicated read replica when
 * `DATABASE_READ_URL` is configured; otherwise returns the primary instance
 * (`getDb()`), so behavior is identical when the replica is unconfigured.
 * Meaningless for SQLite (a local file has no replica) — always the primary.
 *
 * Use ONLY for read-heavy, replication-lag-tolerant queries (browse/search/
 * public report data). All writes and consistency-critical reads must stay
 * on `getDb()`.
 */
export function getReadDb(): AppDb {
  if (env.dbDriver === "sqlite" || !env.databaseReadUrl) return getDb();
  if (!readInstance) {
    readInstance = drizzleMysql(env.databaseReadUrl, {
      mode: "default",
      schema: fullSchema,
    });
  }
  return readInstance;
}

/** Dialect-correct liveness probe. better-sqlite3's drizzle instance has no
 *  `.execute`, so health checks must not assume the MySQL surface. */
export async function pingDb(db: AppDb): Promise<void> {
  if (env.dbDriver === "sqlite") {
    (db as unknown as { $client: Database.Database }).$client.prepare("SELECT 1").get();
    return;
  }
  await db.execute("SELECT 1");
}

/** True when the process is running the local-first SQLite store. Callers use
 *  this to branch around MySQL-only SQL (upserts, RAND(), …). */
export const isSqlite = () => env.dbDriver === "sqlite";

/** Dialect-correct random ordering expression. */
export const randomOrderSql = () => (env.dbDriver === "sqlite" ? "RANDOM()" : "RAND()");
