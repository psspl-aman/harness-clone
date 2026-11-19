ALTER TABLE `pms_mappings` ADD `auto_enrich` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `pms_mappings` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `pms_mappings` ADD `last_result` text;