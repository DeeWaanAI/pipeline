-- Migration: Add secondary indexes for performance
-- Run: docker exec -i swarm-mysql mysql -uswarm -pswarmpass swarm < db/migrate-indexes.sql

-- Projects
CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);

-- LLM Providers
CREATE INDEX IF NOT EXISTS idx_llm_providers_user_id ON llm_providers(user_id);

-- Swarm Runs
CREATE INDEX IF NOT EXISTS idx_swarm_runs_project_id ON swarm_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_swarm_runs_user_id ON swarm_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_swarm_runs_status ON swarm_runs(status);

-- Agent Runs
CREATE INDEX IF NOT EXISTS idx_agent_runs_swarm_run_id ON agent_runs(swarm_run_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_project_id ON agent_runs(project_id);

-- Agent Responses
CREATE INDEX IF NOT EXISTS idx_agent_responses_swarm_run_id ON agent_responses(swarm_run_id);
CREATE INDEX IF NOT EXISTS idx_agent_responses_agent_run_id ON agent_responses(agent_run_id);
CREATE INDEX IF NOT EXISTS idx_agent_responses_project_id ON agent_responses(project_id);

-- Debug Logs
CREATE INDEX IF NOT EXISTS idx_debug_logs_swarm_run_id ON debug_logs(swarm_run_id);
CREATE INDEX IF NOT EXISTS idx_debug_logs_project_id ON debug_logs(project_id);

-- Project Files
CREATE INDEX IF NOT EXISTS idx_project_files_project_id ON project_files(project_id);
CREATE INDEX IF NOT EXISTS idx_project_files_path ON project_files(project_id, path);

-- File Dependencies
CREATE INDEX IF NOT EXISTS idx_file_deps_source ON file_dependencies(source_file_id);
CREATE INDEX IF NOT EXISTS idx_file_deps_target ON file_dependencies(target_file_id);

-- Pipeline Steps
CREATE INDEX IF NOT EXISTS idx_pipeline_steps_project_id ON pipeline_steps(project_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_steps_order ON pipeline_steps(project_id, step_order);

-- Custom Agents
CREATE INDEX IF NOT EXISTS idx_custom_agents_user_id ON custom_agents(user_id);
CREATE INDEX IF NOT EXISTS idx_custom_agents_slug ON custom_agents(user_id, slug);

-- Team Members
CREATE INDEX IF NOT EXISTS idx_team_members_user_id ON team_members(user_id);
CREATE INDEX IF NOT EXISTS idx_team_members_team_id ON team_members(team_id);

-- Team Projects
CREATE INDEX IF NOT EXISTS idx_team_projects_team_id ON team_projects(team_id);
CREATE INDEX IF NOT EXISTS idx_team_projects_project_id ON team_projects(project_id);

-- Feedback
CREATE INDEX IF NOT EXISTS idx_feedback_team_id ON feedback(team_id);
CREATE INDEX IF NOT EXISTS idx_feedback_project_id ON feedback(project_id);
CREATE INDEX IF NOT EXISTS idx_feedback_user_id ON feedback(user_id);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);

-- Issues
CREATE INDEX IF NOT EXISTS idx_issues_team_id ON issues(team_id);
CREATE INDEX IF NOT EXISTS idx_issues_project_id ON issues(project_id);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);

-- Activity Log
CREATE INDEX IF NOT EXISTS idx_activity_log_user_id ON activity_log(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_team_id ON activity_log(team_id);

-- Notifications
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, is_read);

-- Vouchers table
CREATE TABLE IF NOT EXISTS vouchers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,
  tier ENUM('pro_designer', 'pro_auto') NOT NULL,
  duration_days INT NOT NULL DEFAULT 30,
  max_uses INT NOT NULL DEFAULT 1,
  used_count INT NOT NULL DEFAULT 0,
  label VARCHAR(200),
  expires_at TIMESTAMP NULL,
  created_by INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Voucher redemptions tracking
CREATE TABLE IF NOT EXISTS voucher_redemptions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  voucher_id INT NOT NULL,
  user_id INT NOT NULL,
  redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  tier_expires_at TIMESTAMP NULL,
  UNIQUE KEY unique_voucher_user (voucher_id, user_id),
  FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Notifications table
CREATE TABLE IF NOT EXISTS notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT,
  data_json JSON,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_notifications_user_id (user_id),
  INDEX idx_notifications_unread (user_id, is_read),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
