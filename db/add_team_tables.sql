-- Add Team & Beta Testing tables (manual migration)
-- Run this if db:push fails on existing tables

CREATE TABLE IF NOT EXISTS `teams` (
  `id` int AUTO_INCREMENT PRIMARY KEY NOT NULL,
  `name` varchar(100) NOT NULL,
  `description` text,
  `owner_id` int NOT NULL,
  `invite_code` varchar(32) UNIQUE,
  `invite_qr_url` text,
  `created_at` timestamp DEFAULT NOW(),
  FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_members` (
  `id` int AUTO_INCREMENT PRIMARY KEY NOT NULL,
  `team_id` int NOT NULL,
  `user_id` int NOT NULL,
  `role` enum('owner','admin','tester','viewer') DEFAULT 'tester' NOT NULL,
  `joined_at` timestamp DEFAULT NOW(),
  `last_active_at` timestamp DEFAULT NOW(),
  `engagement_score` int DEFAULT 0,
  FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  UNIQUE KEY `team_user_unique` (`team_id`, `user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `team_projects` (
  `id` int AUTO_INCREMENT PRIMARY KEY NOT NULL,
  `team_id` int NOT NULL,
  `project_id` int NOT NULL,
  `added_by` int NOT NULL,
  `added_at` timestamp DEFAULT NOW(),
  FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`added_by`) REFERENCES `users`(`id`),
  UNIQUE KEY `team_project_unique` (`team_id`, `project_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `user_privacy_consent` (
  `id` int AUTO_INCREMENT PRIMARY KEY NOT NULL,
  `user_id` int NOT NULL,
  `allow_prompt_storage` boolean DEFAULT true,
  `allow_feedback_storage` boolean DEFAULT true,
  `allow_screenshots` boolean DEFAULT true,
  `allow_conversation_history` boolean DEFAULT false,
  `consented_at` timestamp DEFAULT NOW(),
  `updated_at` timestamp DEFAULT NOW() ON UPDATE NOW(),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  UNIQUE KEY `user_consent_unique` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `feedback` (
  `id` int AUTO_INCREMENT PRIMARY KEY NOT NULL,
  `team_id` int,
  `project_id` int,
  `user_id` int NOT NULL,
  `target_type` enum('message','ui','general') DEFAULT 'general' NOT NULL,
  `target_message_id` int,
  `feedback_type` enum('bug','suggestion','praise','confusion') NOT NULL,
  `severity` enum('critical','major','minor','cosmetic') DEFAULT 'minor',
  `content` text NOT NULL,
  `screenshot_url` text,
  `context_json` json,
  `tags_json` json,
  `status` enum('new','triaged','in_progress','resolved','verified','closed') DEFAULT 'new' NOT NULL,
  `assigned_to` int,
  `converted_to_issue_id` int,
  `created_at` timestamp DEFAULT NOW(),
  `resolved_at` timestamp,
  FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`assigned_to`) REFERENCES `users`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `issues` (
  `id` int AUTO_INCREMENT PRIMARY KEY NOT NULL,
  `team_id` int,
  `project_id` int,
  `title` varchar(255) NOT NULL,
  `description` text,
  `priority` enum('p0','p1','p2','p3') DEFAULT 'p2' NOT NULL,
  `status` enum('open','in_progress','resolved','verified','closed') DEFAULT 'open' NOT NULL,
  `assignee_id` int,
  `related_feedback_ids_json` json,
  `resolution_notes` text,
  `created_by` int NOT NULL,
  `created_at` timestamp DEFAULT NOW(),
  `resolved_at` timestamp,
  FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`assignee_id`) REFERENCES `users`(`id`),
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `fix_verifications` (
  `id` int AUTO_INCREMENT PRIMARY KEY NOT NULL,
  `issue_id` int NOT NULL,
  `user_id` int NOT NULL,
  `status` enum('pending','verified','failed') DEFAULT 'pending' NOT NULL,
  `tester_comment` text,
  `created_at` timestamp DEFAULT NOW(),
  `verified_at` timestamp,
  FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `activity_log` (
  `id` int AUTO_INCREMENT PRIMARY KEY NOT NULL,
  `user_id` int NOT NULL,
  `team_id` int,
  `project_id` int,
  `action` enum('sent_message','gave_feedback','ran_pipeline','imported_project','viewed_dashboard','created_issue','verified_fix') NOT NULL,
  `metadata_json` json,
  `created_at` timestamp DEFAULT NOW(),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `changelog_entries` (
  `id` int AUTO_INCREMENT PRIMARY KEY NOT NULL,
  `team_id` int NOT NULL,
  `title` varchar(255) NOT NULL,
  `description` text,
  `related_issue_ids_json` json,
  `released_at` timestamp DEFAULT NOW(),
  FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
