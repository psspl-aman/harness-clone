ALTER TABLE `project_settings` ADD `role_models` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `project_settings` ADD `routing` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `role_models` text DEFAULT '{}' NOT NULL;