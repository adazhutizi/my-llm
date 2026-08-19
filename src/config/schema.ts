import { z } from 'zod';

// ── log archive block ────────────────────────────────────────────────────────
// Extracted to a named const so the parent schema can express "default to an
// empty object and let each field's own default fill in" in a zod v4-safe way:
// v4 narrowed `.default()`'s parameter type to the FULL output type, so
// `.default({})` no longer type-checks even though every field has a default.
// `{} as z.output<typeof archiveSchema>` preserves the v3 runtime behaviour
// (parse({}) materialises every field default) while satisfying v4's types.
// Log archive: collapse agentic loop sessions (Claude Code / Cursor) where each
// request's messages array accumulates the whole conversation. Keeps only the
// tail (most complete) request_details per session, nulling the big fields of
// the superseded prefixes. See plans/fizzy-painting-rabin.md.
const archiveSchema = z.object({
  enabled: z.boolean().default(true),
  // Only rows older than this many days are eligible for merging. Default
  // 0 = include the current day: agentic sessions (Claude Code / Cursor)
  // accumulate the whole conversation in every request, so even same-day
  // prefix requests are redundant once a later, more complete request in
  // the same session exists. planArchive's strict-prefix check guarantees
  // the tail (most complete) row always keeps its big fields — only the
  // superseded prefixes are nulled, so no conversation content is lost.
  // nonnegative (not positive) so 0 is admissible.
  retentionDays: z.number().int().nonnegative().default(0),
  // Archive window upper bound (days) — the retention period for
  // request_details (the heavy request/response payload table). Rows older
  // than now - maxAgeDays are NOT merged — the archive run physically DELETEs
  // them instead. Old detail rows no longer earn a content-level prefix
  // comparison, so deleting (vs merging) bounds per-run work and caps
  // request_details growth. Must be > retentionDays so the merge window
  // [now-maxAgeDays, now-retentionDays] is non-empty. Default 30 days.
  // Overridable at runtime from system_settings (key log.detailsRetentionDays)
  // via the admin "系统设置" page; this is only the fallback default.
  maxAgeDays: z.number().int().positive().default(30),
  // Retention period (days) for request_logs (the lightweight list/stats
  // table — no big payload fields). The archive run physically DELETEs
  // request_logs rows older than now - logsRetentionDays, alongside the
  // request_details purge. Defaults longer than maxAgeDays (180 vs 30) because
  // request_logs rows are small: keep the list/queryable history longer while
  // shedding the heavy payloads sooner. Overridable at runtime from
  // system_settings (key log.logsRetentionDays); this is the fallback default.
  logsRetentionDays: z.number().int().positive().default(180),
  // Adjacent requests farther apart than this are treated as different
  // sessions and never merged. Default 7 days: real agentic sessions
  // (Claude Code/Cursor) often resume across hours or even days, so a
  // short window would block the cross-day merges this feature exists to
  // collapse. Safety is unaffected — the strict-prefix check is the real
  // signal (independent sessions never share a message-history prefix),
  // this only bounds the pairwise scan window within a cluster.
  sessionTimeoutMin: z.number().int().positive().default(10080),
  // Hour of day in UTC (0-23) to run the daily merge. log-archive.ts gates on
  // getUTCHours() and the leader-lock key is the UTC date, so this MUST be UTC
  // — not local server time: pods in different TZs would otherwise compute
  // different "today"/hour values and split the lock across keys, letting the
  // archive run more than once per day. Default 20 = Beijing 04:00 (UTC+8),
  // i.e. the low-traffic window. Shift this UTC hour to move the local run time.
  runHour: z.number().int().min(0).max(23).default(20),
  // Rows fetched per archive scan page. KEPT SMALL on purpose. Each row's
  // request_body is the full request JSON and can exceed 1MB (Claude Code
  // agentic sessions carry large tool results / context), and a whole page
  // is materialized in the JS heap at once — mysql2 returns the batch in
  // full, then planArchive fingerprints every message (stripCacheControl's
  // deep copy + stableStringify build large transient strings per turn). A
  // large page therefore blows past the Node heap and crashes the gateway
  // mid-archive with "JavaScript heap out of memory" (observed at 5000).
  // At 200 even an all-1MB page peaks ~200MB, comfortably under the heap.
  // A conversation whose prefix chain straddles two pages merely defers its
  // merge to the next daily run — no data loss, since the strict-prefix
  // check is the real correctness signal, not the page grouping.
  batchSize: z.number().int().positive().default(200),
});

// ── Redis block ───────────────────────────────────────────────────────────────
// Extracted for the same v4 `.default({})` reason as archiveSchema above.
// Redis：多实例必需（限流令牌桶 / 配额缓存 / 归档选主锁 / 迁移锁共享状态）。
// 强依赖——生产必须配 REDIS_URL（+ REDIS_PASSWORD），Redis 不可达启动即 exit(1)。
const redisSchema = z.object({
  url: z.string().default('redis://localhost:6379'),
  username: z.string().default(''), // Redis 6+ ACL 用户名；留空走经典 AUTH
  password: z.string().default(''), // 生产 Redis 通常要求密码
  keyPrefix: z.string().default('llmgw:'),
  // 断连时排队命令的最大重试次数。设 1 让 Redis 不可达时命令快速 reject（配合
  // commandTimeoutMs 实现 fail-open），而非长时间排队阻塞请求。
  maxRetriesPerRequest: z.number().int().min(0).default(1),
  // 已发出命令的超时（ms）。maxRetriesPerRequest 只管断连排队、不管慢响应——
  // 不配此项则 Redis 卡顿会拖垮所有限流请求，fail-open 失效。
  commandTimeoutMs: z.number().int().positive().default(1000),
  connectTimeoutMs: z.number().int().positive().default(2000),
});

export const configSchema = z.object({
  port: z.number().default(3000),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),

  db: z.object({
    host: z.string().default('localhost'),
    port: z.number().default(3306),
    user: z.string().default('root'),
    password: z.string(),
    database: z.string().default('llm_gateway'),
  }),

  log: z.object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    archive: archiveSchema.default({} as z.output<typeof archiveSchema>),
  }),

  jwt: z.object({
    secret: z.string().min(16),
    expiresIn: z.number().default(86400),
    // Sliding renewal threshold (seconds). When a JWT's remaining lifetime drops
    // below this, admin requests mint a fresh token via the X-Renewed-Token
    // response header so active admins aren't forced to re-login. NB: if you
    // change `expiresIn`, sync this manually (default is expiresIn / 3 ≈ 8h).
    renewThreshold: z.number().int().positive().default(28800),
  }),

  redis: redisSchema.default({} as z.output<typeof redisSchema>),
});

export type Config = z.infer<typeof configSchema>;
