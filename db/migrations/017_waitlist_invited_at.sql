-- 017: add invited_at to waitlist_entries for beta command center
ALTER TABLE waitlist_entries
  ADD COLUMN invited_at TIMESTAMP NULL DEFAULT NULL,
  ADD KEY idx_waitlist_invited_at (invited_at);
