-- 014_marketplace_trust.sql — Marketplace Trust & Certification (Phase 0)
-- Spec: DeeWaanAI-Next/MARKETPLACE-TRUST-SPEC.md (§0.1, 0.5.1, 0.8).
-- Adds the `certifying` listing status (visible-but-not-buyable), the
-- `certified_at` outcome timestamp, and the blind per-prompt review pool.
-- All additive: no column drops, no data backfills. MySQL 8.

-- `certifying` = visible in marketplace, NOT buyable, awaiting blind human
-- review. `published` keeps meaning buyable & human-certified.
ALTER TABLE marketplace_listings
  MODIFY COLUMN status ENUM(
    'draft', 'generating', 'pending_review', 'reviewing', 'certifying',
    'rejected', 'approved', 'published', 'unpublished'
  ) NULL DEFAULT 'draft';

ALTER TABLE marketplace_listings
  ADD COLUMN certified_at TIMESTAMP NULL;

-- Blind review pool (spec 0.5). listing_id is SERVER-ONLY — never sent to
-- clients. Rows are enqueued UNASSIGNED (reviewer_id NULL, status 'pooled')
-- when a listing enters `certifying`; reviewers claim one task at a time.
-- MySQL unique indexes treat NULLs as distinct, so the unique key below does
-- NOT dedupe pooled rows — enqueue code dedupes pooled rows; the key still
-- prevents one reviewer claiming the same (listing, prompt) twice.
CREATE TABLE IF NOT EXISTS blind_review_tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  listing_id INT NOT NULL,
  prompt_index INT NOT NULL,
  reviewer_id INT NULL,
  status ENUM('pooled', 'assigned', 'completed', 'expired') NOT NULL DEFAULT 'pooled',
  assigned_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL,
  CONSTRAINT uq_blind_review_tasks_listing_prompt_reviewer
    UNIQUE (listing_id, prompt_index, reviewer_id),
  CONSTRAINT fk_blind_task_listing FOREIGN KEY (listing_id) REFERENCES marketplace_listings (id) ON DELETE CASCADE,
  CONSTRAINT fk_blind_task_reviewer FOREIGN KEY (reviewer_id) REFERENCES users (id) ON DELETE CASCADE,
  KEY idx_blind_review_tasks_pool (status, listing_id)
);
