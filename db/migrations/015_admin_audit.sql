-- 015: persistent admin audit trail (role/tier/flag/SSO mutations)
CREATE TABLE admin_audit_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  admin_user_id INT NULL,
  action VARCHAR(64) NOT NULL,
  target_type VARCHAR(64) NULL,
  target_id VARCHAR(255) NULL,
  detail JSON NULL,
  ip VARCHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_admin_audit_log_created (created_at),
  KEY idx_admin_audit_log_admin (admin_user_id),
  CONSTRAINT fk_admin_audit_admin FOREIGN KEY (admin_user_id) REFERENCES users (id) ON DELETE SET NULL
);
