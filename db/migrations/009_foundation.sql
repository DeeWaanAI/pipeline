-- 009_foundation.sql — Foundation Sprint (F0)
-- Billing, entitlements, usage metering, idempotency, OAuth tokens, voucher
-- redemptions, and the worker rehydration payload on swarm_runs.
-- All additive: no column drops, no data backfills. MySQL 8.

ALTER TABLE swarm_runs ADD COLUMN run_params JSON NULL AFTER execution_state;

CREATE TABLE IF NOT EXISTS subscriptions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  team_id INT NULL,
  plan VARCHAR(50) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  stripe_customer_id VARCHAR(100) NULL,
  stripe_subscription_id VARCHAR(100) NULL UNIQUE,
  seats INT NOT NULL DEFAULT 1,
  current_period_end TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_subscriptions_user_id (user_id),
  KEY idx_subscriptions_team_id (team_id)
);

CREATE TABLE IF NOT EXISTS entitlements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  subject_type ENUM('user', 'team') NOT NULL,
  subject_id INT NOT NULL,
  capability VARCHAR(150) NOT NULL,
  source ENUM('tier', 'subscription', 'voucher', 'purchase', 'manual') NOT NULL,
  source_ref VARCHAR(100) NULL,
  expires_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_entitlements_subject_capability (subject_id, capability)
);

CREATE TABLE IF NOT EXISTS usage_counters (
  id INT AUTO_INCREMENT PRIMARY KEY,
  subject_id INT NOT NULL,
  metric VARCHAR(100) NOT NULL,
  period VARCHAR(6) NOT NULL,
  count INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_usage_counters_subject_metric_period (subject_id, metric, period)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  `key` VARCHAR(100) PRIMARY KEY,
  scope VARCHAR(100) NOT NULL,
  response_hash VARCHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_idempotency_keys_created_at (created_at)
);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  client_id VARCHAR(100) NOT NULL,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  scopes JSON NULL,
  expires_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_oauth_refresh_tokens_user_id (user_id)
);

CREATE TABLE IF NOT EXISTS voucher_redemptions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  voucher_id INT NOT NULL,
  tier VARCHAR(50) NOT NULL,
  expires_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_voucher_redemptions_user_id (user_id),
  KEY idx_voucher_redemptions_voucher_id (voucher_id)
);
