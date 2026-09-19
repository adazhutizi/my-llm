import {
  mysqlTable,
  bigint,
  varchar,
  text,
  boolean,
  int,
  json,
  datetime,
  mysqlEnum,
  longtext,
  index,
  uniqueIndex,
} from 'drizzle-orm/mysql-core';
import { sql } from 'drizzle-orm';

// ─── users ───────────────────────────────────────────────────────────────────

export const users = mysqlTable(
  'users',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    username: varchar('username', { length: 100 }).notNull().unique(),
    identifier: varchar('identifier', { length: 255 }).notNull().unique(),
    status: mysqlEnum('status', ['active', 'disabled', 'quota_exceeded']).notNull().default('active'),
    // Optional group membership (one user → at most one group). Nullable: NULL
    // means ungrouped. No DB-level foreign key (project convention: drizzle
    // "raw" mode, no relations()); integrity is enforced in code —
    // deleteUserGroup() nulls this column for all members before deleting the
    // group, so no user ever points at a vanished group.
    groupId: bigint('group_id', { mode: 'number', unsigned: true }),
    createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: datetime('updated_at').notNull().default(sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`),
  },
  (table) => ({
    groupIdx: index('idx_users_group_id').on(table.groupId),
  }),
);

// ─── user_groups ─────────────────────────────────────────────────────────────

export const userGroups = mysqlTable('user_groups', {
  id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
  name: varchar('name', { length: 100 }).notNull().unique(),
  description: text('description'),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull().default(sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`),
});

// ─── apps ────────────────────────────────────────────────────────────────────

