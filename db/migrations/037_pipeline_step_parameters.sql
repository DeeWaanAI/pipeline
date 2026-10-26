-- 037 — free-form provider parameters per pipeline step
--
-- WHAT THIS IS. One nullable JSON column on `pipeline_steps` holding whatever
-- request-body fields the chosen model accepts: { enable_thinking: false },
-- { reasoning_effort: "high" }, { top_p: 0.9 } — passed to the provider as given.
--
-- WHY FREE-FORM AND NOT A TYPED ALLOWLIST. Model parameters differ per provider
-- and change faster than a schema can follow; a curated list becomes a stale gate
-- that rejects a valid request or, worse, silently drops one. The user chooses the
-- model, so the user chooses the parameters it accepts. A provider that rejects an
-- unknown field says so, and the run fails with the provider's own message.
--
-- ADDITIVE ONLY. Nullable, no default, no backfill: existing steps keep meaning
-- exactly what they meant before (no extra body fields).

ALTER TABLE `pipeline_steps`
  ADD COLUMN `parameters` JSON NULL AFTER `max_tokens`;
