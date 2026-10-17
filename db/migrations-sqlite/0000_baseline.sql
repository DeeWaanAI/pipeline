CREATE TABLE `activity_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`team_id` integer,
	`project_id` integer,
	`action` text NOT NULL,
	`metadata_json` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_activity_log_user_id` ON `activity_log` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_activity_log_team_id` ON `activity_log` (`team_id`);--> statement-breakpoint
CREATE TABLE `admin_audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`admin_user_id` integer,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`detail` text,
	`ip` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`admin_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_admin_audit_log_created` ON `admin_audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_admin_audit_log_admin` ON `admin_audit_log` (`admin_user_id`);--> statement-breakpoint
CREATE TABLE `agent_responses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_run_id` integer NOT NULL,
	`swarm_run_id` integer NOT NULL,
	`project_id` integer NOT NULL,
	`parent_response_id` integer,
	`response_type` text NOT NULL,
	`content` text NOT NULL,
	`metadata` text NOT NULL,
	`human_reviewed` integer DEFAULT false,
	`human_notes` text,
	`is_flagged` integer DEFAULT false,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`swarm_run_id`) REFERENCES `swarm_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_agent_responses_swarm_run_id` ON `agent_responses` (`swarm_run_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_responses_agent_run_id` ON `agent_responses` (`agent_run_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_responses_project_id` ON `agent_responses` (`project_id`);--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`swarm_run_id` integer NOT NULL,
	`agent_id` integer,
	`project_id` integer NOT NULL,
	`agent_name` text NOT NULL,
	`agent_role` text NOT NULL,
	`pipeline_step` integer NOT NULL,
	`iteration` integer DEFAULT 1,
	`system_prompt` text,
	`user_prompt` text NOT NULL,
	`context_input` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`tokens_used` integer,
	`latency_ms` integer,
	`model_used` text,
	`provider_used` text,
	`started_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`completed_at` integer,
	FOREIGN KEY (`swarm_run_id`) REFERENCES `swarm_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_agent_runs_swarm_run_id` ON `agent_runs` (`swarm_run_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_runs_project_id` ON `agent_runs` (`project_id`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`role` text NOT NULL,
	`system_prompt` text NOT NULL,
	`provider_id` integer,
	`model` text,
	`temperature` text DEFAULT '0.7',
	`max_tokens` integer DEFAULT 4096,
	`pipeline_order` integer DEFAULT 0,
	`max_iterations` integer DEFAULT 1,
	`is_enabled` integer DEFAULT true,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `llm_providers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `ai_ensemble_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`listing_id` integer NOT NULL,
	`prompt_index` integer NOT NULL,
	`provider_id` integer,
	`model_slug` text,
	`accuracy` integer,
	`completeness` integer,
	`clarity` integer,
	`token_efficiency` integer,
	`speed` integer,
	`consistency` integer,
	`weighted_score` text,
	`raw_response` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`listing_id`) REFERENCES `marketplace_listings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `llm_providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `api_key_store` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`provider_slug` text NOT NULL,
	`encrypted_key` text NOT NULL,
	`salt` text NOT NULL,
	`iterations` integer DEFAULT 480000,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `approval_assignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`swarm_run_id` integer NOT NULL,
	`assignee_user_id` integer NOT NULL,
	`assigned_by` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`swarm_run_id`) REFERENCES `swarm_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignee_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assigned_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_approval_assign_assignee` ON `approval_assignments` (`assignee_user_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_approval_assign_run` ON `approval_assignments` (`swarm_run_id`);--> statement-breakpoint
CREATE TABLE `benchmark_candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`benchmark_id` integer NOT NULL,
	`stable_candidate_id` text NOT NULL,
	`strategy` text NOT NULL,
	`workflow_version_id` integer,
	`imported_response_id` integer,
	`baseline_prompt` text,
	`baseline_prompt_version` text,
	`requested_provider_id` integer,
	`requested_model` text,
	`step_resolution_policy` text,
	`decoding_snapshot` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`benchmark_id`) REFERENCES `benchmarks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_version_id`) REFERENCES `pipeline_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`imported_response_id`) REFERENCES `agent_responses`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_benchmark_candidates_benchmark_candidate` ON `benchmark_candidates` (`benchmark_id`,`stable_candidate_id`);--> statement-breakpoint
CREATE TABLE `benchmark_cases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`benchmark_id` integer NOT NULL,
	`stable_case_id` text NOT NULL,
	`case_order` integer NOT NULL,
	`input_text` text,
	`input_artifact_ref` text,
	`origin` text DEFAULT 'user' NOT NULL,
	`base_case_id` text,
	`expected_output` text,
	`content_hash` text NOT NULL,
	`provenance_notes` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`benchmark_id`) REFERENCES `benchmarks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_benchmark_cases_benchmark_case` ON `benchmark_cases` (`benchmark_id`,`stable_case_id`);--> statement-breakpoint
CREATE TABLE `benchmark_judgments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`benchmark_id` integer NOT NULL,
	`run_id` integer,
	`run_a_id` integer,
	`run_b_id` integer,
	`judge_slot` integer NOT NULL,
	`rubric_version_ref` text NOT NULL,
	`judge_prompt_version` text NOT NULL,
	`judge_model` text NOT NULL,
	`judge_provider_route` text,
	`judge_revision` text,
	`orientation` text,
	`kind` text DEFAULT 'rubric' NOT NULL,
	`dimension_scores` text,
	`raw_aggregate` text,
	`normalized_aggregate` text,
	`pair_preference` text,
	`rationale` text,
	`raw_response_ref` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`validation_notes` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`benchmark_id`) REFERENCES `benchmarks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `benchmark_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_a_id`) REFERENCES `benchmark_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_b_id`) REFERENCES `benchmark_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_benchmark_judgments_run_judge_orientation` ON `benchmark_judgments` (`run_id`,`judge_slot`,`orientation`,`judge_prompt_version`);--> statement-breakpoint
