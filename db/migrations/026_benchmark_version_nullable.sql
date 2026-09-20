-- 026 — Offering redesign v2 / P2b: benchmarks.pipeline_version_id may be NULL.
-- A draft has no frozen workflow version yet: the immutable snapshot is
-- captured when the plan starts (spec §4.1). Drafts previously had to insert a
-- placeholder 0, which the FK to pipeline_versions(id) rejects.
-- Additive/widening only: no data change, existing values untouched, the FK
-- and its RESTRICT delete rule are unchanged (NULL is simply permitted).
ALTER TABLE `benchmarks`
  MODIFY COLUMN `pipeline_version_id` int NULL;
