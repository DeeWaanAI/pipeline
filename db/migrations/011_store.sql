-- 011_store.sql — Certified Cross-App Store (Phase 1)
-- Stripe references on marketplace purchases so the webhook can fulfill
-- (checkout.session.completed) and revoke (charge.refunded) purchases.
-- All additive: no column drops, no backfills. MySQL 8. Run once.

ALTER TABLE marketplace_purchases
  ADD COLUMN stripe_session_id VARCHAR(100) NULL,
  ADD COLUMN stripe_payment_intent_id VARCHAR(100) NULL,
  ADD INDEX idx_mp_purchases_session (stripe_session_id),
  ADD INDEX idx_mp_purchases_pi (stripe_payment_intent_id);