CREATE INDEX `idx_benchmark_judgments_benchmark` ON `benchmark_judgments` (`benchmark_id`,`status`);--> statement-breakpoint
CREATE TABLE `benchmark_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`benchmark_id` integer NOT NULL,
	`case_id` integer NOT NULL,
	`candidate_id` integer NOT NULL,
	`replication_index` integer DEFAULT 1 NOT NULL,
	`logical_execution_id` text NOT NULL,
	`linked_swarm_run_id` integer,
	`imported_provenance` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`output_text` text,
	`output_hash` text,
	`executor_metadata` text,
	`started_at` integer,
	`finished_at` integer,
	`usage_summary` text,
	`error_summary` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`benchmark_id`) REFERENCES `benchmarks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`case_id`) REFERENCES `benchmark_cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`candidate_id`) REFERENCES `benchmark_candidates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`linked_swarm_run_id`) REFERENCES `swarm_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_benchmark_runs_logical_execution` ON `benchmark_runs` (`logical_execution_id`);--> statement-breakpoint
CREATE INDEX `idx_benchmark_runs_benchmark` ON `benchmark_runs` (`benchmark_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_benchmark_runs_case_candidate_replication` ON `benchmark_runs` (`case_id`,`candidate_id`,`replication_index`);--> statement-breakpoint
CREATE TABLE `benchmarks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer NOT NULL,
	`listing_id` integer,
	`pipeline_version_id` integer,
	`execution_mode` text NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`plan` text,
	`plan_hash` text,
	`rubric_ref` text,
	`judge_config_ref` text,
	`spend_approval_id` integer,
	`state` text DEFAULT 'draft' NOT NULL,
	`aggregate_availability` text DEFAULT 'none' NOT NULL,
	`lease_token` text,
	`lease_expires_at` integer,
	`cancel_requested_at` integer,
	`source_project_id` integer,
	`idempotency_key` text,
	`cost_currency` text DEFAULT 'USD',
	`total_estimated_cost` text,
	`total_observed_cost` text,
	`cost_completeness` text DEFAULT 'unknown',
	`summary` text,
	`summary_computed_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`listing_id`) REFERENCES `marketplace_listings`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`pipeline_version_id`) REFERENCES `pipeline_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`spend_approval_id`) REFERENCES `spend_approvals`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_benchmarks_owner_state` ON `benchmarks` (`owner_id`,`state`);--> statement-breakpoint