export const apps = mysqlTable('apps', {
  id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  ownerId: bigint('owner_id', { mode: 'number', unsigned: true }),
  status: mysqlEnum('status', ['active', 'disabled', 'quota_exceeded']).notNull().default('active'),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull().default(sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`),
});

// ─── api_keys ────────────────────────────────────────────────────────────────

export const apiKeys = mysqlTable(
  'api_keys',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    keySecret: varchar('key_secret', { length: 64 }).notNull().unique(),
    keyPrefix: varchar('key_prefix', { length: 20 }).notNull(),
    mode: mysqlEnum('mode', ['user', 'app', 'admin', 'dedicated']).notNull(),
    userId: bigint('user_id', { mode: 'number', unsigned: true }),
    appId: bigint('app_id', { mode: 'number', unsigned: true }),
    providerId: bigint('provider_id', { mode: 'number', unsigned: true }),
    upstreamApiKeyEnc: text('upstream_api_key_enc'),
    name: varchar('name', { length: 100 }).notNull(),
    permissions: json('permissions'),
    status: mysqlEnum('status', ['active', 'revoked', 'expired', 'quota_exceeded']).notNull().default('active'),
    // Nullable expiry. `.default(sql`NULL`)` makes drizzle emit DEFAULT NULL
    // (it omits the NULL keyword by default). This column was formerly a
    // TIMESTAMP, where explicit_defaults_for_timestamp=OFF implicitly made a
    // bare TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP — an unset expiry
    // silently became "now". Migration 0001 hand-wrote `NULL DEFAULT NULL` to
    // defeat that; migration 0005 changed the type to DATETIME, which that
    // setting doesn't affect, so nullable defaults work naturally now.
    expiresAt: datetime('expires_at').default(sql`NULL`),
    createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    keySecretIdx: index('idx_api_keys_key_secret').on(table.keySecret),
    modeUserIdIdx: index('idx_api_keys_mode_user_id').on(table.mode, table.userId),
    modeAppIdIdx: index('idx_api_keys_mode_app_id').on(table.mode, table.appId),
    providerIdIdx: index('idx_api_keys_provider_id').on(table.providerId),
  }),
);

// ─── app_users ───────────────────────────────────────────────────────────────

export const appUsers = mysqlTable(
  'app_users',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    appId: bigint('app_id', { mode: 'number', unsigned: true }).notNull(),
    externalUid: varchar('external_uid', { length: 255 }).notNull(),
    displayName: varchar('display_name', { length: 100 }),
    createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    appIdExternalUidUniq: uniqueIndex('idx_app_users_app_id_external_uid').on(
      table.appId,
      table.externalUid,
    ),
    appIdIdx: index('idx_app_users_app_id').on(table.appId),
  }),
);

// ─── features ─────────────────────────────────────────────────────────────────

export const features = mysqlTable(
  'features',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    appId: bigint('app_id', { mode: 'number', unsigned: true }).notNull(),
    featureId: varchar('feature_id', { length: 255 }).notNull(),
    displayName: varchar('display_name', { length: 100 }),
    createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    appIdFeatureIdUniq: uniqueIndex('idx_features_app_id_feature_id').on(
      table.appId,
      table.featureId,
    ),
    appIdIdx: index('idx_features_app_id').on(table.appId),
  }),
);

// ─── virtual_models ──────────────────────────────────────────────────────────

export const virtualModels = mysqlTable('virtual_models', {
  id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
  modelId: varchar('model_id', { length: 100 }).notNull().unique(),
  displayName: varchar('display_name', { length: 200 }).notNull(),
  provider: varchar('provider', { length: 50 }).notNull(),
  realModel: varchar('real_model', { length: 100 }).notNull(),
  fallbacks: json('fallbacks'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ─── providers ───────────────────────────────────────────────────────────────

export const providers = mysqlTable('providers', {
  id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
  name: varchar('name', { length: 50 }).notNull().unique(),
  apiType: mysqlEnum('api_type', ['openai', 'anthropic']).notNull().default('openai'),
  baseUrl: varchar('base_url', { length: 500 }).notNull(),
  apiKeyEnc: text('api_key_enc'),
  config: json('config'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ─── rate_limits ─────────────────────────────────────────────────────────────

export const rateLimits = mysqlTable(
  'rate_limits',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    targetType: mysqlEnum('target_type', ['global', 'app', 'user', 'api_key']).notNull(),
    targetId: bigint('target_id', { mode: 'number', unsigned: true }),
    rpm: int('rpm').notNull().default(60),
    qps: int('qps').notNull().default(10),
    dailyTokens: bigint('daily_tokens', { mode: 'number', unsigned: true }),
    monthlyTokens: bigint('monthly_tokens', { mode: 'number', unsigned: true }),
    createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: datetime('updated_at').notNull().default(sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`),
  },
  (table) => ({
    targetTypeTargetIdUniq: uniqueIndex('idx_rate_limits_target').on(
      table.targetType,
      table.targetId,
    ),
  }),
);

// ─── ua_policies ─────────────────────────────────────────────────────────────
// User-Agent allow/block lists per target (global / user / app / api_key).
// Patterns are regex source strings matched case-insensitively against the
// request's User-Agent header; mode 'block' denies a match, mode 'allow'
// requires a match. Levels stack: any block hit denies, any configured allow
// level must match (see src/services/ua-policy.ts).

