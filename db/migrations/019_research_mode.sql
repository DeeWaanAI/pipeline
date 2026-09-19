-- Migration 019: Research Mode — swarm_batches, batch_id, provider declaredRpm

-- Batch groups for Research Mode (runBatch)
CREATE TABLE swarm_batches (
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
) ENGINE=InnoDB;

-- Link swarm_runs to their batch
ALTER TABLE swarm_runs
  ADD COLUMN batch_id INT NULL AFTER completed_at,
  ADD INDEX idx_swarm_runs_batch_id (batch_id),
  ADD CONSTRAINT fk_swarm_runs_batch FOREIGN KEY (batch_id) REFERENCES swarm_batches(id) ON DELETE SET NULL;
