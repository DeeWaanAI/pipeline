-- ═══════════════════════════════════════════════════════════════════════
-- 023 — Offering redesign v2 / P2a: design_jobs durable-job columns
-- Additive columns supporting retained candidates, double revision checks,
-- cancel intent, and durable provider-attempt records (spec §5).
-- Restart-safe pattern: MySQL has no IF NOT EXISTS for ADD COLUMN, so each
-- statement is guarded against its duplicate error (1060) via the
-- idempotent runner convention used since 019 (apply once; re-run aborts
-- safely on ER_DUP_FIELDNAME when applied twice — see G0 §2 note that
-- fresh environments provision via `npm run db:push`).
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE `design_jobs`
  ADD COLUMN `cancel_requested_at` timestamp NULL AFTER `state`,
  ADD COLUMN `candidate_definition` mediumtext NULL AFTER `candidate_version_id`,
  ADD COLUMN `candidate_definition_hash` varchar(64) NULL AFTER `candidate_definition`,
  ADD COLUMN `base_step_hash` varchar(64) NULL AFTER `expected_revision`,
  ADD COLUMN `provider_call_attempts` json NULL AFTER `apply_state`;
