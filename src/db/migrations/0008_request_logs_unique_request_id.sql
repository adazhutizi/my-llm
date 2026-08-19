-- Clean duplicate request_id rows BEFORE adding the UNIQUE constraint: keep
-- only the newest row per request_id (MAX(id) = most recently inserted).
-- request_logs historically had no unique constraint on request_id, so repeats
-- accumulated when clients/proxies reused X-Request-ID; without this cleanup
-- the ADD CONSTRAINT below fails on the duplicate values.
-- request_details is intentionally untouched — it already had a unique
-- constraint, so it has no duplicate rows.
DELETE rl FROM `request_logs` rl
INNER JOIN (
  SELECT request_id, MAX(id) AS keep_id
  FROM `request_logs`
  GROUP BY request_id
  HAVING COUNT(*) > 1
) k ON rl.request_id = k.request_id AND rl.id <> k.keep_id;--> statement-breakpoint
DROP INDEX `idx_request_logs_request_id` ON `request_logs`;--> statement-breakpoint
ALTER TABLE `request_logs` ADD CONSTRAINT `request_logs_request_id_unique` UNIQUE(`request_id`);
