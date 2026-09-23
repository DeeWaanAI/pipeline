-- Consented feedback attachments (D11, ticket #22).
--
-- WHAT THIS IS FOR. A user reporting a problem with a specific pipeline, run or
-- benchmark has to be able to attach THAT object, or support is reading a
-- description of a symptom with nothing behind it. The owner's decision is that
-- this is CONSENTED and PER ITEM: nothing is harvested automatically, each
-- attachment is an explicit opt-in on that one object, and the row keeps which
-- consent text the user agreed to.
--
-- ADDITIVE ONLY. One CREATE TABLE. Nothing here drops, renames, narrows or
-- alters an existing column or table, and no existing row is touched. The
-- `ref_id` column is deliberately NOT a foreign key: the consent is to the
-- frozen snapshot, so the receipt has to stay readable after the author deletes
-- the object it describes, and a constraint here would either cascade into the
-- feedback row or block a delete the user is entitled to make.
--
-- WHY `snapshot` CANNOT BECOME A LEAKAGE CHANNEL (spec A12). The snapshot is
-- written by api/services/feedbackAttachments.ts, and that module selects
-- NOTHING by hand: it calls the projections the author already reads —
-- `pipelineSharing.getSharedWorkflow`, `runAccess.projectRunDetail`,
-- `pipelineSharing.getSharedRunView`,
-- `marketplaceExecutionService.getProtectedRunView` and
-- `benchmarkService.getBenchmarkProgress`. A user may attach a run they RAN
-- even when the workflow belongs to someone else (a `run_only` share, a
-- marketplace buyer run), and for those the stored snapshot is the SAME
-- redacted view that run's own owner already sees — no step prompt, no system
-- prompt, no context input, no grantor model, no provider credential. An
-- attachment therefore cannot widen anyone's entitlement; it copies what the
-- consenting account could already read. `visibility` inside the snapshot JSON
-- records which of the two cases each row is.
--
-- NO PLAN OR TIER GATE. The paid-tier ladder and the team feature were deleted
-- from this codebase (ticket #26 and the 2026-09-22 owner decisions); this
-- table introduces no capability check and no group, workspace or org concept.
-- Ownership is the only rule, and it is enforced in code, not in DDL.

CREATE TABLE IF NOT EXISTS `feedback_attachments` (
  `id` int NOT NULL AUTO_INCREMENT,
  -- The feedback row this receipt is attached to. Cascade in that direction
  -- only: deleting the feedback ends the attachment's purpose, and the
  -- attached pipeline/run/benchmark is never reached by this.
  `feedback_id` int NOT NULL,
  -- The consenting author. An attachment is readable by the account that
  -- consented to it and by support, and by nobody else.
  `user_id` int NOT NULL,
  -- The three objects this product actually has.
  `kind` ENUM('pipeline', 'run', 'benchmark') NOT NULL,
  `ref_id` int NOT NULL,
  -- Which consent text was agreed to. NOT NULL on purpose: a row cannot exist
  -- without a recorded consent, and the value is stamped server-side from
  -- DEFAULT_CONSENT_VERSION (api/services/evidenceService.ts) rather than
  -- supplied by the caller, so no client can claim an older or invented one.
  `consent_version` VARCHAR(40) NOT NULL,
  -- Canonical JSON snapshot (mediumtext, as `pipeline_versions.definition`
  -- does: a frozen blob that can legitimately be large).
  `snapshot` mediumtext NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- MySQL 8 refuses an AUTO_INCREMENT column that is not a key (error 1075),
  -- and `db/schema.ts` declares `id` as the primary key, so the SQL must too.
  PRIMARY KEY (`id`),
  CONSTRAINT `feedback_attachments_feedback_id_fk`
    FOREIGN KEY (`feedback_id`) REFERENCES `feedback` (`id`) ON DELETE CASCADE,
  CONSTRAINT `feedback_attachments_user_id_fk`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  INDEX `idx_feedback_attachments_feedback_id` (`feedback_id`),
  INDEX `idx_feedback_attachments_user_id` (`user_id`),
  INDEX `idx_feedback_attachments_kind_ref` (`kind`, `ref_id`)
);
