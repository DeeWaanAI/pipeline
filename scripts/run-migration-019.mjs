// Idempotent runner for db/migrations/019_research_mode.sql (Research Mode).
// Production deploys don't auto-run migrations; the deployed code now writes
// swarm_runs.batch_id on every run insert, so 019 is REQUIRED for any
// pipeline run to work. Safe to run repeatedly.
// Usage: DATABASE_URL=... node scripts/run-migration-019.mjs
import mysql from 'mysql2/promise';

async function main() {
  const DATABASE_URL = process.env.DATABASE_URL || 'mysql://swarm:swarmpass@localhost:3306/swarm';
  const conn = await mysql.createConnection({ uri: DATABASE_URL });

  const [tables] = await conn.execute("SHOW TABLES LIKE 'swarm_batches'");
  if (tables.length === 0) {
    console.log('Creating swarm_batches table...');
    await conn.query(`CREATE TABLE swarm_batches (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      user_id       INT NOT NULL,
      project_id    INT NOT NULL,
      name          VARCHAR(200),
      status        VARCHAR(30) NOT NULL DEFAULT 'running',
      total_runs    INT NOT NULL,
      completed_runs INT NOT NULL DEFAULT 0,
      failed_runs   INT NOT NULL DEFAULT 0,
      total_tokens_used INT NOT NULL DEFAULT 0,
      created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at  TIMESTAMP NULL,
      INDEX idx_swarm_batches_user_id (user_id),
      INDEX idx_swarm_batches_project_id (project_id),
      INDEX idx_swarm_batches_status (status),
      CONSTRAINT fk_swarm_batches_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_swarm_batches_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);
    console.log('swarm_batches created.');
  } else {
    console.log('swarm_batches already exists — skipping.');
  }

  const [cols] = await conn.execute("SHOW COLUMNS FROM swarm_runs LIKE 'batch_id'");
  if (cols.length === 0) {
    console.log('Adding swarm_runs.batch_id...');
    await conn.query(`ALTER TABLE swarm_runs
      ADD COLUMN batch_id INT NULL AFTER completed_at,
      ADD INDEX idx_swarm_runs_batch_id (batch_id),
      ADD CONSTRAINT fk_swarm_runs_batch FOREIGN KEY (batch_id) REFERENCES swarm_batches(id) ON DELETE SET NULL`);
    console.log('swarm_runs.batch_id added.');
  } else {
    console.log('swarm_runs.batch_id already exists — skipping.');
  }

  await conn.end();
  console.log('Migration 019 complete.');
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
