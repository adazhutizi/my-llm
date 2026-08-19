-- Add Chinese COMMENT to every column of every table.
-- drizzle-orm has NO declarative column/table comment support (open issue
-- #5203), so this is hand-written raw SQL. MODIFY COLUMN must preserve each
-- column's exact type/constraints (AUTO_INCREMENT, ON UPDATE CURRENT_TIMESTAMP,
-- enum value set); PRIMARY KEY / UNIQUE are table-level constraints and are
-- intentionally NOT re-declared (MODIFY preserves them). Comment-only change
-- (no data/structure change) — in-place on MySQL 8.0.

ALTER TABLE `admin_users`
  MODIFY COLUMN `id` bigint unsigned AUTO_INCREMENT NOT NULL COMMENT '主键 ID',
  MODIFY COLUMN `username` varchar(100) NOT NULL COMMENT '管理员用户名',
  MODIFY COLUMN `password_hash` varchar(255) NOT NULL COMMENT '密码哈希',
  MODIFY COLUMN `role` enum('admin','super_admin') NOT NULL DEFAULT 'admin' COMMENT '角色',
  MODIFY COLUMN `status` enum('active','disabled') NOT NULL DEFAULT 'active' COMMENT '状态',
  MODIFY COLUMN `last_login_at` datetime DEFAULT NULL COMMENT '最后登录时间',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';
--> statement-breakpoint
ALTER TABLE `api_keys`
  MODIFY COLUMN `id` bigint unsigned AUTO_INCREMENT NOT NULL COMMENT '主键 ID',
  MODIFY COLUMN `key_secret` varchar(64) NOT NULL COMMENT 'API 密钥明文',
  MODIFY COLUMN `key_prefix` varchar(20) NOT NULL COMMENT '密钥前缀(展示用)',
  MODIFY COLUMN `mode` enum('user','app','admin','dedicated') NOT NULL COMMENT '密钥模式',
  MODIFY COLUMN `user_id` bigint unsigned COMMENT '关联用户 ID',
  MODIFY COLUMN `app_id` bigint unsigned COMMENT '关联应用 ID',
  MODIFY COLUMN `provider_id` bigint unsigned COMMENT '关联服务商 ID(dedicated 模式)',
  MODIFY COLUMN `upstream_api_key_enc` text COMMENT '上游 API 密钥(明文,dedicated 模式)',
  MODIFY COLUMN `name` varchar(100) NOT NULL COMMENT '密钥名称',
  MODIFY COLUMN `permissions` json COMMENT '权限配置(JSON)',
  MODIFY COLUMN `status` enum('active','revoked','expired','quota_exceeded') NOT NULL DEFAULT 'active' COMMENT '状态',
  MODIFY COLUMN `expires_at` datetime DEFAULT NULL COMMENT '过期时间',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';
--> statement-breakpoint
ALTER TABLE `app_users`
  MODIFY COLUMN `id` bigint unsigned AUTO_INCREMENT NOT NULL COMMENT '主键 ID',
  MODIFY COLUMN `app_id` bigint unsigned NOT NULL COMMENT '关联应用 ID',
  MODIFY COLUMN `external_uid` varchar(255) NOT NULL COMMENT '应用内外部用户标识',
  MODIFY COLUMN `display_name` varchar(100) COMMENT '展示名称',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';
--> statement-breakpoint
ALTER TABLE `apps`
  MODIFY COLUMN `id` bigint unsigned AUTO_INCREMENT NOT NULL COMMENT '主键 ID',
  MODIFY COLUMN `name` varchar(100) NOT NULL COMMENT '应用名称',
  MODIFY COLUMN `description` text COMMENT '应用描述',
  MODIFY COLUMN `owner_id` bigint unsigned COMMENT '应用归属用户 ID',
  MODIFY COLUMN `status` enum('active','disabled','quota_exceeded') NOT NULL DEFAULT 'active' COMMENT '状态',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';
--> statement-breakpoint
ALTER TABLE `features`
  MODIFY COLUMN `id` bigint unsigned AUTO_INCREMENT NOT NULL COMMENT '主键 ID',
  MODIFY COLUMN `app_id` bigint unsigned NOT NULL COMMENT '关联应用 ID',
  MODIFY COLUMN `feature_id` varchar(255) NOT NULL COMMENT '功能场景标识',
  MODIFY COLUMN `display_name` varchar(100) COMMENT '展示名称',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';
