-- 028 — Offering redesign v2 / P3+: the ledger must price ACTUALS with the same
-- rates the QUOTE was built from (spec §9).
--
-- Proven by the first live-key run (2026-09-21): `buildQuote` resolves rates from
-- the provider that will serve the call, but `benchmarkLedger` priced every row
-- through the env-only price vector. Result: the user was quoted a dollar figure
-- and the benchmark reported `cost_completeness = partial` with NULL cost, so
-- quote-vs-actual — the one number the spend-approval flow exists to make
-- checkable — could not be computed at all.
--
-- Both columns are additive and nullable; no existing row is reinterpreted. A
-- rate alone is not an honest cost claim, so each priced row records WHERE the
-- number came from (`cost_basis`) and WHEN the provider figures were retrieved
-- (`cost_pricing_as_of`) — a live list price is a momentary fact. Rows with
-- `cost_basis IS NULL` mean "we could not price this", which is the same
-- statement as `cost_completeness = unknown` and never implies zero.

ALTER TABLE `call_attempts`
  ADD COLUMN `cost_basis` varchar(16) DEFAULT NULL AFTER `price_vector_version`,
  ADD COLUMN `cost_pricing_as_of` timestamp NULL DEFAULT NULL AFTER `cost_basis`;
