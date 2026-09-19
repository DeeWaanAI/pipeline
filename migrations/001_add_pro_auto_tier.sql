-- Add 'pro_auto' to the tier enum on users table
-- Run this in your MySQL client (or use the migrate script)

ALTER TABLE users MODIFY COLUMN tier ENUM('standard', 'pro_designer', 'pro_auto') NOT NULL DEFAULT 'standard';
