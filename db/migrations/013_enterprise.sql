-- 013_enterprise.sql — Enterprise (Phase 3)
-- SSO connections (OIDC + SAML), on-prem relay registrations, and the
-- cloud-side relay request queue for outbound-only on-prem connectors.
-- All additive: no column drops, no data backfills. MySQL 8.

-- SSO connections: one row per customer IdP / email domain.
-- OIDC secrets are stored AES-256-GCM encrypted (cryptoService format).
CREATE TABLE IF NOT EXISTS sso_connections (
  id INT AUTO_INCREMENT PRIMARY KEY,
  type ENUM('oidc', 'saml') NOT NULL,
  domain VARCHAR(255) NOT NULL UNIQUE,
  display_name VARCHAR(255) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  oidc_issuer VARCHAR(512) NULL,
  oidc_client_id VARCHAR(255) NULL,
  oidc_client_secret_enc TEXT NULL,
  oidc_scopes VARCHAR(255) NOT NULL DEFAULT 'openid email profile',
  saml_entry_point VARCHAR(512) NULL,
  saml_issuer VARCHAR(512) NULL,
  saml_cert TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- On-prem relay registrations: each relay authenticates with a bearer
-- token stored SHA-256 hashed (never the raw token).
CREATE TABLE IF NOT EXISTS relay_registrations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  owner_user_id INT NOT NULL,
  status ENUM('active', 'revoked') NOT NULL DEFAULT 'active',
  last_seen_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_relay_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- Cloud-side queue for outbound-only relays: cloud enqueues work, the
-- on-prem connector polls, executes locally, and posts the result back.
CREATE TABLE IF NOT EXISTS relay_requests (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  relay_id INT NOT NULL,
  kind VARCHAR(50) NOT NULL,
  payload_json JSON NOT NULL,
  status ENUM('pending', 'claimed', 'completed', 'failed') NOT NULL DEFAULT 'pending',
  result_json JSON NULL,
  error TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL,
  CONSTRAINT fk_relay_req_relay FOREIGN KEY (relay_id) REFERENCES relay_registrations (id) ON DELETE CASCADE,
  KEY idx_relay_req_status (relay_id, status)
);
