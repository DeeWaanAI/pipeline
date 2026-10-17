// SQLite local-first smoke (V3 L0): applies db/migrations-sqlite to a scratch
// file and proves insert/select/delete work through the production connection
// path. Usage:  npx tsx scripts/smoke-sqlite.mts
// Safe: writes only to a throwaway file under the system temp dir.
process.env.DB_DRIVER = "sqlite";
process.env.SQLITE_PATH = `${process.env.TMPDIR ?? "/tmp"}/deewaanai-smoke-${Date.now()}.db`;
process.env.APP_SECRET ||= "1".repeat(64);
process.env.AI_SWARM_MASTER_KEY ||= "2".repeat(64);
process.env.MARKETPLACE_MASTER_KEY ||= "3".repeat(64);

const { getDb } = await import("../api/queries/connection");
const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
const { users } = await import("../db/schema.sqlite");
const { eq } = await import("drizzle-orm");
const { rmSync } = await import("fs");

const file = process.env.SQLITE_PATH!;
const db = getDb();
migrate(db as never, { migrationsFolder: "db/migrations-sqlite" });
console.log("migrations: applied");

await db.insert(users).values({ username: "smoke", name: "Smoke", role: "user", tier: "standard" } as never);
const rows = await db.select().from(users).where(eq(users.username, "smoke"));
if (rows.length !== 1 || rows[0].name !== "Smoke") throw new Error("insert/select round-trip failed");
console.log("insert/select: ok");
await db.delete(users).where(eq(users.username, "smoke"));
console.log("delete: ok");

rmSync(file, { force: true });
rmSync(`${file}-wal`, { force: true });
rmSync(`${file}-shm`, { force: true });
console.log("sqlite smoke: PASS");
