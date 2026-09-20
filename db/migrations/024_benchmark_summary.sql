-- 024 — Offering redesign v2 / P2b: benchmarks summary columns (additive).
ALTER TABLE `benchmarks`
  ADD COLUMN `summary` mediumtext NULL,
  ADD COLUMN `summary_computed_at` timestamp NULL;
