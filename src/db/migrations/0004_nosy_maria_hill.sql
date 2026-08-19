ALTER TABLE `request_logs` ADD `cache_read_tokens` int;--> statement-breakpoint
ALTER TABLE `request_logs` ADD `cache_creation_tokens` int;--> statement-breakpoint
ALTER TABLE `usage_records` ADD `cache_read_tokens` bigint unsigned DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `usage_records` ADD `cache_creation_tokens` bigint unsigned DEFAULT 0 NOT NULL;