-- Existing reports remain private drafts: no consent or publication is inferred.
ALTER TABLE `external_evidence_reports`
  ADD COLUMN `publication_state` ENUM('draft', 'published', 'withdrawn') NOT NULL DEFAULT 'draft',
  ADD COLUMN `consent_version` VARCHAR(40) NULL,
  ADD COLUMN `preview_hash` VARCHAR(64) NULL,
  ADD COLUMN `published_at` TIMESTAMP NULL,
  ADD COLUMN `withdrawn_at` TIMESTAMP NULL;
