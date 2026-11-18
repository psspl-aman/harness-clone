ALTER TABLE `requirements` ADD `kind` text DEFAULT 'message' NOT NULL;--> statement-breakpoint
ALTER TABLE `requirements` ADD `status` text DEFAULT 'done' NOT NULL;--> statement-breakpoint
ALTER TABLE `requirements` ADD `questions` text;--> statement-breakpoint
ALTER TABLE `requirements` ADD `plan_id` text;--> statement-breakpoint
ALTER TABLE `requirements` ADD `run_id` text;