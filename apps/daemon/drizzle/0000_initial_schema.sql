CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text,
	`requirement_id` text,
	`role` text NOT NULL,
	`engine_id` text NOT NULL,
	`model` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'RUNNING' NOT NULL,
	`prompt` text NOT NULL,
	`cwd` text,
	`session_id` text,
	`result_summary` text,
	`result_json` text,
	`files_changed` text DEFAULT '[]' NOT NULL,
	`diff` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`exit_code` integer,
	`error_kind` text,
	`error_message` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requirement_id`) REFERENCES `requirements`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agent_runs_task_idx` ON `agent_runs` (`task_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `agent_runs_project_idx` ON `agent_runs` (`project_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `agent_runs_status_idx` ON `agent_runs` (`status`);--> statement-breakpoint
CREATE TABLE `checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text,
	`task_status` text NOT NULL,
	`role` text,
	`engine_id` text,
	`session_id` text,
	`branch_name` text,
	`last_completed_step` text,
	`notes` text DEFAULT '' NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `checkpoints_task_idx` ON `checkpoints` (`task_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`path` text,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `documents_project_idx` ON `documents` (`project_id`,`kind`);--> statement-breakpoint
CREATE TABLE `engine_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`engine_id` text NOT NULL,
	`status` text NOT NULL,
	`account_label` text,
	`reset_at` integer,
	`detail` text,
	`checked_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`engine_id`) REFERENCES `engines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `engine_sessions_engine_idx` ON `engine_sessions` (`engine_id`,`checked_at`);--> statement-breakpoint
CREATE TABLE `engines` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`display_name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`binary_path` text,
	`default_model` text,
	`custom_config` text,
	`installed` integer DEFAULT false NOT NULL,
	`version` text,
	`detected_path` text,
	`window_token_limit` integer,
	`window_hours` real,
	`last_checked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `errors` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text,
	`run_id` text,
	`terminal_session_id` text,
	`source` text NOT NULL,
	`matcher` text NOT NULL,
	`message` text NOT NULL,
	`file_path` text,
	`line` integer,
	`column` integer,
	`excerpt` text DEFAULT '' NOT NULL,
	`fingerprint` text NOT NULL,
	`occurrences` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`fix_task_id` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `errors_project_status_idx` ON `errors` (`project_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `errors_project_fingerprint_uq` ON `errors` (`project_id`,`fingerprint`);--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`command` text,
	`args` text DEFAULT '[]' NOT NULL,
	`env` text DEFAULT '{}' NOT NULL,
	`url` text,
	`headers` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_status` text DEFAULT 'unknown' NOT NULL,
	`last_error` text,
	`tools_cache` text DEFAULT '[]' NOT NULL,
	`last_checked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`project_id` text,
	`task_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`source` text DEFAULT 'user' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_scope_idx` ON `memory_entries` (`scope`,`project_id`);--> statement-breakpoint
CREATE INDEX `memory_task_idx` ON `memory_entries` (`task_id`);--> statement-breakpoint
CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`requirement_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`goal` text NOT NULL,
	`scope` text DEFAULT '' NOT NULL,
	`out_of_scope` text DEFAULT '' NOT NULL,
	`architecture_notes` text DEFAULT '' NOT NULL,
	`risks` text DEFAULT '[]' NOT NULL,
	`assumptions` text DEFAULT '[]' NOT NULL,
	`approved_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requirement_id`) REFERENCES `requirements`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `plans_project_idx` ON `plans` (`project_id`);--> statement-breakpoint
CREATE TABLE `pms_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`mcp_server_id` text NOT NULL,
	`tool_map` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mcp_server_id`) REFERENCES `mcp_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pms_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`external_project` text NOT NULL,
	`status_map` text DEFAULT '{}' NOT NULL,
	`filters` text DEFAULT '{}' NOT NULL,
	`polling_interval_sec` integer,
	`write_back` integer DEFAULT true NOT NULL,
	`last_synced_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `pms_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pms_mappings_uq` ON `pms_mappings` (`project_id`,`connection_id`,`external_project`);--> statement-breakpoint
CREATE TABLE `project_settings` (
	`project_id` text PRIMARY KEY NOT NULL,
	`role_engines` text DEFAULT '{}' NOT NULL,
	`max_concurrent_tasks` integer,
	`max_fix_loops` integer,
	`require_human_review` integer,
	`merge_strategy` text,
	`engine_fallback` text DEFAULT '{}' NOT NULL,
	`fallback_enabled` integer DEFAULT false NOT NULL,
	`memory_file_enabled` integer DEFAULT true NOT NULL,
	`memory_file_gitignored` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`origin` text NOT NULL,
	`source` text NOT NULL,
	`local_path` text NOT NULL,
	`github_repo` text,
	`default_branch` text,
	`working_branch` text,
	`stack` text DEFAULT '[]' NOT NULL,
	`stack_preferences` text,
	`commands` text DEFAULT '{}' NOT NULL,
	`onboarding_status` text DEFAULT 'pending' NOT NULL,
	`running_status` text DEFAULT 'stopped' NOT NULL,
	`next_task_seq` integer DEFAULT 1 NOT NULL,
	`archived_at` integer,
	`last_activity_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_uq` ON `projects` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_path_uq` ON `projects` (`local_path`);--> statement-breakpoint
