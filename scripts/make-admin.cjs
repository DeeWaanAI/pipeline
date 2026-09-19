#!/usr/bin/env node
/**
 * Promote a user to admin by username.
 *
 * Usage:
 *   node scripts/make-admin.cjs <username>
 *   # or via npm:
 *   npm run make-admin -- <username>
 *
 * Example:
 *   npm run make-admin -- admin
 */
require("dotenv").config();

const username = process.argv[2];
if (!username) {
  console.error("Usage: node scripts/make-admin.cjs <username>");
  process.exit(1);
}

async function main() {
  // Lazy-load mysql2 directly so we don't depend on drizzle bootstrapping.
  const mysql = require("mysql2/promise");
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is not set. Please configure your .env file.");
    process.exit(1);
  }
  const conn = await mysql.createConnection(dbUrl);
  try {
    const [rows] = await conn.execute(
      "UPDATE users SET role = 'admin' WHERE username = ?",
      [username]
    );
    if (rows.affectedRows === 0) {
      console.error(`No user found with username "${username}".`);
      process.exit(1);
    }
    console.log(`✓ User "${username}" is now an admin.`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