CREATE INDEX `idx_benchmarks_pipeline_version` ON `benchmarks` (`pipeline_version_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_benchmarks_owner_idempotency` ON `benchmarks` (`owner_id`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `blind_review_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`listing_id` integer NOT NULL,
	`prompt_index` integer NOT NULL,
	`reviewer_id` integer,
	`status` text DEFAULT 'pooled',
	`assigned_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`listing_id`) REFERENCES `marketplace_listings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_blind_review_tasks_listing_prompt_reviewer` ON `blind_review_tasks` (`listing_id`,`prompt_index`,`reviewer_id`);--> statement-breakpoint
CREATE INDEX `idx_blind_review_tasks_pool` ON `blind_review_tasks` (`status`,`listing_id`);--> statement-breakpoint
CREATE TABLE `call_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`operation_kind` text NOT NULL,
	`operation_id` integer NOT NULL,
	`benchmark_id` integer,
	`purpose` text NOT NULL,
	`actor_id` integer NOT NULL,
	`payer_id` integer NOT NULL,
	`provider_ref_id` integer,
	`requested_model` text NOT NULL,
	`returned_model` text,
	`provider_request_id` text,
	`attempt_index` integer NOT NULL,
	`outcome` text NOT NULL,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`cached_tokens` integer,
	`price_vector_version` text,
	`cost_basis` text,
	`cost_pricing_as_of` integer,
	`estimated_cost_usd` text,
	`cost_completeness` text DEFAULT 'unknown' NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`latency_ms` integer,
	`error_message` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`benchmark_id`) REFERENCES `benchmarks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`payer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_call_attempts_operation_attempt` ON `call_attempts` (`operation_kind`,`operation_id`,`attempt_index`);--> statement-breakpoint
CREATE INDEX `idx_call_attempts_benchmark` ON `call_attempts` (`benchmark_id`);--> statement-breakpoint
CREATE INDEX `idx_call_attempts_payer_created` ON `call_attempts` (`payer_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `changelog_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`team_id` integer NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`related_issue_ids_json` text,
	`released_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `creator_deposits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`creator_id` integer NOT NULL,
	`listing_id` integer NOT NULL,
	`deposit_type` text NOT NULL,
	`amount` text NOT NULL,
	`tokens_used` integer,
	`status` text DEFAULT 'pending',
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`completed_at` integer,
	FOREIGN KEY (`creator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`listing_id`) REFERENCES `marketplace_listings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `custom_agents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`role` text NOT NULL,
	`system_prompt` text NOT NULL,
	`default_provider_id` integer,
	`default_model` text,
	`temperature` text DEFAULT '0.7',
	`max_tokens` integer DEFAULT 4096,
	`description` text,
	`is_template` integer DEFAULT false,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`default_provider_id`) REFERENCES `llm_providers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_custom_agents_user_id` ON `custom_agents` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_custom_agents_slug` ON `custom_agents` (`user_id`,`slug`);--> statement-breakpoint
CREATE TABLE `debug_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`swarm_run_id` integer NOT NULL,
	`agent_run_id` integer,
	`project_id` integer NOT NULL,
	`prompt_id` text NOT NULL,
	`agent_name` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`timestamp` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`swarm_run_id`) REFERENCES `swarm_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_debug_logs_swarm_run_id` ON `debug_logs` (`swarm_run_id`);--> statement-breakpoint
CREATE INDEX `idx_debug_logs_project_id` ON `debug_logs` (`project_id`);--> statement-breakpoint
CREATE TABLE `declared_model_prices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_ref_id` integer NOT NULL,
	`model_id` text NOT NULL,
	`input_usd_per_million` text NOT NULL,
	`output_usd_per_million` text NOT NULL,
	`created_by` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`provider_ref_id`) REFERENCES `llm_providers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_declared_price_provider_model` ON `declared_model_prices` (`provider_ref_id`,`model_id`);--> statement-breakpoint
CREATE TABLE `design_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_id` integer NOT NULL,
	`project_id` integer NOT NULL,
	`designer_provider_id` integer,
	`designer_model` text,
	`designer_prompt_version` text,
	`objective` text NOT NULL,
	`spend_approval_id` integer,
	`state` text DEFAULT 'queued' NOT NULL,
	`cancel_requested_at` integer,
	`candidate_version_id` integer,
	`candidate_definition` text,
	`candidate_definition_hash` text,
	`apply_state` text DEFAULT 'not_applied' NOT NULL,
	`expected_revision` integer NOT NULL,
	`base_step_hash` text,
	`provider_call_attempts` text,
	`lease_token` text,
	`lease_expires_at` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`idempotency_key` text,
	`error_code` text,
	`error_message` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`designer_provider_id`) REFERENCES `llm_providers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_design_jobs_actor_idempotency` ON `design_jobs` (`actor_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_design_jobs_state` ON `design_jobs` (`state`);--> statement-breakpoint
CREATE INDEX `idx_design_jobs_project` ON `design_jobs` (`project_id`);--> statement-breakpoint
CREATE TABLE `encrypted_prompts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`listing_id` integer NOT NULL,
	`agent_index` integer NOT NULL,
	`encrypted_prompt` text NOT NULL,
	`iv` text NOT NULL,
	`version` integer DEFAULT 1,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`listing_id`) REFERENCES `marketplace_listings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `entitlements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` integer NOT NULL,
	`capability` text NOT NULL,
	`source` text NOT NULL,
	`source_ref` text,
	`expires_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_entitlements_subject_capability` ON `entitlements` (`subject_id`,`capability`);--> statement-breakpoint
CREATE TABLE `evidence_publications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`author_id` integer NOT NULL,
	`benchmark_id` integer,
	`external_report_id` integer,
	`listing_id` integer,
	`listing_workflow_version_id` integer,
	`publication_kind` text NOT NULL,
	`provenance` text NOT NULL,
	`public_manifest` text NOT NULL,
	`manifest_hash` text NOT NULL,
	`signature` text,
	`signing_key_id` text,
	`signed_at` integer,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`consent_version` text NOT NULL,
	`state` text DEFAULT 'draft_preview' NOT NULL,
	`supersedes_publication_id` integer,
	`tested_at` integer NOT NULL,
	`published_at` integer,
	`withdrawn_at` integer,
	`withdrawal_reason` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`benchmark_id`) REFERENCES `benchmarks`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`listing_id`) REFERENCES `marketplace_listings`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`listing_workflow_version_id`) REFERENCES `pipeline_versions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_evidence_publications_listing_state` ON `evidence_publications` (`listing_id`,`state`);--> statement-breakpoint
CREATE INDEX `idx_evidence_publications_author` ON `evidence_publications` (`author_id`);--> statement-breakpoint
CREATE TABLE `evidence_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`reporter_id` integer NOT NULL,
	`target_publication_id` integer,
	`target_listing_id` integer,
	`reason` text NOT NULL,
	`supporting_ref` text,
	`assessment_status` text DEFAULT 'open' NOT NULL,
	`seller_reply` text,
	`seller_replied_at` integer,
	`assessed_by` integer,
	`assessed_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_listing_id`) REFERENCES `marketplace_listings`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`assessed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`target_publication_id`) REFERENCES `evidence_publications`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_evidence_reports_target` ON `evidence_reports` (`target_publication_id`,`assessment_status`);--> statement-breakpoint
CREATE TABLE `execution_grants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` integer NOT NULL,
	`listing_id` integer NOT NULL,
	`workflow_version_id` integer,
	`source` text,
	`source_ref` text,
	`state` text DEFAULT 'active' NOT NULL,
	`policy_version` text,
	`granted_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`listing_id`) REFERENCES `marketplace_listings`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workflow_version_id`) REFERENCES `pipeline_versions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_execution_grants_subject_listing` ON `execution_grants` (`subject_id`,`listing_id`,`state`);--> statement-breakpoint
CREATE TABLE `external_evidence_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`author_id` integer NOT NULL,
	`listing_id` integer NOT NULL,
	`workflow_version_id` integer,
	`declared_inputs` text NOT NULL,
	`declared_outputs` text NOT NULL,
	`declared_model` text,
	`declared_date` text,
	`declared_rubric` text,
	`attachments` text,
	`notes` text,
	`publication_state` text DEFAULT 'draft' NOT NULL,
	`consent_version` text,
	`preview_hash` text,
	`published_at` integer,
	`withdrawn_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`listing_id`) REFERENCES `marketplace_listings`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workflow_version_id`) REFERENCES `pipeline_versions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_external_evidence_reports_listing` ON `external_evidence_reports` (`listing_id`);--> statement-breakpoint
