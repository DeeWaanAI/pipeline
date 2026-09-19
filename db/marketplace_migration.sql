-- Marketplace Module Migration
-- Run this directly in MySQL to bypass drizzle-kit auto-generated long FK names

CREATE DATABASE IF NOT EXISTS swarm_db;
USE swarm_db;

-- Marketplace Listings
CREATE TABLE IF NOT EXISTS marketplace_listings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  creator_id INT NOT NULL,
  pipeline_template_id INT NOT NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  category ENUM('translation','writing','code','analysis','creative','other') DEFAULT 'other',
  price DECIMAL(10,2) NOT NULL,
  is_subscription BOOLEAN DEFAULT FALSE,
  subscription_price DECIMAL(10,2),
  status ENUM('draft','pending_review','reviewing','rejected','approved','published','unpublished') DEFAULT 'draft',
  grade DECIMAL(3,2),
  review_count INT DEFAULT 0,
  kappa_score DECIMAL(4,3),
  ai_correlation DECIMAL(4,3),
  sales_count INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT mp_listings_creator_fk FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT mp_listings_tpl_fk FOREIGN KEY (pipeline_template_id) REFERENCES pipeline_templates(id) ON DELETE CASCADE
);

-- Test Prompts
CREATE TABLE IF NOT EXISTS test_prompts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  listing_id INT NOT NULL,
  prompt_index INT NOT NULL,
  category ENUM('simple','medium','complex','edge','adversarial') NOT NULL,
  input_text TEXT NOT NULL,
  expected_output TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT test_prompts_listing_fk FOREIGN KEY (listing_id) REFERENCES marketplace_listings(id) ON DELETE CASCADE
);

-- Listing Reviews (human reviews)
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
  weighted_score DECIMAL(4,2) NOT NULL,
  review_time INT NOT NULL,
  flagged BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT reviews_listing_fk FOREIGN KEY (listing_id) REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  CONSTRAINT reviews_reviewer_fk FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE CASCADE
);

-- AI Ensemble Reviews
CREATE TABLE IF NOT EXISTS ai_ensemble_reviews (
  id INT AUTO_INCREMENT PRIMARY KEY,
  listing_id INT NOT NULL,
  prompt_index INT NOT NULL,
  model_type ENUM('small','medium','large','rule_based') NOT NULL,
  accuracy INT,
  completeness INT,
  clarity INT,
  token_efficiency INT,
  speed INT,
  consistency INT,
  weighted_score DECIMAL(4,2),
  raw_response TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ai_rev_listing_fk FOREIGN KEY (listing_id) REFERENCES marketplace_listings(id) ON DELETE CASCADE
);

-- Reviewer Profiles
CREATE TABLE IF NOT EXISTS reviewer_profiles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL UNIQUE,
  trust_score INT DEFAULT 100,
  reviews_completed INT DEFAULT 0,
  reviews_flagged INT DEFAULT 0,
  arbiter_rulings_against INT DEFAULT 0,
  sage_days_earned INT DEFAULT 0,
  sage_days_used INT DEFAULT 0,
  sage_days_balance INT DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  status ENUM('active','suspended','banned') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT reviewer_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Review Assignments
CREATE TABLE IF NOT EXISTS review_assignments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  listing_id INT NOT NULL,
  reviewer_id INT NOT NULL,
  status ENUM('pending','in_progress','completed','overdue') DEFAULT 'pending',
  assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  due_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL,
  CONSTRAINT assign_listing_fk FOREIGN KEY (listing_id) REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  CONSTRAINT assign_reviewer_fk FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Creator Deposits
CREATE TABLE IF NOT EXISTS creator_deposits (
  id INT AUTO_INCREMENT PRIMARY KEY,
  creator_id INT NOT NULL,
  listing_id INT NOT NULL,
  deposit_type ENUM('ai_test','human_review') NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  tokens_used INT,
  status ENUM('pending','completed','refunded','partial_refund') DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NULL,
  CONSTRAINT deposit_creator_fk FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT deposit_listing_fk FOREIGN KEY (listing_id) REFERENCES marketplace_listings(id) ON DELETE CASCADE
);

-- Refund Ledger
CREATE TABLE IF NOT EXISTS refund_ledger (
  id INT AUTO_INCREMENT PRIMARY KEY,
  creator_id INT NOT NULL,
  listing_id INT NOT NULL,
  deposit_id INT NOT NULL,
  sale_id INT NOT NULL,
  commission_earned DECIMAL(10,2) NOT NULL,
  amount_refunded DECIMAL(10,2) NOT NULL,
  is_fully_refunded BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT refund_creator_fk FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT refund_listing_fk FOREIGN KEY (listing_id) REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  CONSTRAINT refund_deposit_fk FOREIGN KEY (deposit_id) REFERENCES creator_deposits(id) ON DELETE CASCADE
);

-- Marketplace Purchases
CREATE TABLE IF NOT EXISTS marketplace_purchases (
  id INT AUTO_INCREMENT PRIMARY KEY,
  buyer_id INT NOT NULL,
  listing_id INT NOT NULL,
  amount_paid DECIMAL(10,2) NOT NULL,
  platform_fee DECIMAL(10,2) NOT NULL,
  creator_earnings DECIMAL(10,2) NOT NULL,
  is_subscription BOOLEAN DEFAULT FALSE,
  subscription_end TIMESTAMP NULL,
  status ENUM('active','refunded','cancelled') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT purchase_buyer_fk FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT purchase_listing_fk FOREIGN KEY (listing_id) REFERENCES marketplace_listings(id) ON DELETE CASCADE
);

-- Encrypted Prompts
CREATE TABLE IF NOT EXISTS encrypted_prompts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  listing_id INT NOT NULL,
  agent_index INT NOT NULL,
  encrypted_prompt TEXT NOT NULL,
  iv VARCHAR(64) NOT NULL,
  version INT DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT encprompt_listing_fk FOREIGN KEY (listing_id) REFERENCES marketplace_listings(id) ON DELETE CASCADE
);
