-- Migration 007: Add structured description columns to marketplace_listings
-- These columns help LLM generate better test prompts and help reviewers understand the pipeline

ALTER TABLE marketplace_listings
  ADD COLUMN objectives TEXT NULL COMMENT 'What the pipeline aims to accomplish' AFTER description,
  ADD COLUMN input_format TEXT NULL COMMENT 'Expected format of user input' AFTER objectives,
  ADD COLUMN output_format TEXT NULL COMMENT 'Expected format of pipeline output' AFTER input_format,
  ADD COLUMN remarks TEXT NULL COMMENT 'Additional notes for reviewers' AFTER output_format;

-- Also ensure test_prompt_intermediate table exists (for pipeline step traces)
CREATE TABLE IF NOT EXISTS test_prompt_intermediate (
  id INT AUTO_INCREMENT PRIMARY KEY,
  test_prompt_id INT NOT NULL,
  step_index INT NOT NULL,
  step_name VARCHAR(100) NOT NULL,
  step_role VARCHAR(50),
  input_text TEXT NOT NULL,
  output_text TEXT NOT NULL,
  tokens_used INT,
  latency_ms INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_test_prompt (test_prompt_id),
  INDEX idx_step (step_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