CREATE TABLE `feature_flags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`enabled` integer DEFAULT false NOT NULL,
	`rollout_percent` integer DEFAULT 0,
	`allowed_user_ids` text,
	`plugin_id` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feature_flags_key_unique` ON `feature_flags` (`key`);--> statement-breakpoint
CREATE TABLE `feedback` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`team_id` integer,
	`project_id` integer,
	`user_id` integer NOT NULL,
	`target_type` text DEFAULT 'general' NOT NULL,
	`target_message_id` integer,
	`feedback_type` text NOT NULL,
	`severity` text DEFAULT 'minor',
	`content` text NOT NULL,
	`screenshot_url` text,
	`context_json` text,
	`tags_json` text,
	`status` text DEFAULT 'new' NOT NULL,
	`assigned_to` integer,
	`converted_to_issue_id` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`resolved_at` integer,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assigned_to`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_feedback_team_id` ON `feedback` (`team_id`);--> statement-breakpoint
CREATE INDEX `idx_feedback_project_id` ON `feedback` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_feedback_user_id` ON `feedback` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_feedback_status` ON `feedback` (`status`);--> statement-breakpoint
CREATE TABLE `feedback_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`feedback_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`kind` text NOT NULL,
	`ref_id` integer NOT NULL,
	`consent_version` text NOT NULL,
	`snapshot` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`feedback_id`) REFERENCES `feedback`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_feedback_attachments_feedback_id` ON `feedback_attachments` (`feedback_id`);--> statement-breakpoint
CREATE INDEX `idx_feedback_attachments_user_id` ON `feedback_attachments` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_feedback_attachments_kind_ref` ON `feedback_attachments` (`kind`,`ref_id`);--> statement-breakpoint
CREATE TABLE `file_dependencies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`source_file_id` integer NOT NULL,
	`target_file_id` integer NOT NULL,
	`import_type` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_file_deps_source` ON `file_dependencies` (`source_file_id`);--> statement-breakpoint
CREATE INDEX `idx_file_deps_target` ON `file_dependencies` (`target_file_id`);--> statement-breakpoint
CREATE TABLE `fix_verifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`tester_comment` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`verified_at` integer,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`key` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`response_hash` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_idempotency_keys_created_at` ON `idempotency_keys` (`created_at`);--> statement-breakpoint
CREATE TABLE `issues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`team_id` integer,
	`project_id` integer,
	`title` text NOT NULL,
	`description` text,
	`priority` text DEFAULT 'p2' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`assignee_id` integer,
	`related_feedback_ids_json` text,
	`resolution_notes` text,
	`created_by` integer NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`resolved_at` integer,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignee_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_issues_team_id` ON `issues` (`team_id`);--> statement-breakpoint
CREATE INDEX `idx_issues_project_id` ON `issues` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_issues_status` ON `issues` (`status`);--> statement-breakpoint
CREATE TABLE `job_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_key` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` integer NOT NULL,
	`operation` text NOT NULL,
	`payload` text,
	`delivery_state` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_retry_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`delivered_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_outbox_event_key_unique` ON `job_outbox` (`event_key`);--> statement-breakpoint
CREATE INDEX `idx_job_outbox_pending` ON `job_outbox` (`delivery_state`,`next_retry_at`);--> statement-breakpoint
CREATE TABLE `listing_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`listing_id` integer NOT NULL,
	`reviewer_id` integer NOT NULL,
	`prompt_index` integer NOT NULL,
	`accuracy` integer NOT NULL,
	`completeness` integer NOT NULL,
	`clarity` integer NOT NULL,
	`token_efficiency` integer NOT NULL,
	`speed` integer NOT NULL,
	`consistency` integer NOT NULL,
	`weighted_score` text NOT NULL,
	`review_time` integer NOT NULL,
	`flagged` integer DEFAULT false,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`listing_id`) REFERENCES `marketplace_listings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `llm_providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`base_url` text NOT NULL,
	`api_key_ref` text NOT NULL,
	`default_model` text NOT NULL,
	`models` text,
	`config` text,
	`is_enabled` integer DEFAULT true,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_llm_providers_user_id` ON `llm_providers` (`user_id`);--> statement-breakpoint