CREATE TABLE `requirements` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`author` text NOT NULL,
	`content` text NOT NULL,
	`intent` text,
	`attachments` text DEFAULT '[]' NOT NULL,
	`references` text DEFAULT '{"files":[],"tasks":[]}' NOT NULL,
	`supersedes_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `requirements_project_idx` ON `requirements` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `review_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`file_path` text,
	`line` integer,
	`severity` text NOT NULL,
	`body` text NOT NULL,
	`resolved` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_comments_review_idx` ON `review_comments` (`review_id`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text,
	`reviewer` text DEFAULT 'agent' NOT NULL,
	`verdict` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `reviews_task_idx` ON `reviews` (`task_id`);--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`data` text NOT NULL,
	`ts` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_events_run_seq_uq` ON `run_events` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subtasks` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`title` text NOT NULL,
	`done` integer DEFAULT false NOT NULL,
	`order_index` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `subtasks_task_idx` ON `subtasks` (`task_id`);--> statement-breakpoint
CREATE TABLE `task_dependencies` (
	`task_id` text NOT NULL,
	`depends_on_task_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`task_id`, `depends_on_task_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_deps_reverse_idx` ON `task_dependencies` (`depends_on_task_id`);--> statement-breakpoint
CREATE TABLE `task_status_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`reason` text,
	`actor` text DEFAULT 'system' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_status_history_task_idx` ON `task_status_history` (`task_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`plan_id` text,
	`requirement_id` text,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`type` text DEFAULT 'feature' NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`complexity` text DEFAULT 'm' NOT NULL,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`status_reason` text,
	`resume_to_status` text,
	`resume_at` integer,
	`acceptance_criteria` text DEFAULT '[]' NOT NULL,
	`affected_areas` text DEFAULT '[]' NOT NULL,
	`role_engines` text DEFAULT '{}' NOT NULL,
	`order_index` real DEFAULT 0 NOT NULL,
	`fix_loop_count` integer DEFAULT 0 NOT NULL,
	`branch_name` text,
	`worktree_path` text,
	`base_branch` text,
	`pull_request_url` text,
	`origin` text DEFAULT 'planner' NOT NULL,
	`source_error_id` text,
	`pms_connection_id` text,
	`external_id` text,
	`external_url` text,
	`external_updated_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`requirement_id`) REFERENCES `requirements`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tasks_project_status_idx` ON `tasks` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `tasks_plan_idx` ON `tasks` (`plan_id`);--> statement-breakpoint
CREATE INDEX `tasks_resume_idx` ON `tasks` (`status`,`resume_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_project_key_uq` ON `tasks` (`project_id`,`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_external_uq` ON `tasks` (`pms_connection_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `terminal_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`engine_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`cwd` text NOT NULL,
	`command` text,
	`status` text DEFAULT 'running' NOT NULL,
	`pid` integer,
	`exit_code` integer,
	`created_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `terminal_sessions_project_idx` ON `terminal_sessions` (`project_id`);--> statement-breakpoint
CREATE TABLE `test_results` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text,
	`passed` integer NOT NULL,
	`total` integer,
	`failed` integer,
	`skipped` integer,
	`build_passed` integer,
	`commands` text DEFAULT '[]' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`log` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `test_results_task_idx` ON `test_results` (`task_id`);--> statement-breakpoint
CREATE TABLE `usage_records` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`project_id` text,
	`task_id` text,
	`role` text,
	`task_type` text,
	`engine_id` text NOT NULL,
	`model` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `usage_recorded_idx` ON `usage_records` (`recorded_at`);--> statement-breakpoint
CREATE INDEX `usage_project_idx` ON `usage_records` (`project_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `usage_engine_idx` ON `usage_records` (`engine_id`,`recorded_at`);