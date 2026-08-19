-- The explicit `NULL` keyword is required here. drizzle-kit only emits
-- `timestamp DEFAULT NULL` (no NULL); on MySQL with
-- explicit_defaults_for_timestamp=OFF (5.7 default) a bare TIMESTAMP column
-- defaults to NOT NULL, so `NOT NULL ... DEFAULT NULL` is rejected with
-- ER_INVALID_DEFAULT (1067). `timestamp NULL DEFAULT NULL` works regardless of
-- that setting. (drizzle's schema layer can't express the NULL keyword, so this
-- migration is hand-written rather than regenerated.)
ALTER TABLE `admin_users` MODIFY COLUMN `last_login_at` timestamp NULL DEFAULT NULL;--> statement-breakpoint
ALTER TABLE `api_keys` MODIFY COLUMN `expires_at` timestamp NULL DEFAULT NULL;