CREATE TABLE `marketplace_checkout_quotes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`buyer_id` integer NOT NULL,
	`listing_id` integer NOT NULL,
	`workflow_version_id` integer,
	`currency` text DEFAULT 'USD' NOT NULL,
	`amount` text NOT NULL,
	`commission_basis` text NOT NULL,
	`commission_rate` text NOT NULL,
	`refund_policy_version` text,
	`hold_policy_version` text,
	`stripe_session_id` text,
	`status` text DEFAULT 'created' NOT NULL,
	`purchase_id` integer,
	`expires_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`buyer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`listing_id`) REFERENCES `marketplace_listings`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workflow_version_id`) REFERENCES `pipeline_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`purchase_id`) REFERENCES `marketplace_purchases`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `marketplace_checkout_quotes_stripe_session_id_unique` ON `marketplace_checkout_quotes` (`stripe_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_checkout_quotes_purchase` ON `marketplace_checkout_quotes` (`purchase_id`);--> statement-breakpoint
CREATE INDEX `idx_checkout_quotes_buyer_status` ON `marketplace_checkout_quotes` (`buyer_id`,`status`);--> statement-breakpoint
CREATE TABLE `marketplace_listing_v2` (
	`listing_id` integer PRIMARY KEY NOT NULL,
	`publication_mode` text DEFAULT 'legacy' NOT NULL,
	`current_workflow_version_id` integer,
	`current_evidence_publication_id` integer,
	`evidence_summary_revision` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`listing_id`) REFERENCES `marketplace_listings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`current_workflow_version_id`) REFERENCES `pipeline_versions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`current_evidence_publication_id`) REFERENCES `evidence_publications`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `marketplace_listings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`creator_id` integer NOT NULL,
	`template_id` integer NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`objectives` text,
	`input_format` text,
	`output_format` text,
	`remarks` text,
	`category` text DEFAULT 'other',
	`price` text NOT NULL,
	`is_subscription` integer DEFAULT false,
	`subscription_price` text,
	`status` text DEFAULT 'draft',
	`grade` text,
	`review_count` integer DEFAULT 0,
	`kappa_score` text,
	`ai_correlation` text,
	`ai_grade` text,
	`ai_kappa_score` text,
	`ai_feedback` text,
	`ai_reviewed_at` integer,
	`certified_at` integer,
	`sales_count` integer DEFAULT 0,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`creator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`) REFERENCES `pipeline_templates`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `marketplace_purchases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`buyer_id` integer NOT NULL,
	`listing_id` integer NOT NULL,
	`amount_paid` text NOT NULL,
	`platform_fee` text NOT NULL,
	`creator_earnings` text NOT NULL,
	`is_subscription` integer DEFAULT false,
	`subscription_end` integer,
	`status` text DEFAULT 'active',
	`stripe_session_id` text,
	`stripe_payment_intent_id` text,
	`workflow_version_id` integer,
	`evidence_publication_id` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`buyer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`listing_id`) REFERENCES `marketplace_listings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_version_id`) REFERENCES `pipeline_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`evidence_publication_id`) REFERENCES `evidence_publications`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `mcp_audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`client_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`latency_ms` integer NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_mcp_audit_log_user_id` ON `mcp_audit_log` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_mcp_audit_log_created_at` ON `mcp_audit_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `memory_locks` (
	`project_id` integer PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`last_writer_id` integer,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`last_writer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `model_catalog` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`family` text,
	`vendor` text,
	`successor_of_model_id` text,
	`availability_source` text DEFAULT 'admin_reviewed' NOT NULL,
	`source_url` text,
	`verified_at` integer,
	`available_at` integer,
	`deprecated_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_model_catalog_provider_model` ON `model_catalog` (`provider`,`model_id`);--> statement-breakpoint
CREATE TABLE `model_release_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`model_catalog_id` integer NOT NULL,
	`event_key` text NOT NULL,
	`recorded_by` integer,
	`relevance_rule` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`model_catalog_id`) REFERENCES `model_catalog`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_release_events_event_key_unique` ON `model_release_events` (`event_key`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`message` text,
	`data_json` text,
	`is_read` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_notifications_user_id` ON `notifications` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_notifications_unread` ON `notifications` (`user_id`,`is_read`);--> statement-breakpoint
CREATE TABLE `oauth_auth_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code_hash` text NOT NULL,
	`client_id` text NOT NULL,
	`user_id` integer NOT NULL,
	`redirect_uri` text,
	`code_challenge` text,
	`code_challenge_method` text,
	`scopes` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_auth_codes_code_hash_unique` ON `oauth_auth_codes` (`code_hash`);--> statement-breakpoint
CREATE INDEX `idx_oauth_auth_codes_client_id` ON `oauth_auth_codes` (`client_id`);--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` text NOT NULL,
	`client_name` text,
	`redirect_uris` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_clients_client_id_unique` ON `oauth_clients` (`client_id`);--> statement-breakpoint
CREATE TABLE `oauth_refresh_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`client_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes` text,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_refresh_tokens_token_hash_unique` ON `oauth_refresh_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_oauth_refresh_tokens_user_id` ON `oauth_refresh_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `payout_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`settlement_entry_id` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`provider` text NOT NULL,
	`provider_transfer_ref` text,
	`amount` text NOT NULL,
	`currency` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`provider_confirmed_at` integer,
	`failure_reason` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`settlement_entry_id`) REFERENCES `settlement_entries`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payout_attempts_idempotency_key_unique` ON `payout_attempts` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_payout_attempts_settlement` ON `payout_attempts` (`settlement_entry_id`,`state`);--> statement-breakpoint
