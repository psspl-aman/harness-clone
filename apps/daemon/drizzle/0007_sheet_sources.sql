CREATE TABLE `sheet_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`location` text NOT NULL,
	`sheet` text,
	`columns` text DEFAULT '{}' NOT NULL,
	`polling_interval_sec` integer,
	`auto_start` integer DEFAULT true NOT NULL,
	`auto_enrich` integer DEFAULT true NOT NULL,
	`last_synced_at` integer,
	`last_error` text,
	`last_result` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sheet_sources_uq` ON `sheet_sources` (`project_id`,`location`,`sheet`);