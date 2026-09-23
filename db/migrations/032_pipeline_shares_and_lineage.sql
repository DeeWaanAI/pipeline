-- Pipeline sharing + publish lineage (owner decisions, 2026-09-22).
--
-- TWO RULES, ONE MIGRATION, both ADDITIVE (nullable-without-default or a safe
-- default; nothing dropped, renamed, or narrowed):
--
-- (1) SHARING IS A PER-OBJECT GRANT BETWEEN TWO INDIVIDUAL ACCOUNTS.
--     Teams were deleted from this codebase (ticket #26) and nothing here
--     reintroduces a group, workspace or org concept: one row of
--     `pipeline_shares` says "account A lets account B use this one pipeline",
--     in `run_only` (B runs it, B never reads the prompts or the definition)
--     or `full` (B also reads the definition, and edits only when
--     `can_modify`). A share is a row, not a transfer: `projects.user_id` and
--     every `pipeline_versions.owner_id` stay with the grantor, and
--     `state`/'revoked' is how it is taken back — the row stays as the record
--     that access was ever given.
--
-- (2) ONLY THE ORIGINAL CREATOR MAY PUBLISH ON THE MARKETPLACE.
--     The tier capability gate was deleted with the tier ladder, which left
--     the MCP publish surface with NO gate at all (desktop-pass finding 25).
--     It is replaced by LINEAGE, recorded as data rather than as a name or a
--     prompt-similarity guess: `origin_creator_id` names the account that
--     originally created the work a project/version derives from, and
--     `origin_version_id` points at the earliest known version of it. Copying
--     a pipeline's steps into a new project carries both forward, so a share
--     recipient, an importer or a cloner can run and even improve the work but
--     can never sell it.
--
-- FALLBACK FOR EXISTING ROWS (this is what keeps the ~7 benchmarks and the 1
-- listing in the local database publishable by whoever created them):
-- `origin_creator_id` is NULL on every row that predates this migration, and
-- the reader treats NULL as "this row's own owner is the original creator".
-- No back-fill, no rewrite, nothing destructive.

-- ─── (1) the grant table ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `pipeline_shares` (
  `id` int NOT NULL AUTO_INCREMENT,
  `project_id` int NOT NULL,
  `owner_id` int NOT NULL,
  `grantee_id` int NOT NULL,
  `access_mode` ENUM('run_only', 'full') NOT NULL DEFAULT 'run_only',
  `can_modify` boolean NOT NULL DEFAULT false,
  `state` ENUM('active', 'revoked') NOT NULL DEFAULT 'active',
  `note` VARCHAR(500),
  `granted_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `revoked_at` timestamp NULL,
  -- MySQL 8 refuses an AUTO_INCREMENT column that is not a key (error 1075),
  -- and `db/schema.ts` declares `id` as the primary key, so the SQL must too.
  PRIMARY KEY (`id`),
  CONSTRAINT `pipeline_shares_project_id_fk`
    FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `pipeline_shares_owner_id_fk`
    FOREIGN KEY (`owner_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `pipeline_shares_grantee_id_fk`
    FOREIGN KEY (`grantee_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `uq_pipeline_shares_project_grantee` UNIQUE (`project_id`, `grantee_id`),
  INDEX `idx_pipeline_shares_grantee_state` (`grantee_id`, `state`),
  INDEX `idx_pipeline_shares_owner_state` (`owner_id`, `state`)
);

-- ─── (2) lineage ───────────────────────────────────────────────────
-- No foreign keys on these columns on purpose: provenance must outlive the
-- account it names, and a new constraint here would silently change what
-- deleting a user is allowed to do. Integrity is enforced in code
-- (api/services/workflowLineage.ts) at the three publish boundaries, and the
-- two writers that stamp provenance forward are `createVersionFromProject` and
-- the clone path in pipelineSharing.

ALTER TABLE `projects`
  ADD COLUMN `origin_creator_id` int DEFAULT NULL;

ALTER TABLE `pipeline_versions`
  ADD COLUMN `origin_creator_id` int DEFAULT NULL,
  ADD COLUMN `origin_version_id` int DEFAULT NULL;