export const uaPolicies = mysqlTable(
  'ua_policies',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    targetType: mysqlEnum('target_type', ['global', 'app', 'user', 'api_key']).notNull(),
    targetId: bigint('target_id', { mode: 'number', unsigned: true }),
    mode: mysqlEnum('mode', ['block', 'allow']).notNull(),
    patterns: json('patterns'),
    createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: datetime('updated_at').notNull().default(sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`),
  },
  (table) => ({
    targetTypeTargetIdUniq: uniqueIndex('idx_ua_policies_target').on(
      table.targetType,
      table.targetId,
    ),
  }),
);

// ─── usage_records ───────────────────────────────────────────────────────────

export const usageRecords = mysqlTable(
  'usage_records',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    recordTime: datetime('record_time').notNull(),
    apiKeyId: bigint('api_key_id', { mode: 'number', unsigned: true }).notNull(),
    appId: bigint('app_id', { mode: 'number', unsigned: true }),
    userId: bigint('user_id', { mode: 'number', unsigned: true }),
    model: varchar('model', { length: 100 }).notNull(),
    provider: varchar('provider', { length: 50 }).notNull(),
    promptTokens: bigint('prompt_tokens', { mode: 'number', unsigned: true }).notNull().default(0),
    completionTokens: bigint('completion_tokens', { mode: 'number', unsigned: true })
      .notNull()
      .default(0),
    totalTokens: bigint('total_tokens', { mode: 'number', unsigned: true }).notNull().default(0),
    // Anthropic prompt-cache breakdown. prompt_tokens holds the non-cached input
    // (Anthropic's input_tokens); cache_read/cache_creation are the cache hit/write
    // tokens Anthropic reports as SEPARATE fields not included in input_tokens.
    // OpenAI traffic leaves these 0 (its prompt_tokens already includes cached).
    // total_tokens = prompt + completion + cacheRead + cacheCreation across providers.
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number', unsigned: true }).notNull().default(0),
    cacheCreationTokens: bigint('cache_creation_tokens', { mode: 'number', unsigned: true }).notNull().default(0),
    requestCount: int('request_count').notNull().default(0),
    errorCount: int('error_count').notNull().default(0),
    // Reserved but unused: the gateway does not compute fees, so this stays 0.
    // Kept to avoid a destructive migration.
    costUsd: bigint('cost_usd', { mode: 'number', unsigned: true }).notNull().default(0),
    createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    // Quota-bucket uniqueness: trackUsage() does INSERT ... ON DUPLICATE KEY
    // UPDATE to aggregate usage per (api_key, hour, model, provider). Without a
    // unique key on those columns the UPDATE branch never fires and every
    // request inserts a new row (table bloat, request_count stuck at 1).
    bucketUniq: uniqueIndex('idx_usage_records_bucket').on(
      table.apiKeyId,
      table.recordTime,
      table.model,
      table.provider,
    ),
    apiKeyRecordTimeIdx: index('idx_usage_records_api_key_record_time').on(
      table.apiKeyId,
      table.recordTime,
    ),
    // Per-key per-model window aggregates (model-level quota precheck /
    // getUsageByModelForKey): the bucket index above has record_time BEFORE
    // model, so a time-range scan can't seek into one model — it reads every
    // row of the key in the window and filters. With model second, an
    // equality on (api_key_id, model) + range on record_time lands directly
    // on that model's rows. Scan size for a hot key drops from
    // hours × models × providers to hours × providers.
    apiKeyModelRecordTimeIdx: index('idx_usage_records_api_key_model_record_time').on(
      table.apiKeyId,
      table.model,
      table.recordTime,
    ),
    appRecordTimeIdx: index('idx_usage_records_app_record_time').on(
      table.appId,
      table.recordTime,
    ),
    userRecordTimeIdx: index('idx_usage_records_user_record_time').on(
      table.userId,
      table.recordTime,
    ),
  }),
);

// ─── request_logs ────────────────────────────────────────────────────────────

export const requestLogs = mysqlTable(
  'request_logs',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    requestId: varchar('request_id', { length: 36 }).notNull().unique(),
    apiKeyId: bigint('api_key_id', { mode: 'number', unsigned: true }).notNull(),
    appId: bigint('app_id', { mode: 'number', unsigned: true }),
    userId: bigint('user_id', { mode: 'number', unsigned: true }),
    appUserId: varchar('app_user_id', { length: 255 }),
    featureId: varchar('feature_id', { length: 255 }),
    model: varchar('model', { length: 100 }),
    provider: varchar('provider', { length: 50 }),
    statusCode: int('status_code'),
    latencyMs: int('latency_ms'),
    promptTokens: int('prompt_tokens'),
    completionTokens: int('completion_tokens'),
    // Anthropic prompt-cache breakdown per request (null when not reported).
    cacheReadTokens: int('cache_read_tokens'),
    cacheCreationTokens: int('cache_creation_tokens'),
    isStream: boolean('is_stream').notNull().default(false),
    errorMessage: text('error_message'),
    createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    createdAtIdx: index('idx_request_logs_created_at').on(table.createdAt),
  }),
);

// ─── request_details ─────────────────────────────────────────────────────────

export const requestDetails = mysqlTable(
  'request_details',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    requestId: varchar('request_id', { length: 36 }).notNull().unique(),
    apiKeyId: bigint('api_key_id', { mode: 'number', unsigned: true }).notNull(),
    requestMethod: varchar('request_method', { length: 10 }),
    requestPath: varchar('request_path', { length: 500 }),
    requestHeaders: json('request_headers'),
    requestBody: json('request_body'),
    responseStatus: int('response_status'),
    responseHeaders: json('response_headers'),
    responseBody: json('response_body'),
    streamChunks: longtext('stream_chunks'),
    streamChunkCount: int('stream_chunk_count'),
    clientIp: varchar('client_ip', { length: 45 }),
    userAgent: varchar('user_agent', { length: 500 }),
    latencyMs: int('latency_ms'),
    createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    // Log archive markers. archivedAt != NULL means this row's big fields were
    // nulled because a later, more complete request in the same agentic loop
    // session superseded it; mergedInto points at that successor's requestId.
    // See plans/fizzy-painting-rabin.md. Nullable (DEFAULT NULL via
    // .default(sql`NULL`)); same explicit-NULL history as expiresAt — formerly
    // TIMESTAMP, now DATETIME (migration 0005).
    archivedAt: datetime('archived_at').default(sql`NULL`),
    mergedInto: varchar('merged_into', { length: 36 }),
  },
  (table) => ({
    requestIdIdx: index('idx_request_details_request_id').on(table.requestId),
    apiKeyCreatedAtIdx: index('idx_request_details_api_key_created_at').on(
      table.apiKeyId,
      table.createdAt,
    ),
    createdAtIdx: index('idx_request_details_created_at').on(table.createdAt),
    // Archive scan: WHERE archived_at IS NULL AND created_at < cutoff.
    archivedCreatedAtIdx: index('idx_request_details_archived_created').on(
      table.archivedAt,
      table.createdAt,
    ),
  }),
);

// ─── admin_users ──────────────────────────────────────────────────────────────

export const adminUsers = mysqlTable('admin_users', {
  id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
  username: varchar('username', { length: 100 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  role: mysqlEnum('role', ['admin', 'super_admin']).notNull().default('admin'),
  status: mysqlEnum('status', ['active', 'disabled']).notNull().default('active'),
  // See api_keys.expiresAt — nullable; same explicit-NULL history, formerly
  // TIMESTAMP now DATETIME (migration 0005).
  lastLoginAt: datetime('last_login_at').default(sql`NULL`),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull().default(sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`),
});

// ─── system_settings ─────────────────────────────────────────────────────────

// Generic key-value store for runtime-configurable system settings (the admin
// "系统设置" page). Values are stored as strings and coerced on read. The first
// use is log retention — keys log.detailsRetentionDays / log.logsRetentionDays,
// read by runLogArchive with a fallback to the config/schema.ts defaults.
export const systemSettings = mysqlTable(
  'system_settings',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
    key: varchar('key', { length: 100 }).notNull(),
    value: text('value').notNull(),
    createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: datetime('updated_at').notNull().default(sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`),
  },
  (table) => ({
    keyUniq: uniqueIndex('idx_system_settings_key').on(table.key),
  }),
);

// ─── re-exports for convenience ──────────────────────────────────────────────

export const schema = {
  users,
  userGroups,
  apps,
  apiKeys,
  appUsers,
  features,
  virtualModels,
  providers,
  rateLimits,
  uaPolicies,
  usageRecords,
  requestLogs,
  requestDetails,
  adminUsers,
  systemSettings,
};

export type Schema = typeof schema;
