ALTER TABLE `engines` ADD `auth_status` text DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE `engines` ADD `auth_detail` text;--> statement-breakpoint
ALTER TABLE `engines` ADD `account_label` text;--> statement-breakpoint
ALTER TABLE `engines` ADD `reset_at` integer;--> statement-breakpoint
ALTER TABLE `engines` ADD `models` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `engines` ADD `usage_windows` text DEFAULT '[]' NOT NULL;