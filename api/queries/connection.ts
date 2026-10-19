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
      const db = drizzleSqlite(sqlite, {
        schema: { ...schemaSqlite, ...relations },
      });

      // ── mysql2-shaped write results ──────────────────────────────
      // mysql2 returns writes as [ResultSetHeader, fields], and 30+ call
      // sites destructure `const [r] = await db.insert(…)` then read
      // `r.insertId`. better-sqlite3 returns a plain { changes,
      // lastInsertRowid }. Patch prepared-statement run() so its result is
      // iterable as a one-element tuple carrying both shapes.
      const origPrepare = sqlite.prepare.bind(sqlite);
      sqlite.prepare = ((sql: string) => {
        const stmt = origPrepare(sql);
        const origRun = stmt.run.bind(stmt);
        stmt.run = ((...args: unknown[]) => {
          const r = origRun(...args) as { changes: number; lastInsertRowid: number | bigint };
          if (r && typeof r === "object" && "lastInsertRowid" in r) {
            const header = Object.assign([] as unknown as unknown[] & {
              changes: number; lastInsertRowid: number | bigint; insertId: number;
            }, r, { insertId: Number(r.lastInsertRowid), affectedRows: r.changes });
            header[0] = header;
            return header;
          }
          return r;
        }) as typeof stmt.run;
        return stmt;
      }) as typeof sqlite.prepare;

      // ── Async-transaction emulation ──────────────────────────────
      // The codebase's 20+ `db.transaction(async …)` sites target mysql2,
      // whose driver is async. better-sqlite3 is synchronous and REJECTS an
      // async transaction callback ("Transaction function cannot return a
      // promise"). A local install is single-user, so we serialize explicit
      // BEGIN/COMMIT blocks on a promise chain: every underlying drizzle op
      // executes synchronously, the awaits just yield microtasks. A call
      // made while a transaction is already open (nested or an interleaved
      // request) runs its callback inside the open transaction — SQLite
      // serializes the writes either way.
      let txOpen = false;
      let txChain: Promise<unknown> = Promise.resolve();
      db.transaction = ((fn: (tx: unknown) => Promise<unknown> | unknown) => {
        if (txOpen) return Promise.resolve(fn(db));
        const run = txChain.then(async () => {
          txOpen = true;
          sqlite.exec("BEGIN");
          try {
            const result = await fn(db);
            sqlite.exec("COMMIT");
            return result;
          } catch (err) {
            sqlite.exec("ROLLBACK");
            throw err;
          } finally {
            txOpen = false;
          }
        });
        txChain = run.catch(() => { /* queue survives failures */ });
        return run;
      }) as typeof db.transaction;

      instance = db as unknown as AppDb;
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
/** SELECT ... FOR UPDATE on MySQL; a deliberate no-op on SQLite, which has no
 *  locking reads and doesn't need them: our emulated transactions serialize
 *  writers, and every `.for("update")` site runs inside one. */
export function lockForUpdate<T>(query: T): T {
  if (env.dbDriver === "sqlite") return query;
  return (query as unknown as { for: (mode: "update") => T }).for("update");
}

export const isSqlite = () => env.dbDriver === "sqlite";

/** Dialect-correct random ordering expression. */
export const randomOrderSql = () => (env.dbDriver === "sqlite" ? "RANDOM()" : "RAND()");
