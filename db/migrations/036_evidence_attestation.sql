-- 036 — Evidence attestation (v3: provenance, not just integrity)
--
-- WHAT THIS IS. Three nullable columns on `evidence_publications` recording that a
-- published evidence manifest was signed by a platform Ed25519 key: the signature,
-- the id of the key that produced it, and when it was signed. The signature also
-- lives inside `public_manifest` — that embedded copy is the one a reader verifies
-- offline, with no server — so these columns exist for the operational question the
-- manifest cannot answer cheaply: "is there published evidence here that is NOT
-- signed by the key we trust?" A revocation or re-issue sweep needs a WHERE clause,
-- not a JSON parse.
--
-- ADDITIVE ONLY. Nothing is dropped, renamed, re-typed or written. Existing
-- publications keep their meaning and read as unsigned, which is the truth — nobody
-- signed them.
--
-- WHY NULLABLE, AND WHY `DEFAULT NULL` IS WRITTEN OUT. No signing key exists in any
-- .env today, by owner policy, so a published record must not depend on a secret in
-- order to exist. And MySQL's legacy `explicit_defaults_for_timestamp=OFF` would give
-- the first bare TIMESTAMP column `DEFAULT CURRENT_TIMESTAMP ON UPDATE
-- CURRENT_TIMESTAMP` — which would silently rewrite a signature timestamp on any
-- unrelated row update. Writing NULL DEFAULT NULL forecloses that, same defect class
-- as the AUTO_INCREMENT-without-key migrations already caught twice here.

ALTER TABLE `evidence_publications`
  ADD COLUMN `signature` TEXT NULL AFTER `manifest_hash`;

ALTER TABLE `evidence_publications`
  ADD COLUMN `signing_key_id` VARCHAR(64) NULL AFTER `signature`;

ALTER TABLE `evidence_publications`
  ADD COLUMN `signed_at` TIMESTAMP NULL DEFAULT NULL AFTER `signing_key_id`;