--> statement-breakpoint
ALTER TABLE `providers`
  MODIFY COLUMN `id` bigint unsigned AUTO_INCREMENT NOT NULL COMMENT '主键 ID',
  MODIFY COLUMN `name` varchar(50) NOT NULL COMMENT '服务商名称',
  MODIFY COLUMN `api_type` enum('openai','anthropic') NOT NULL DEFAULT 'openai' COMMENT '上游 API 协议类型',
  MODIFY COLUMN `base_url` varchar(500) NOT NULL COMMENT '上游基础地址',
  MODIFY COLUMN `api_key_enc` text COMMENT '服务商 API 密钥(明文)',
  MODIFY COLUMN `config` json COMMENT '服务商配置(JSON)',
  MODIFY COLUMN `is_active` boolean NOT NULL DEFAULT true COMMENT '是否启用',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';
--> statement-breakpoint
ALTER TABLE `rate_limits`
  MODIFY COLUMN `id` bigint unsigned AUTO_INCREMENT NOT NULL COMMENT '主键 ID',
  MODIFY COLUMN `target_type` enum('global','app','user','api_key') NOT NULL COMMENT '限流目标类型',
  MODIFY COLUMN `target_id` bigint unsigned COMMENT '限流目标 ID',
  MODIFY COLUMN `rpm` int NOT NULL DEFAULT 60 COMMENT '每分钟请求数上限',
  MODIFY COLUMN `qps` int NOT NULL DEFAULT 10 COMMENT '每秒请求数上限',
  MODIFY COLUMN `daily_tokens` bigint unsigned COMMENT '日 token 配额',
  MODIFY COLUMN `monthly_tokens` bigint unsigned COMMENT '月 token 配额',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';
--> statement-breakpoint
ALTER TABLE `request_details`
  MODIFY COLUMN `id` bigint unsigned AUTO_INCREMENT NOT NULL COMMENT '主键 ID',
  MODIFY COLUMN `request_id` varchar(36) NOT NULL COMMENT '请求 ID',
  MODIFY COLUMN `api_key_id` bigint unsigned NOT NULL COMMENT '关联 API 密钥 ID',
  MODIFY COLUMN `request_method` varchar(10) COMMENT '请求方法',
  MODIFY COLUMN `request_path` varchar(500) COMMENT '请求路径',
  MODIFY COLUMN `request_headers` json COMMENT '请求头(JSON)',
  MODIFY COLUMN `request_body` json COMMENT '请求体(JSON)',
  MODIFY COLUMN `response_status` int COMMENT '上游响应状态码',
  MODIFY COLUMN `response_headers` json COMMENT '响应头(JSON)',
  MODIFY COLUMN `response_body` json COMMENT '响应体(JSON)',
  MODIFY COLUMN `stream_chunks` longtext COMMENT '流式分块内容',
  MODIFY COLUMN `stream_chunk_count` int COMMENT '流式分块数',
  MODIFY COLUMN `client_ip` varchar(45) COMMENT '客户端 IP',
  MODIFY COLUMN `user_agent` varchar(500) COMMENT 'User-Agent',
  MODIFY COLUMN `latency_ms` int COMMENT '耗时(毫秒)',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `archived_at` datetime DEFAULT NULL COMMENT '归档时间(已并入后继则非空)',
  MODIFY COLUMN `merged_into` varchar(36) COMMENT '后继请求 ID(归档指向)';
--> statement-breakpoint
ALTER TABLE `request_logs`
  MODIFY COLUMN `id` bigint unsigned AUTO_INCREMENT NOT NULL COMMENT '主键 ID',
  MODIFY COLUMN `request_id` varchar(36) NOT NULL COMMENT '请求 ID',
  MODIFY COLUMN `api_key_id` bigint unsigned NOT NULL COMMENT '关联 API 密钥 ID',
  MODIFY COLUMN `app_id` bigint unsigned COMMENT '关联应用 ID',
  MODIFY COLUMN `user_id` bigint unsigned COMMENT '关联用户 ID',
  MODIFY COLUMN `app_user_id` varchar(255) COMMENT '应用内用户标识',
  MODIFY COLUMN `feature_id` varchar(255) COMMENT '功能场景标识',
  MODIFY COLUMN `model` varchar(100) COMMENT '虚拟模型名',
  MODIFY COLUMN `provider` varchar(50) COMMENT '服务商名称',
  MODIFY COLUMN `status_code` int COMMENT 'HTTP 状态码',
  MODIFY COLUMN `latency_ms` int COMMENT '耗时(毫秒)',
  MODIFY COLUMN `prompt_tokens` int COMMENT '输入 token 数',
  MODIFY COLUMN `completion_tokens` int COMMENT '输出 token 数',
  MODIFY COLUMN `cache_read_tokens` int COMMENT '缓存命中读取 token 数',
  MODIFY COLUMN `cache_creation_tokens` int COMMENT '缓存写入 token 数',
  MODIFY COLUMN `is_stream` boolean NOT NULL DEFAULT false COMMENT '是否流式请求',
  MODIFY COLUMN `error_message` text COMMENT '错误信息',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';
