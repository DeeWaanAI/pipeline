-- 016: Pioneer 100 waitlist (marketing site /api/waitlist contract)
CREATE TABLE waitlist_entries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(320) NOT NULL,
  role ENUM('creator', 'user', 'both') NOT NULL,
  ref VARCHAR(64) NULL,
  referral_code VARCHAR(32) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_waitlist_email (email),
  UNIQUE KEY uq_waitlist_referral_code (referral_code)
);
