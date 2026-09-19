import { drizzle } from "drizzle-orm/mysql2";
import { env } from "../lib/env";
import * as schema from "@db/schema";
import * as relations from "@db/relations";

const fullSchema = { ...schema, ...relations };

let instance: ReturnType<typeof drizzle<typeof fullSchema>>;

export function getDb() {
  if (!instance) {
    instance = drizzle(env.databaseUrl, {
      mode: "default",
      schema: fullSchema,
    });
  }
  return instance;
}

let readInstance: ReturnType<typeof drizzle<typeof fullSchema>> | undefined;

/**
 * Read-optimized connection (Phase 3).
 *
 * Routes read-heavy queries to a dedicated read replica when
 * `DATABASE_READ_URL` is configured; otherwise returns the primary instance
 * (`getDb()`), so behavior is identical when the replica is unconfigured.
 *
 * Use ONLY for read-heavy, replication-lag-tolerant queries (browse/search/
 * public report data). All writes and consistency-critical reads must stay
 * on `getDb()`.
 */
export function getReadDb() {
  if (!env.databaseReadUrl) return getDb();
  if (!readInstance) {
    readInstance = drizzle(env.databaseReadUrl, {
      mode: "default",
      schema: fullSchema,
    });
  }
  return readInstance;
}
