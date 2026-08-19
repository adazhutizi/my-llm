ALTER TABLE `request_details` ADD `archived_at` timestamp NULL DEFAULT NULL;--> statement-breakpoint
ALTER TABLE `request_details` ADD `merged_into` varchar(36);--> statement-breakpoint
CREATE INDEX `idx_request_details_archived_created` ON `request_details` (`archived_at`,`created_at`);