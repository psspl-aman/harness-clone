ALTER TABLE `project_settings` ADD `pipeline_paused` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `pipeline_state` text DEFAULT '{}' NOT NULL;