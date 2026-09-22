-- D12 (OFFERING-REDESIGN-TECH-SPECS §1.1): the evidence judging panel must be
-- vendor-disjoint — "vendor" means the model's DEVELOPER (deepseek, meta,
-- zhipu, ...), which does not exist in the data model today: `llm_providers`
-- is a serving account and one host (e.g. Together) serves many vendors'
-- models. The attribution therefore belongs on the admin-reviewed catalog
-- (§12.1), next to the reviewed family/lineage it already carries.
--
-- Additive only: nullable column, no backfill, nothing dropped.
-- NULL means "vendor unknown". An unknown vendor counts as DISJOINT FROM
-- NOTHING: it can never satisfy the evidence-panel gate, and it never
-- collides with another model either (the refusal text says so).
ALTER TABLE `model_catalog`
  ADD COLUMN `vendor` VARCHAR(80) NULL AFTER `family`;
