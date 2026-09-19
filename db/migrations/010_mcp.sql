-- 010_mcp.sql — Companion MCP Server (F0)
-- OAuth 2.1 dynamic clients, authorization codes (PKCE, SHA-256 hashed),
-- and the MCP tool-call audit log.
-- All additive: no column drops, no data backfills. MySQL 8.

CREATE TABLE IF NOT EXISTS oauth_clients (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_id VARCHAR(100) NOT NULL UNIQUE,
  client_name VARCHAR(200) NULL,
  redirect_uris JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS oauth_auth_codes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code_hash VARCHAR(128) NOT NULL UNIQUE,
  client_id VARCHAR(100) NOT NULL,
  user_id INT NOT NULL,
  redirect_uri TEXT NULL,
  code_challenge VARCHAR(128) NULL,
  code_challenge_method VARCHAR(10) NULL,
  scopes JSON NULL,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_oauth_auth_codes_client_id (client_id)
);

CREATE TABLE IF NOT EXISTS mcp_audit_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  client_id VARCHAR(100) NOT NULL,
  tool_name VARCHAR(100) NOT NULL,
  latency_ms INT NOT NULL,
  status VARCHAR(20) NOT NULL,
  error TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_mcp_audit_log_user_id (user_id),
  KEY idx_mcp_audit_log_created_at (created_at)
);
