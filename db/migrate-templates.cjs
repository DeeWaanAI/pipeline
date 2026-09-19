require("dotenv/config");
const mysql = require("mysql2/promise");

async function main() {
  const url = new URL(process.env.DATABASE_URL);
  const conn = await mysql.createConnection({
    host: url.hostname,
    port: parseInt(url.port) || 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace("/", ""),
    ssl: { rejectUnauthorized: false },
  });

  // Add pipeline_template_id to projects
  try {
    await conn.execute(
      `ALTER TABLE projects ADD COLUMN pipeline_template_id INT`
    );
    console.log("Added pipeline_template_id to projects");
  } catch (e) {
    if (e.message.includes("Duplicate")) console.log("pipeline_template_id already exists");
    else console.error("projects:", e.message);
  }

  // Create pipeline_templates table
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS pipeline_templates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        name VARCHAR(200) NOT NULL,
        description TEXT,
        steps JSON NOT NULL,
        is_auto BOOLEAN NOT NULL DEFAULT FALSE,
        source_project_id INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    console.log("Created pipeline_templates table");
  } catch (e) {
    console.error("pipeline_templates:", e.message);
  }

  await conn.end();
  console.log("Done");
}

main().catch(console.error);