--> statement-breakpoint
ALTER TABLE `usage_records`
  MODIFY COLUMN `id` bigint unsigned AUTO_INCREMENT NOT NULL COMMENT '主键 ID',
  MODIFY COLUMN `record_time` datetime NOT NULL COMMENT '统计小时(整点)',
  MODIFY COLUMN `api_key_id` bigint unsigned NOT NULL COMMENT '关联 API 密钥 ID',
  MODIFY COLUMN `app_id` bigint unsigned COMMENT '关联应用 ID',
  MODIFY COLUMN `user_id` bigint unsigned COMMENT '关联用户 ID',
  MODIFY COLUMN `model` varchar(100) NOT NULL COMMENT '虚拟模型名',
  MODIFY COLUMN `provider` varchar(50) NOT NULL COMMENT '服务商名称',
  MODIFY COLUMN `prompt_tokens` bigint unsigned NOT NULL DEFAULT 0 COMMENT '输入 token 数(非缓存)',
  MODIFY COLUMN `completion_tokens` bigint unsigned NOT NULL DEFAULT 0 COMMENT '输出 token 数',
  MODIFY COLUMN `total_tokens` bigint unsigned NOT NULL DEFAULT 0 COMMENT '总 token 数(配额口径)',
  MODIFY COLUMN `cache_read_tokens` bigint unsigned NOT NULL DEFAULT 0 COMMENT '缓存命中读取 token 数',
  MODIFY COLUMN `cache_creation_tokens` bigint unsigned NOT NULL DEFAULT 0 COMMENT '缓存写入 token 数',
  MODIFY COLUMN `request_count` int NOT NULL DEFAULT 0 COMMENT '请求次数',
  MODIFY COLUMN `error_count` int NOT NULL DEFAULT 0 COMMENT '错误次数',
  MODIFY COLUMN `cost_usd` bigint unsigned NOT NULL DEFAULT 0 COMMENT '费用(预留,未使用)',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';
--> statement-breakpoint
ALTER TABLE `users`
  MODIFY COLUMN `id` bigint unsigned AUTO_INCREMENT NOT NULL COMMENT '主键 ID',
  MODIFY COLUMN `username` varchar(100) NOT NULL COMMENT '用户名',
  MODIFY COLUMN `identifier` varchar(255) NOT NULL COMMENT '用户唯一标识',
  MODIFY COLUMN `status` enum('active','disabled','quota_exceeded') NOT NULL DEFAULT 'active' COMMENT '状态',
  MODIFY COLUMN `group_id` bigint unsigned COMMENT '所属用户组 ID',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';
--> statement-breakpoint
ALTER TABLE `user_groups`
  MODIFY COLUMN `id` bigint unsigned AUTO_INCREMENT NOT NULL COMMENT '主键 ID',
  MODIFY COLUMN `name` varchar(100) NOT NULL COMMENT '用户组名称',
  MODIFY COLUMN `description` text COMMENT '用户组描述',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';
--> statement-breakpoint
ALTER TABLE `virtual_models`
  MODIFY COLUMN `id` bigint unsigned AUTO_INCREMENT NOT NULL COMMENT '主键 ID',
  MODIFY COLUMN `model_id` varchar(100) NOT NULL COMMENT '虚拟模型 ID',
  MODIFY COLUMN `display_name` varchar(200) NOT NULL COMMENT '模型展示名称',
  MODIFY COLUMN `provider` varchar(50) NOT NULL COMMENT '归属服务商名称',
  MODIFY COLUMN `real_model` varchar(100) NOT NULL COMMENT '上游真实模型名',
  MODIFY COLUMN `fallbacks` json COMMENT '降级模型列表(JSON)',
  MODIFY COLUMN `is_active` boolean NOT NULL DEFAULT true COMMENT '是否启用',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间';
--> statement-breakpoint
ALTER TABLE `system_settings`
  MODIFY COLUMN `id` bigint unsigned AUTO_INCREMENT NOT NULL COMMENT '主键 ID',
  MODIFY COLUMN `key` varchar(100) NOT NULL COMMENT '配置键',
  MODIFY COLUMN `value` text NOT NULL COMMENT '配置值',
  MODIFY COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';
