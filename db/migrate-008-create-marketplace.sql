-- Migration 008: Create all marketplace tables
-- Run with: docker exec -i swarm-mysql mysql -u root -prootpass "19e8d514-2462-833e-8000-09db456624ce" < db/migrate-008-create-marketplace.sql

-- Use the correct database
USE `19e8d514-2462-833e-8000-09db456624ce`;

-- ─── MARKETPLACE LISTINGS ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketplace_listings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  creator_id INT NOT NULL,
  template_id INT NOT NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  objectives TEXT COMMENT 'What the pipeline aims to accomplish',
  input_format TEXT COMMENT 'Expected format of user input',
  output_format TEXT COMMENT 'Expected format of pipeline output',
  remarks TEXT COMMENT 'Additional notes for reviewers',
  category ENUM('translation', 'writing', 'code', 'analysis', 'creative', 'other') DEFAULT 'other',
  price DECIMAL(10, 2) NOT NULL,
  is_subscription BOOLEAN DEFAULT FALSE,
  subscription_price DECIMAL(10, 2),
  status ENUM('draft', 'generating', 'pending_review', 'reviewing', 'rejected', 'approved', 'published', 'unpublished') DEFAULT 'draft',
  grade DECIMAL(3, 2),
  review_count INT DEFAULT 0,
  kappa_score DECIMAL(4, 3),
  ai_correlation DECIMAL(4, 3),
  sales_count INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_creator (creator_id),
  INDEX idx_status (status),
  INDEX idx_category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── TEST PROMPTS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS test_prompts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  listing_id INT NOT NULL,
  prompt_index INT NOT NULL,
  category ENUM('simple', 'medium', 'complex', 'edge', 'adversarial') NOT NULL,
  input_text TEXT NOT NULL,
  actual_output TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_listing (listing_id),
  INDEX idx_prompt_index (listing_id, prompt_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── TEST PROMPT INTERMEDIATE RESPONSES ──────────────────────────
CREATE TABLE IF NOT EXISTS test_prompt_intermediate (
  id INT AUTO_INCREMENT PRIMARY KEY,
  test_prompt_id INT NOT NULL,
  step_index INT NOT NULL,
  step_name VARCHAR(100) NOT NULL,
  step_role VARCHAR(50),
  input_text TEXT NOT NULL,
  output_text TEXT NOT NULL,
  tokens_used INT,
  latency_ms INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_test_prompt (test_prompt_id),
  INDEX idx_step (step_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── LISTING REVIEWS ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS listing_reviews (
  id INT AUTO_INCREMENT PRIMARY KEY,
  listing_id INT NOT NULL,
  reviewer_id INT NOT NULL,
  prompt_index INT NOT NULL,
  accuracy INT NOT NULL,
  completeness INT NOT NULL,
  clarity INT NOT NULL,
  token_efficiency INT NOT NULL,
  speed INT NOT NULL,
  consistency INT NOT NULL,
  weighted_score DECIMAL(4, 2) NOT NULL,
  review_time INT NOT NULL COMMENT 'seconds spent',
  flagged BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_listing (listing_id),
  INDEX idx_reviewer (reviewer_id),
  INDEX idx_listing_prompt (listing_id, prompt_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── AI ENSEMBLE REVIEWS ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_ensemble_reviews (
  id INT AUTO_INCREMENT PRIMARY KEY,
  listing_id INT NOT NULL,
  prompt_index INT NOT NULL,
  model_type ENUM('small', 'medium', 'large', 'rule_based') NOT NULL,
  accuracy INT,
  completeness INT,
  clarity INT,
  token_efficiency INT,
  speed INT,
  consistency INT,
  weighted_score DECIMAL(4, 2),
  raw_response TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_listing (listing_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── REVIEWER PROFILES ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reviewer_profiles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL UNIQUE,
  trust_score INT DEFAULT 100,
  reviews_completed INT DEFAULT 0,
  reviews_flagged INT DEFAULT 0,
  arbiter_rulings_against INT DEFAULT 0,
  points_earned INT DEFAULT 0,
  points_balance INT DEFAULT 0,
  subscription_days INT DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  status ENUM('active', 'suspended', 'banned') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── REVIEW ASSIGNMENTS ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS review_assignments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  listing_id INT NOT NULL,
  reviewer_id INT NOT NULL,
  status ENUM('pending', 'in_progress', 'completed', 'overdue') DEFAULT 'pending',
  assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  due_at TIMESTAMP,
  completed_at TIMESTAMP,
  INDEX idx_listing (listing_id),
  INDEX idx_reviewer (reviewer_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── CREATOR DEPOSITS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS creator_deposits (
  id INT AUTO_INCREMENT PRIMARY KEY,
  creator_id INT NOT NULL,
  listing_id INT NOT NULL,
  deposit_type ENUM('ai_test', 'human_review') NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  tokens_used INT,
  status ENUM('pending', 'completed', 'refunded', 'partial_refund') DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP,
  INDEX idx_creator (creator_id),
  INDEX idx_listing (listing_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── REFUND LEDGER ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refund_ledger (
  id INT AUTO_INCREMENT PRIMARY KEY,
  creator_id INT NOT NULL,
  listing_id INT NOT NULL,
  deposit_id INT NOT NULL,
  sale_id INT NOT NULL,
  commission_earned DECIMAL(10, 2) NOT NULL,
  amount_refunded DECIMAL(10, 2) NOT NULL,
  is_fully_refunded BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_creator (creator_id),
  INDEX idx_listing (listing_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── MARKETPLACE PURCHASES ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketplace_purchases (
  id INT AUTO_INCREMENT PRIMARY KEY,
  buyer_id INT NOT NULL,
  listing_id INT NOT NULL,
  amount_paid DECIMAL(10, 2) NOT NULL,
  platform_fee DECIMAL(10, 2) NOT NULL,
  creator_earnings DECIMAL(10, 2) NOT NULL,
  is_subscription BOOLEAN DEFAULT FALSE,
  subscription_end TIMESTAMP,
  status ENUM('active', 'refunded', 'cancelled') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_buyer (buyer_id),
  INDEX idx_listing (listing_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── ENCRYPTED PROMPTS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS encrypted_prompts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  listing_id INT NOT NULL,
  agent_index INT NOT NULL,
  encrypted_prompt TEXT NOT NULL,
  iv VARCHAR(64) NOT NULL,
  version INT DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_listing (listing_id),
  UNIQUE KEY unique_listing_agent (listing_id, agent_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── AI ENSEMBLE REVIEWS ───────────────────────────────────────────
-- (already created above as ai_ensemble_reviews)

-- Verify tables were created
SHOW TABLES LIKE '%marketplace%';
SHOW TABLES LIKE 'test_prompt%';
SHOW TABLES LIKE 'listing_review%';
SHOW TABLES LIKE 'reviewer%';
SHOW TABLES LIKE 'review_assignment%';
SHOW TABLES LIKE 'encrypted_prompt%';
