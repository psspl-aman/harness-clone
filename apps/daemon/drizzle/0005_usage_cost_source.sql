ALTER TABLE `usage_records` ADD `cost_source` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
UPDATE `usage_records` SET `cost_source` = 'reported' WHERE `cost_usd` > 0;
