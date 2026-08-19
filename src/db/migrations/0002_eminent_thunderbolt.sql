-- Make trackUsage()'s INSERT ... ON DUPLICATE KEY UPDATE actually aggregate
-- usage per (api_key, hour, model, provider). Previously there was no UNIQUE
-- key on those columns, so the UPDATE branch never fired and every request
-- inserted a fresh row — request_count stuck at 1 and the table grew per
-- request. SUM() totals were still correct, just un-aggregated.
--
-- Before adding the UNIQUE constraint we must merge the existing duplicate
-- bucket rows, otherwise ADD CONSTRAINT fails on the dupes. We rebuild the
-- table via CREATE-LIKE + aggregated INSERT + atomic RENAME so no rows are
-- lost if a statement fails mid-migration.

DROP TABLE IF EXISTS `usage_records_new`;--> statement-breakpoint
CREATE TABLE `usage_records_new` LIKE `usage_records`;--> statement-breakpoint
INSERT INTO `usage_records_new` (
  `id`, `record_time`, `api_key_id`, `app_id`, `user_id`,
  `model`, `provider`, `prompt_tokens`, `completion_tokens`,
  `total_tokens`, `request_count`, `error_count`, `cost_usd`, `created_at`
)
SELECT
  MAX(`id`), `record_time`, `api_key_id`, MAX(`app_id`), MAX(`user_id`),
  `model`, `provider`,
  SUM(`prompt_tokens`), SUM(`completion_tokens`), SUM(`total_tokens`),
  SUM(`request_count`), SUM(`error_count`), MAX(`cost_usd`), MAX(`created_at`)
FROM `usage_records`
GROUP BY `api_key_id`, `record_time`, `model`, `provider`;--> statement-breakpoint
RENAME TABLE `usage_records` TO `usage_records_old`, `usage_records_new` TO `usage_records`;--> statement-breakpoint
DROP TABLE `usage_records_old`;--> statement-breakpoint
ALTER TABLE `usage_records` ADD CONSTRAINT `idx_usage_records_bucket` UNIQUE (`api_key_id`,`record_time`,`model`,`provider`);
