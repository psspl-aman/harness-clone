CREATE TABLE `secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`auth_tag` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secrets_name_unique` ON `secrets` (`name`);--> statement-breakpoint
ALTER TABLE `projects` ADD `onboarding_report` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `onboarding_error` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `onboarded_at` integer;