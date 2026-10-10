-- Owner-declared model prices (ticket #61).
--
-- WHAT THIS FIXES. A cost is a fact only when a rate could be resolved for the
-- exact (provider, model) the call ran on. Two real cases had no answer at all:
-- a host whose pricing endpoint we cannot read, and a model run LOCALLY
-- (Ollama/LM Studio and friends), which has no per-token price list anywhere.
-- Both used to end up permanently UNKNOWN. This table lets the account that
-- owns the provider state the number — per 1M input and per 1M output tokens,
-- the unit the provider's own console uses — including a real 0.00 for a local
-- model, which is a stated fact rather than a missing measurement.
--
-- WHERE IT SITS IN THE ORDER. api/services/benchmark/modelPricing.ts resolves
-- live provider list -> platform price vector -> THIS table. A declaration is
-- last on purpose: it never overrides a number the host publishes, so a typo in
-- one entry cannot silently rewrite what the platform already knows. It only
-- turns "unknown" into a figure, and it is always disclosed under its own basis
-- ("declared"), never as `provider_list` or `price_vector`.
--
-- ADDITIVE ONLY. One CREATE TABLE. Nothing drops, renames, narrows or alters an
-- existing table or column, and no existing row is read or rewritten.
--
-- WHY `provider_ref_id` IS THE KEY. Prices are per credential, not per model
-- name: the same model id served by two accounts or two hosts can cost
-- differently, and `llm_providers` rows are already per account. Owner checks
-- live in code (the tRPC procedures load the provider by id AND userId), not in
-- DDL, matching every other table here. No plan or tier gate is introduced —
-- the paid-tier ladder and the team feature were deleted (ticket #26, owner
-- decisions 2026-09-22).

CREATE TABLE IF NOT EXISTS `declared_model_prices` (
  `id` int NOT NULL AUTO_INCREMENT,
  `provider_ref_id` int NOT NULL,
  -- Exact model id, matched the same way every other rate lookup matches it:
  -- trimmed, then case-insensitive. Never fuzzy, so a declaration for one
  -- model cannot be silently applied to a similarly named sibling.
  `model_id` varchar(191) NOT NULL,
  -- USD per 1,000,000 tokens. A decimal, so 0 is storable and is genuinely
  -- zero rather than absent; NULL is not allowed because "absent" is what
  -- UNKNOWN already means and this table exists to remove that state.
  `input_usd_per_million` decimal(18, 8) NOT NULL,
  `output_usd_per_million` decimal(18, 8) NOT NULL,
  `created_by` int DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_declared_price_provider_model` (`provider_ref_id`, `model_id`),
  CONSTRAINT `fk_declared_price_provider` FOREIGN KEY (`provider_ref_id`)
    REFERENCES `llm_providers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_declared_price_author` FOREIGN KEY (`created_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL
);
