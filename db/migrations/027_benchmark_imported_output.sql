-- 027 — Offering redesign v2 / P2b: grade an EXISTING owned output
-- (spec §4.1 steps 1 and 4, acceptance test A01: "do not regenerate an existing
-- output unless requested"). A candidate may be a prior response the owner
-- already has rather than a fresh execution, so that grading spends no
-- generation call and is not attested as execution performed by THIS plan.
--
-- Both changes are additive in effect:
--  * new nullable column `imported_response_id`. ON DELETE SET NULL because the
--    graded text and its hash are copied onto benchmark_runs, so deleting the
--    source run later cannot destroy the evaluation evidence (and the source
--    row is not what the evidence rests on).
--  * the `strategy` enum gains a THIRD value appended at the end. No existing
--    value is repurposed, renumbered or reinterpreted, so every row written
--    before this migration keeps its meaning.
ALTER TABLE `benchmark_candidates`
  ADD COLUMN `imported_response_id` int DEFAULT NULL,
  MODIFY COLUMN `strategy` enum('pipeline','solo_baseline','imported_output') NOT NULL;

ALTER TABLE `benchmark_candidates`
  ADD CONSTRAINT `benchmark_candidates_imported_response_id_agent_responses_id_fk`
    FOREIGN KEY (`imported_response_id`) REFERENCES `agent_responses` (`id`) ON DELETE SET NULL;
