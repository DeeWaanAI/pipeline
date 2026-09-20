-- 025 — Offering redesign v2 / P2b: benchmarks lease/cancel/source columns (additive).
ALTER TABLE `benchmarks`
  ADD COLUMN `lease_expires_at` timestamp NULL,
  ADD COLUMN `cancel_requested_at` timestamp NULL,
  ADD COLUMN `source_project_id` int NULL;
