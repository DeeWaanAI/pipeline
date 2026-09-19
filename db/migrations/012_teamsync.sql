-- 012_teamsync.sql — TeamSync (Phase 2)
-- Cross-app team collaboration: seat billing state, optimistic memory
-- locking for shared project state, and approval handoff assignments.
-- All additive: no column drops, no data backfills. MySQL 8.

-- Seat billing: one row per team; quantity synced from team_members.
CREATE TABLE IF NOT EXISTS team_seats (
  id INT AUTO_INCREMENT PRIMARY KEY,
  team_id INT NOT NULL UNIQUE,
  seats INT NOT NULL DEFAULT 1,
  stripe_subscription_id VARCHAR(100) NULL,
  stripe_subscription_item_id VARCHAR(100) NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_team_seats_team FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE CASCADE
);

-- Optimistic concurrency for the shared project state file.
-- Episodic memory is append-only (no lock needed); state.json writes
-- must carry the expected version — worst case a teammate re-reads
-- and retries; never a lost write.
CREATE TABLE IF NOT EXISTS memory_locks (
  project_id INT NOT NULL PRIMARY KEY,
  version INT NOT NULL DEFAULT 1,
  last_writer_id INT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_memory_locks_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);

-- Cross-app approval handoff: "Bob opens Kimi, sees Alice's run
-- waiting for his approval". One pending row per (run, assignee).
CREATE TABLE IF NOT EXISTS approval_assignments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  swarm_run_id INT NOT NULL,
  assignee_user_id INT NOT NULL,
  assigned_by INT NOT NULL,
  status ENUM('pending', 'completed', 'cancelled') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NULL,
  CONSTRAINT fk_approval_assign_run FOREIGN KEY (swarm_run_id) REFERENCES swarm_runs (id) ON DELETE CASCADE,
  CONSTRAINT fk_approval_assign_assignee FOREIGN KEY (assignee_user_id) REFERENCES users (id) ON DELETE CASCADE,
  KEY idx_approval_assign_assignee (assignee_user_id, status),
  KEY idx_approval_assign_run (swarm_run_id)
);