CREATE INDEX `idx_payout_attempts_unreconciled` ON `payout_attempts` (`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `pipeline_shares` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`owner_id` integer NOT NULL,
	`grantee_id` integer NOT NULL,
	`access_mode` text DEFAULT 'run_only' NOT NULL,
	`can_modify` integer DEFAULT false NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`note` text,
	`granted_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`grantee_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_pipeline_shares_project_grantee` ON `pipeline_shares` (`project_id`,`grantee_id`);--> statement-breakpoint
CREATE INDEX `idx_pipeline_shares_grantee_state` ON `pipeline_shares` (`grantee_id`,`state`);--> statement-breakpoint
CREATE INDEX `idx_pipeline_shares_owner_state` ON `pipeline_shares` (`owner_id`,`state`);--> statement-breakpoint
CREATE TABLE `pipeline_steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`step_order` integer NOT NULL,
	`agent_id` integer,
	`step_type` text DEFAULT 'agent' NOT NULL,
	`provider_id` integer,
	`model` text,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`system_prompt` text NOT NULL,
	`temperature` text DEFAULT '0.7',
	`max_tokens` integer DEFAULT 4096,
	`if_config` text,
	`while_config` text,
	`is_enabled` integer DEFAULT true,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `custom_agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `llm_providers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_pipeline_steps_project_id` ON `pipeline_steps` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_pipeline_steps_order` ON `pipeline_steps` (`project_id`,`step_order`);--> statement-breakpoint
CREATE TABLE `pipeline_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`steps` text NOT NULL,
	`is_auto` integer DEFAULT false NOT NULL,
	`source_project_id` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pipeline_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer NOT NULL,
	`source_project_id` integer,
	`source_template_id` integer,
	`version_number` integer NOT NULL,
	`definition_schema_version` integer DEFAULT 1 NOT NULL,
	`definition` text NOT NULL,
	`definition_hash` text NOT NULL,
	`designer_method` text DEFAULT 'manual' NOT NULL,
	`designer_provider_id` integer,
	`designer_model` text,
	`designer_prompt_version` text,
	`parent_version_id` integer,
	`origin_creator_id` integer,
	`origin_version_id` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_pipeline_versions_owner_version` ON `pipeline_versions` (`owner_id`,`source_project_id`,`version_number`);--> statement-breakpoint
CREATE INDEX `idx_pipeline_versions_hash` ON `pipeline_versions` (`definition_hash`);--> statement-breakpoint
CREATE TABLE `project_file_contents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`path` text NOT NULL,
	`content` text NOT NULL,
	`size_bytes` integer,
	`language` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `project_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text,
	`size_bytes` integer,
	`content` text,
	`is_directory` integer DEFAULT false,
	`parent_path` text,
	`gitee_sha` text,
	`last_synced_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_project_files_project_id` ON `project_files` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_project_files_path` ON `project_files` (`project_id`,`path`);--> statement-breakpoint
CREATE TABLE `project_revisions` (
	`project_id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`gitee_owner` text,
	`gitee_repo` text,
	`gitee_branch` text DEFAULT 'main',
	`github_owner` text,
	`github_repo` text,
	`github_branch` text DEFAULT 'main',
	`local_folder_name` text,
	`state_summary_path` text DEFAULT '.ai-swarm/project-state.md',
	`default_provider_id` integer,
	`default_model` text,
	`pipeline_config` text,
	`pipeline_template_id` integer,
	`origin_creator_id` integer,
	`is_archived` integer DEFAULT false,
	`last_synced_at` integer,
	`intelligence_card` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`default_provider_id`) REFERENCES `llm_providers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_projects_user_id` ON `projects` (`user_id`);--> statement-breakpoint
CREATE TABLE `promotion_redemptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`promotion_id` integer NOT NULL,
	`days` integer NOT NULL,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`promotion_id`) REFERENCES `promotions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_promotion_redemption_user_promo` ON `promotion_redemptions` (`user_id`,`promotion_id`);--> statement-breakpoint
CREATE INDEX `idx_promotion_redemption_promo` ON `promotion_redemptions` (`promotion_id`);--> statement-breakpoint
CREATE TABLE `promotions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`days` integer NOT NULL,
	`audience` text NOT NULL,
	`code` text,
	`starts_at` integer,
	`ends_at` integer,
	`max_redemptions` integer,
	`active` integer DEFAULT true NOT NULL,
	`note` text,
	`created_by` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_promotions_code` ON `promotions` (`code`);--> statement-breakpoint
CREATE INDEX `idx_promotions_audience_active` ON `promotions` (`audience`,`active`);--> statement-breakpoint
CREATE TABLE `refund_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`creator_id` integer NOT NULL,
	`listing_id` integer NOT NULL,
	`deposit_id` integer NOT NULL,
	`sale_id` integer NOT NULL,
	`commission_earned` text NOT NULL,
	`amount_refunded` text NOT NULL,
	`is_fully_refunded` integer DEFAULT false,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`creator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`listing_id`) REFERENCES `marketplace_listings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deposit_id`) REFERENCES `creator_deposits`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `relay_registrations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`owner_user_id` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_seen_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relay_registrations_token_hash_unique` ON `relay_registrations` (`token_hash`);--> statement-breakpoint
CREATE TABLE `relay_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`relay_id` integer NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result_json` text,
	`error` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`claimed_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`relay_id`) REFERENCES `relay_registrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_relay_req_status` ON `relay_requests` (`relay_id`,`status`);--> statement-breakpoint
CREATE TABLE `retest_suggestions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`seller_id` integer NOT NULL,
	`listing_id` integer NOT NULL,
	`workflow_version_id` integer,
	`release_event_id` integer NOT NULL,
	`channel` text DEFAULT 'in_app' NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`snoozed_until` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`seller_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`listing_id`) REFERENCES `marketplace_listings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_version_id`) REFERENCES `pipeline_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`release_event_id`) REFERENCES `model_release_events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_retest_suggestions_seller_version_event_channel` ON `retest_suggestions` (`seller_id`,`workflow_version_id`,`release_event_id`,`channel`);--> statement-breakpoint
