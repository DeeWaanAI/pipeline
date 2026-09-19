-- Migration 021: Widen content columns to MEDIUMTEXT + add swarm_runs.error
-- Date: 2026-07-31
-- Reason: Pipeline outputs overflow 64 KiB MySQL TEXT limit.

ALTER TABLE agent_runs
  MODIFY system_prompt MEDIUMTEXT,
  MODIFY user_prompt MEDIUMTEXT NOT NULL,
  MODIFY context_input MEDIUMTEXT;

ALTER TABLE agent_responses
  MODIFY content MEDIUMTEXT NOT NULL;

ALTER TABLE swarm_runs
  MODIFY user_prompt MEDIUMTEXT NOT NULL,
  ADD COLUMN error TEXT AFTER batch_id;
