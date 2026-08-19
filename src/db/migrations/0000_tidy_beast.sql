CREATE TABLE `admin_users` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`username` varchar(100) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	`role` enum('admin','super_admin') NOT NULL DEFAULT 'admin',
	`status` enum('active','disabled') NOT NULL DEFAULT 'active',
	`last_login_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `admin_users_id` PRIMARY KEY(`id`),
	CONSTRAINT `admin_users_username_unique` UNIQUE(`username`)
);
--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`key_secret` varchar(64) NOT NULL,
	`key_prefix` varchar(20) NOT NULL,
	`mode` enum('user','app','admin','dedicated') NOT NULL,
	`user_id` bigint unsigned,
	`app_id` bigint unsigned,
	`provider_id` bigint unsigned,
	`upstream_api_key_enc` text,
	`name` varchar(100) NOT NULL,
	`permissions` json,
	`status` enum('active','revoked','expired','quota_exceeded') NOT NULL DEFAULT 'active',
	`expires_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `api_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `api_keys_key_secret_unique` UNIQUE(`key_secret`)
);
--> statement-breakpoint
CREATE TABLE `app_users` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`app_id` bigint unsigned NOT NULL,
	`external_uid` varchar(255) NOT NULL,
	`display_name` varchar(100),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `app_users_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_app_users_app_id_external_uid` UNIQUE(`app_id`,`external_uid`)
);
--> statement-breakpoint
CREATE TABLE `apps` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(100) NOT NULL,
	`description` text,
	`owner_id` bigint unsigned,
	`status` enum('active','disabled','quota_exceeded') NOT NULL DEFAULT 'active',
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `apps_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `features` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`app_id` bigint unsigned NOT NULL,
	`feature_id` varchar(255) NOT NULL,
	`display_name` varchar(100),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `features_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_features_app_id_feature_id` UNIQUE(`app_id`,`feature_id`)
);
--> statement-breakpoint
CREATE TABLE `providers` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(50) NOT NULL,
	`api_type` enum('openai','anthropic') NOT NULL DEFAULT 'openai',
	`base_url` varchar(500) NOT NULL,
	`api_key_enc` text,
	`config` json,
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `providers_id` PRIMARY KEY(`id`),
	CONSTRAINT `providers_name_unique` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`target_type` enum('global','app','user','api_key') NOT NULL,
	`target_id` bigint unsigned,
	`rpm` int NOT NULL DEFAULT 60,
	`qps` int NOT NULL DEFAULT 10,
	`daily_tokens` bigint unsigned,
	`monthly_tokens` bigint unsigned,
	`monthly_cost_usd` bigint unsigned,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `rate_limits_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_rate_limits_target` UNIQUE(`target_type`,`target_id`)
);
--> statement-breakpoint
CREATE TABLE `request_details` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`request_id` varchar(36) NOT NULL,
	`api_key_id` bigint unsigned NOT NULL,
	`request_method` varchar(10),
	`request_path` varchar(500),
	`request_headers` json,
	`request_body` json,
	`response_status` int,
	`response_headers` json,
	`response_body` json,
	`stream_chunks` longtext,
	`stream_chunk_count` int,
	`client_ip` varchar(45),
	`user_agent` varchar(500),
	`latency_ms` int,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `request_details_id` PRIMARY KEY(`id`),
	CONSTRAINT `request_details_request_id_unique` UNIQUE(`request_id`)
);
--> statement-breakpoint
CREATE TABLE `request_logs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`request_id` varchar(36) NOT NULL,
	`api_key_id` bigint unsigned NOT NULL,
	`app_id` bigint unsigned,
	`user_id` bigint unsigned,
	`app_user_id` varchar(255),
	`feature_id` varchar(255),
	`model` varchar(100),
	`provider` varchar(50),
	`status_code` int,
	`latency_ms` int,
	`prompt_tokens` int,
	`completion_tokens` int,
	`is_stream` boolean NOT NULL DEFAULT false,
	`error_message` text,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `request_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `usage_records` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`record_time` datetime NOT NULL,
	`api_key_id` bigint unsigned NOT NULL,
	`app_id` bigint unsigned,
	`user_id` bigint unsigned,
	`model` varchar(100) NOT NULL,
	`provider` varchar(50) NOT NULL,
	`prompt_tokens` bigint unsigned NOT NULL DEFAULT 0,
	`completion_tokens` bigint unsigned NOT NULL DEFAULT 0,
	`total_tokens` bigint unsigned NOT NULL DEFAULT 0,
	`request_count` int NOT NULL DEFAULT 0,
	`error_count` int NOT NULL DEFAULT 0,
	`cost_usd` bigint unsigned NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `usage_records_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`username` varchar(100) NOT NULL,
	`identifier` varchar(255) NOT NULL,
	`status` enum('active','disabled','quota_exceeded') NOT NULL DEFAULT 'active',
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_username_unique` UNIQUE(`username`),
	CONSTRAINT `users_identifier_unique` UNIQUE(`identifier`)
);
--> statement-breakpoint
CREATE TABLE `virtual_models` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`model_id` varchar(100) NOT NULL,
	`display_name` varchar(200) NOT NULL,
	`provider` varchar(50) NOT NULL,
	`real_model` varchar(100) NOT NULL,
	`fallbacks` json,
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `virtual_models_id` PRIMARY KEY(`id`),
	CONSTRAINT `virtual_models_model_id_unique` UNIQUE(`model_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_api_keys_key_secret` ON `api_keys` (`key_secret`);--> statement-breakpoint
CREATE INDEX `idx_api_keys_mode_user_id` ON `api_keys` (`mode`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_api_keys_mode_app_id` ON `api_keys` (`mode`,`app_id`);--> statement-breakpoint
CREATE INDEX `idx_api_keys_provider_id` ON `api_keys` (`provider_id`);--> statement-breakpoint
CREATE INDEX `idx_app_users_app_id` ON `app_users` (`app_id`);--> statement-breakpoint
CREATE INDEX `idx_features_app_id` ON `features` (`app_id`);--> statement-breakpoint
CREATE INDEX `idx_request_details_request_id` ON `request_details` (`request_id`);--> statement-breakpoint
CREATE INDEX `idx_request_details_api_key_created_at` ON `request_details` (`api_key_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_request_details_created_at` ON `request_details` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_request_logs_request_id` ON `request_logs` (`request_id`);--> statement-breakpoint
CREATE INDEX `idx_request_logs_created_at` ON `request_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_usage_records_api_key_record_time` ON `usage_records` (`api_key_id`,`record_time`);--> statement-breakpoint
CREATE INDEX `idx_usage_records_app_record_time` ON `usage_records` (`app_id`,`record_time`);--> statement-breakpoint
CREATE INDEX `idx_usage_records_user_record_time` ON `usage_records` (`user_id`,`record_time`);