CREATE INDEX `idx_retest_suggestions_seller` ON `retest_suggestions` (`seller_id`,`state`);--> statement-breakpoint
CREATE TABLE `review_assignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`listing_id` integer NOT NULL,
	`reviewer_id` integer NOT NULL,
	`status` text DEFAULT 'pending',
	`assigned_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`due_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`listing_id`) REFERENCES `marketplace_listings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `reviewer_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`trust_score` integer DEFAULT 100,
	`reviews_completed` integer DEFAULT 0,
	`reviews_flagged` integer DEFAULT 0,
	`arbiter_rulings_against` integer DEFAULT 0,
	`points_earned` integer DEFAULT 0,
	`points_balance` integer DEFAULT 0,
	`subscription_days` integer DEFAULT 0,
	`is_active` integer DEFAULT true,
	`status` text DEFAULT 'active',
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviewer_profiles_user_id_unique` ON `reviewer_profiles` (`user_id`);--> statement-breakpoint
CREATE TABLE `settlement_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purchase_id` integer,
	`adjustment_source` text NOT NULL,
	`seller_id` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`gross_amount` text NOT NULL,
	`commission_basis` text NOT NULL,
	`commission_rate` text NOT NULL,
	`fees_tax_ref` text,
	`net_payable` text NOT NULL,
	`state` text DEFAULT 'held' NOT NULL,
	`hold_policy_version` text,
	`hold_until` integer,
	`dispute_state` text DEFAULT 'none' NOT NULL,
	`policy_snapshot` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`purchase_id`) REFERENCES `marketplace_purchases`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`seller_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_settlement_entries_seller_state` ON `settlement_entries` (`seller_id`,`state`);--> statement-breakpoint
CREATE INDEX `idx_settlement_entries_hold` ON `settlement_entries` (`state`,`hold_until`);--> statement-breakpoint
CREATE TABLE `spend_approvals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_id` integer NOT NULL,
	`payer_id` integer NOT NULL,
	`purpose` text NOT NULL,
	`plan_hash` text NOT NULL,
	`plan_snapshot` text NOT NULL,
	`bindings` text NOT NULL,
	`limits` text,
	`spend_ceiling_usd` text,
	`status` text DEFAULT 'active' NOT NULL,
	`policy_version` text NOT NULL,
	`approved_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`payer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_spend_approvals_actor_status` ON `spend_approvals` (`actor_id`,`status`);--> statement-breakpoint
CREATE TABLE `sso_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`domain` text NOT NULL,
	`display_name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`oidc_issuer` text,
	`oidc_client_id` text,
	`oidc_client_secret_enc` text,
	`oidc_scopes` text DEFAULT 'openid email profile' NOT NULL,
	`saml_entry_point` text,
	`saml_issuer` text,
	`saml_cert` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sso_connections_domain_unique` ON `sso_connections` (`domain`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer,
	`team_id` integer,
	`plan` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`stripe_customer_id` text,
	`stripe_subscription_id` text,
	`seats` integer DEFAULT 1 NOT NULL,
	`current_period_end` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_stripe_subscription_id_unique` ON `subscriptions` (`stripe_subscription_id`);--> statement-breakpoint
CREATE INDEX `idx_subscriptions_user_id` ON `subscriptions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_subscriptions_team_id` ON `subscriptions` (`team_id`);--> statement-breakpoint
CREATE TABLE `swarm_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`project_id` integer NOT NULL,
	`name` text,
	`status` text DEFAULT 'running' NOT NULL,
	`total_runs` integer NOT NULL,
	`completed_runs` integer DEFAULT 0 NOT NULL,
	`failed_runs` integer DEFAULT 0 NOT NULL,
	`total_tokens_used` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_swarm_batches_user_id` ON `swarm_batches` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_swarm_batches_project_id` ON `swarm_batches` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_swarm_batches_status` ON `swarm_batches` (`status`);--> statement-breakpoint
CREATE TABLE `swarm_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`user_prompt` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`current_step` text DEFAULT 'init',
	`pipeline_version` text DEFAULT 'cascade-v1',
	`agents_used` text,
	`iterations_used` integer DEFAULT 0,
	`is_test_run` integer DEFAULT false,
	`test_fixture_id` integer,
	`final_response_id` integer,
	`total_tokens_used` integer,
	`total_latency_ms` integer,
	`execution_state` text,
	`run_params` text,
	`started_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`completed_at` integer,
	`batch_id` integer,
	`error` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_swarm_runs_project_id` ON `swarm_runs` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_swarm_runs_user_id` ON `swarm_runs` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_swarm_runs_status` ON `swarm_runs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_swarm_runs_batch_id` ON `swarm_runs` (`batch_id`);--> statement-breakpoint
CREATE TABLE `team_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`team_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`role` text DEFAULT 'tester' NOT NULL,
	`joined_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`last_active_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`engagement_score` integer DEFAULT 0,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_team_members_user_id` ON `team_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_team_members_team_id` ON `team_members` (`team_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_team_members_team_user` ON `team_members` (`team_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `team_projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`team_id` integer NOT NULL,
	`project_id` integer NOT NULL,
	`added_by` integer NOT NULL,
	`added_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`added_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_team_projects_team_id` ON `team_projects` (`team_id`);--> statement-breakpoint
CREATE INDEX `idx_team_projects_project_id` ON `team_projects` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_team_projects_team_project` ON `team_projects` (`team_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `team_seats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`team_id` integer NOT NULL,
	`seats` integer DEFAULT 1 NOT NULL,
	`stripe_subscription_id` text,
	`stripe_subscription_item_id` text,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_seats_team_id_unique` ON `team_seats` (`team_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`owner_id` integer NOT NULL,
	`invite_code` text,
	`invite_qr_url` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_invite_code_unique` ON `teams` (`invite_code`);--> statement-breakpoint
CREATE TABLE `test_fixtures` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`team_id` integer,
	`name` text NOT NULL,
	`description` text,
	`complexity` text DEFAULT 'medium',
	`storage_path` text NOT NULL,
	`size_bytes` integer,
	`file_count` integer DEFAULT 0,
	`gitee_path` text,
	`is_public` integer DEFAULT false,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_test_fixtures_user_id` ON `test_fixtures` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_test_fixtures_team_id` ON `test_fixtures` (`team_id`);--> statement-breakpoint
CREATE TABLE `test_prompt_intermediate` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`test_prompt_id` integer NOT NULL,
	`step_index` integer NOT NULL,
	`step_name` text NOT NULL,
	`step_role` text,
	`input_text` text NOT NULL,
	`output_text` text NOT NULL,
	`tokens_used` integer,
	`latency_ms` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`test_prompt_id`) REFERENCES `test_prompts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `test_prompts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`listing_id` integer NOT NULL,
	`prompt_index` integer NOT NULL,
	`category` text NOT NULL,
	`input_text` text NOT NULL,
	`actual_output` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`listing_id`) REFERENCES `marketplace_listings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `trial_grants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subject_id` integer NOT NULL,
	`listing_id` integer NOT NULL,
	`policy_window` text NOT NULL,
	`policy_version` text NOT NULL,
	`allowed_quota` integer NOT NULL,
	`reserved_count` integer DEFAULT 0 NOT NULL,
	`consumed_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`listing_id`) REFERENCES `marketplace_listings`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_trial_grants_subject_listing_window_policy` ON `trial_grants` (`subject_id`,`listing_id`,`policy_window`,`policy_version`);--> statement-breakpoint
CREATE TABLE `trial_reservations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trial_grant_id` integer NOT NULL,
	`operation_key` text NOT NULL,
	`state` text DEFAULT 'reserved' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`trial_grant_id`) REFERENCES `trial_grants`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_trial_reservations_operation_key` ON `trial_reservations` (`operation_key`);--> statement-breakpoint
