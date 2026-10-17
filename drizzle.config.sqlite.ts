import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// SQLite dialect config (local-first installs, V3 spec). The schema is the
// generated mirror of db/schema.ts — regenerate it before `generate`:
//   node scripts/gen-sqlite-schema.mjs && npx drizzle-kit generate --config drizzle.config.sqlite.ts
export default defineConfig({
  schema: "./db/schema.sqlite.ts",
  out: "./db/migrations-sqlite",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.SQLITE_PATH ?? "./.sqlite-dev.db",
  },
});
