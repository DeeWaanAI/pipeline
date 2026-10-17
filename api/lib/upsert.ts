import { isSqlite } from "../queries/connection";

/**
 * insert-or-update by unique key, dialect-correct. The MySQL path uses the
 * atomic ON DUPLICATE KEY UPDATE; the SQLite path uses ON CONFLICT DO UPDATE.
 * The `unknown` casts are confined to this file: the two drizzle builders are
 * different types over what is — per the schema parity test — the same table.
 *
 * `set` receives the dialect's own table object so column references inside
 * sql`` templates are quoted correctly for each dialect.
 */
export async function upsertOnUniqueKey(args: {
  db: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mysqlTable: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sqliteTable: any;
  values: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conflictTarget: (sqliteTable: any) => any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  set: (table: any) => Record<string, unknown>;
}): Promise<void> {
  if (isSqlite()) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (args.db as any)
      .insert(args.sqliteTable)
      .values(args.values)
      .onConflictDoUpdate({ target: args.conflictTarget(args.sqliteTable), set: args.set(args.sqliteTable) });
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (args.db as any)
      .insert(args.mysqlTable)
      .values(args.values)
      .onDuplicateKeyUpdate({ set: args.set(args.mysqlTable) });
  }
}