CREATE INDEX `idx_trial_reservations_grant_state` ON `trial_reservations` (`trial_grant_id`,`state`);--> statement-breakpoint
CREATE TABLE `trusted_provider_endpoints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`base_url` text NOT NULL,
	`adapter_kind` text NOT NULL,
	`endpoint_class` text DEFAULT 'first_party' NOT NULL,
	`logging_disclosure` text NOT NULL,
	`protection_class` text DEFAULT 'standard' NOT NULL,
	`approved_by` integer,
	`policy_version` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_trusted_endpoints_provider_base` ON `trusted_provider_endpoints` (`provider`,`base_url`);--> statement-breakpoint
CREATE TABLE `usage_counters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subject_id` integer NOT NULL,
	`metric` text NOT NULL,
	`period` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_usage_counters_subject_metric_period` ON `usage_counters` (`subject_id`,`metric`,`period`);--> statement-breakpoint
CREATE TABLE `user_privacy_consent` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`allow_prompt_storage` integer DEFAULT true,
	`allow_feedback_storage` integer DEFAULT true,
	`allow_screenshots` integer DEFAULT true,
	`allow_conversation_history` integer DEFAULT false,
	`consented_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`unionId` text,
	`username` text,
	`password_hash` text,
	`name` text,
	`email` text,
	`avatar` text,
	`role` text DEFAULT 'user' NOT NULL,
	`tier` text DEFAULT 'standard' NOT NULL,
	`default_provider_id` integer,
	`default_model` text,
	`preferences` text,
	`createdAt` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updatedAt` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`lastSignInAt` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_unionId_unique` ON `users` (`unionId`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE TABLE `voucher_redemptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`voucher_id` integer NOT NULL,
	`tier` text NOT NULL,
	`expires_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`voucher_id`) REFERENCES `vouchers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_voucher_redemptions_user_id` ON `voucher_redemptions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_voucher_redemptions_voucher_id` ON `voucher_redemptions` (`voucher_id`);--> statement-breakpoint
CREATE TABLE `vouchers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`tier` text NOT NULL,
	`duration_days` integer DEFAULT 30 NOT NULL,
	`max_uses` integer DEFAULT 1 NOT NULL,
	`used_count` integer DEFAULT 0 NOT NULL,
	`label` text,
	`expires_at` integer,
	`created_by` integer NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vouchers_code_unique` ON `vouchers` (`code`);--> statement-breakpoint
CREATE TABLE `waitlist_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`ref` text,
	`referral_code` text NOT NULL,
	`invited_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_waitlist_email` ON `waitlist_entries` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_waitlist_referral_code` ON `waitlist_entries` (`referral_code`);