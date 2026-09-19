const mysql = require("mysql2/promise");

async function main() {
  const c = await mysql.createConnection({
    host: "127.0.0.1",
    port: 3307,
    user: "root",
    password: "rootpass",
    database: "swarm",
  });
  await c.execute(
    "ALTER TABLE users MODIFY COLUMN tier ENUM('standard', 'pro_designer', 'pro_auto') NOT NULL DEFAULT 'standard';"
  );
  console.log("✅ Tier migration complete!");
  await c.end();
}

main().catch((err) => {
  console.error("❌ Failed:", err.message);
  process.exit(1);
});
