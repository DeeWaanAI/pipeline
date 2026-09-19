/**
 * One-off migration: add structured description columns to marketplace_listings
 * Run: npx tsx db/migrate-add-columns.ts
 */
import "dotenv/config";
import { createConnection } from "mysql2/promise";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not found in .env");
    process.exit(1);
  }

  // Parse mysql2 connection string
  // Format: mysql://user:pass@host:port/database
  const match = url.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
  if (!match) {
    console.error("Could not parse DATABASE_URL");
    process.exit(1);
  }

  const [, user, password, host, port, database] = match;

  const conn = await createConnection({
    host,
    port: parseInt(port),
    user,
    password,
    database,
  });

  console.log("Connected to database. Checking columns...");

  // Check which columns already exist
  const [rows] = await conn.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'marketplace_listings'`,
    [database]
  );

  const existingColumns = new Set((rows as Array<{ COLUMN_NAME: string }>).map((r) => r.COLUMN_NAME));
  console.log("Existing columns:", Array.from(existingColumns).join(", "));

  const columnsToAdd = [
    { name: "objectives", sql: "objectives TEXT NULL AFTER description" },
    { name: "input_format", sql: "input_format TEXT NULL AFTER objectives" },
    { name: "output_format", sql: "output_format TEXT NULL AFTER input_format" },
    { name: "remarks", sql: "remarks TEXT NULL AFTER output_format" },
  ];

  for (const col of columnsToAdd) {
    if (existingColumns.has(col.name)) {
      console.log(`  Column '${col.name}' already exists — skipping`);
      continue;
    }
    try {
      await conn.execute(`ALTER TABLE marketplace_listings ADD COLUMN ${col.sql}`);
      console.log(`  Added column '${col.name}'`);
    } catch (err) {
      console.error(`  Failed to add '${col.name}':`, (err as Error).message);
    }
  }

  await conn.end();
  console.log("\nMigration complete!");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
