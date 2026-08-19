-- Migrate all TIMESTAMP columns to DATETIME to escape the 2038-01-19 03:14:07
-- UTC ceiling (TIMESTAMP stores Unix seconds in a signed 32-bit int). DATETIME
-- ranges to 9999. Application code is unchanged: drizzle's timestamp/datetime
-- columns share identical UTC mapping (toISOString / parse-as-UTC).
--
-- CRITICAL: the TIMESTAMP -> DATETIME conversion reads each TIMESTAMP's stored
-- UTC value through the CURRENT session time zone to produce the DATETIME
-- literal, so this MUST run under session=UTC or every value shifts by the
-- session offset. db/index.ts already pins every pool connection to UTC; the
-- SET below is belt-and-suspenders for runs via a client that doesn't inherit
-- that (e.g. a manual `mysql <` dump). NB: request_details (~738MB) uses COPY
-- algorithm under LOCK=SHARED — expect a few minutes of write blocking there;
-- run in a maintenance window or via pt-online-schema-change on production.
SET time_zone='+00:00';--> statement-breakpoint
ALTER TABLE `admin_users` MODIFY COLUMN `last_login_at` datetime DEFAULT NULL;--> statement-breakpoint
ALTER TABLE `admin_users` MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE `admin_users` MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE `api_keys` MODIFY COLUMN `expires_at` datetime DEFAULT NULL;--> statement-breakpoint
ALTER TABLE `api_keys` MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE `app_users` MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE `apps` MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE `apps` MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE `features` MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE `providers` MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE `rate_limits` MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE `rate_limits` MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE `request_details` MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE `request_details` MODIFY COLUMN `archived_at` datetime DEFAULT NULL;--> statement-breakpoint
ALTER TABLE `request_logs` MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE `usage_records` MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE `virtual_models` MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP;