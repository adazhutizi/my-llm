// ─────────────────────────────────────────────────────────────────────────────
// Queryable-table metadata — the single source of truth for the `query_table`
// tool. One constant drives FOUR concerns at once:
//   1. the Chinese description the model reads to pick columns,
//   2. the runtime table/column whitelist (the actual SQL-injection boundary),
//   3. the deterministic result coercion (by declared column `kind`),
//   4. the `*` default expansion (every column minus sensitive/heavy).
//
// The per-column `desc` is ALSO the single source of truth for DB COLUMN
// COMMENTs: src/db/column-comments.ts derives from here (14 queryable tables,
// + hand-maintained admin_users), scripts/apply-comments.ts injects those as
// MySQL COMMENTs, and scripts/check-schema-sync.ts (run by `pnpm db:gen`)
// guards the column list here against drift from src/db/schema.ts.
//
// SECURITY: every identifier (table/column/alias) that reaches the SQL
// *structure* is validated against the sets derived here. `sql.identifier()`
// does NOT escape backticks (drizzle docs: "no protection against SQL
// injection, validate input beforehand"), so this whitelist IS the boundary.
// Keep column names byte-identical to src/db/schema.ts snake_case names — a
// typo here either rejects a legal query or, worse, lets a bad one through.
// `admin_users` is deliberately ABSENT (password_hash has no analysis value;
// excluding the whole table is safer than per-column masking).
// ─────────────────────────────────────────────────────────────────────────────

export type ColKind =
  | 'int'
  | 'bigint'
  | 'decimal'
  | 'string'
  | 'text'
  | 'json'
  | 'datetime'
  | 'enum'
  | 'bool';

export interface ColumnMeta {
  /** snake_case DB column name — must match src/db/schema.ts exactly. */
  name: string;
  kind: ColKind;
  /** Chinese description shown to the model. */
  desc: string;
  /** Sensitive column — SELECT or filter on it rejects the whole query with {error}. */
  sensitive?: boolean;
  /** Heavy column (large payload) — excluded from `*` default; truncated when explicitly selected. */
  heavy?: boolean;
  /** Allowed values for enum columns (used to validate filter values). */
  enumValues?: readonly string[];
}

export interface TableMeta {
  name: string;
  desc: string;
  columns: readonly ColumnMeta[];
}

export const QUERYABLE_TABLES: readonly TableMeta[] = [
  {
    name: 'usage_records',
    desc: '按小时聚合的用量桶（统计表，每个 (api_key, 整点, model, provider) 一行；做 SUM/COUNT 聚合用，非逐请求）',
    columns: [
      { name: 'id', kind: 'bigint', desc: '行 id' },
      { name: 'record_time', kind: 'datetime', desc: '桶时间（整点 UTC 壁钟）' },
      { name: 'api_key_id', kind: 'bigint', desc: 'API 密钥 id' },
      { name: 'app_id', kind: 'bigint', desc: '应用 id，可空' },
      { name: 'user_id', kind: 'bigint', desc: '用户 id，可空' },
      { name: 'model', kind: 'string', desc: '虚拟模型 id（客户端请求体里的 model）' },
      { name: 'provider', kind: 'string', desc: '服务商名' },
      { name: 'prompt_tokens', kind: 'bigint', desc: '非缓存输入 token' },
      { name: 'completion_tokens', kind: 'bigint', desc: '输出 token' },
      { name: 'total_tokens', kind: 'bigint', desc: '总 token（含缓存读/写）' },
      { name: 'cache_read_tokens', kind: 'bigint', desc: '缓存命中 token' },
      { name: 'cache_creation_tokens', kind: 'bigint', desc: '缓存写入 token' },
      { name: 'request_count', kind: 'int', desc: '该桶请求数' },
      { name: 'error_count', kind: 'int', desc: '该桶错误数' },
      { name: 'cost_usd', kind: 'bigint', desc: '费用（保留字段，当前恒 0，网关不算费）' },
      { name: 'created_at', kind: 'datetime', desc: '行创建时间' },
    ],
  },
  {
    name: 'request_logs',
    desc: '每条请求一行（轻量列表/统计表；headers/body 等大字段在 request_details）',
    columns: [
      { name: 'id', kind: 'bigint', desc: '行 id' },
      { name: 'request_id', kind: 'string', desc: '请求 uuid（关联 request_details.request_id）' },
      { name: 'api_key_id', kind: 'bigint', desc: 'API 密钥 id' },
      { name: 'app_id', kind: 'bigint', desc: '应用 id，可空' },
      { name: 'user_id', kind: 'bigint', desc: '用户 id，可空' },
      { name: 'app_user_id', kind: 'string', desc: '终端用户标识，可空' },
      { name: 'feature_id', kind: 'string', desc: '功能场景标识，可空' },
      { name: 'model', kind: 'string', desc: '虚拟模型 id，可空' },
      { name: 'provider', kind: 'string', desc: '服务商名，可空' },
      { name: 'status_code', kind: 'int', desc: 'HTTP 状态码，可空' },
      { name: 'latency_ms', kind: 'int', desc: '延迟毫秒，可空' },
      { name: 'prompt_tokens', kind: 'int', desc: '输入 token，可空' },
      { name: 'completion_tokens', kind: 'int', desc: '输出 token，可空' },
      { name: 'cache_read_tokens', kind: 'int', desc: '缓存命中 token，可空' },
      { name: 'cache_creation_tokens', kind: 'int', desc: '缓存写入 token，可空' },
      { name: 'is_stream', kind: 'bool', desc: '是否流式请求' },
      { name: 'error_message', kind: 'text', desc: '错误信息，可空' },
      { name: 'created_at', kind: 'datetime', desc: '请求时间（UTC）' },
    ],
  },
  {
    name: 'request_details',
    desc: '每条请求的明细（headers/body 等；按保留期定期清理；敏感与大字段列默认不查）',
    columns: [
      { name: 'id', kind: 'bigint', desc: '行 id' },
      { name: 'request_id', kind: 'string', desc: '请求 uuid（关联 request_logs.request_id）' },
      { name: 'api_key_id', kind: 'bigint', desc: 'API 密钥 id' },
      { name: 'request_method', kind: 'string', desc: 'HTTP 方法，可空' },
      { name: 'request_path', kind: 'string', desc: '请求路径，可空' },
      { name: 'request_headers', kind: 'json', sensitive: true, desc: '请求头（含 JWT/x-api-key，禁查）' },
      { name: 'request_body', kind: 'json', heavy: true, desc: '请求体（可达 1MB+；显式查时截断）' },
      { name: 'response_status', kind: 'int', desc: '上游响应状态码，可空' },
      { name: 'response_headers', kind: 'json', sensitive: true, desc: '响应头（可能含续签 JWT，禁查）' },
      { name: 'response_body', kind: 'json', heavy: true, desc: '响应体（可达 1MB+；显式查时截断）' },
      { name: 'stream_chunks', kind: 'text', heavy: true, desc: 'SSE 分块拼接（可达数 MB；显式查时截断）' },
      { name: 'stream_chunk_count', kind: 'int', desc: '流式分块数，可空' },
      { name: 'client_ip', kind: 'string', sensitive: true, desc: '客户端 IP（个人信息，禁查）' },
      { name: 'user_agent', kind: 'string', desc: 'User-Agent，可空' },
      { name: 'latency_ms', kind: 'int', desc: '延迟毫秒，可空' },
      { name: 'created_at', kind: 'datetime', desc: '请求时间（UTC）' },
      { name: 'archived_at', kind: 'datetime', desc: '归档时间（被同会话后续请求覆盖后置位），可空' },
      { name: 'merged_into', kind: 'string', desc: '归并指向的后续 request_id，可空' },
    ],
  },
  {
    name: 'virtual_models',
    desc: '虚拟模型定义（model_id → 真实 provider+model 映射）',
    columns: [
      { name: 'id', kind: 'bigint', desc: '行 id' },
      { name: 'model_id', kind: 'string', desc: '虚拟模型 id（用户面）' },
      { name: 'display_name', kind: 'string', desc: '展示名' },
      { name: 'provider', kind: 'string', desc: '服务商名' },
      { name: 'real_model', kind: 'string', desc: '上游真实模型名' },
      { name: 'fallbacks', kind: 'json', desc: '回退模型链，可空' },
      { name: 'is_active', kind: 'bool', desc: '是否启用' },
      { name: 'created_at', kind: 'datetime', desc: '创建时间' },
    ],
  },
  {
    name: 'providers',
    desc: '上游服务商配置',
    columns: [
      { name: 'id', kind: 'bigint', desc: '行 id' },
      { name: 'name', kind: 'string', desc: '服务商名（唯一）' },
      { name: 'api_type', kind: 'enum', enumValues: ['openai', 'anthropic'], desc: '协议类型' },
      { name: 'base_url', kind: 'string', desc: '上游 base URL' },
      { name: 'api_key_enc', kind: 'text', sensitive: true, desc: '上游 key（明文存储，禁查）' },
      { name: 'config', kind: 'json', desc: '服务商扩展配置，可空' },
      { name: 'is_active', kind: 'bool', desc: '是否启用' },
      { name: 'created_at', kind: 'datetime', desc: '创建时间' },
    ],
  },
  {
    name: 'api_keys',
    desc: '网关 API 密钥（敏感列禁查：key_secret / upstream_api_key_enc）',
    columns: [
      { name: 'id', kind: 'bigint', desc: '行 id' },
      { name: 'key_secret', kind: 'string', sensitive: true, desc: '明文 API key，禁查' },
      { name: 'key_prefix', kind: 'string', desc: 'key 前缀（脱敏展示用）' },
      { name: 'mode', kind: 'enum', enumValues: ['user', 'app', 'admin', 'dedicated'], desc: '密钥模式' },
      { name: 'user_id', kind: 'bigint', desc: '所属用户 id（user 模式），可空' },
      { name: 'app_id', kind: 'bigint', desc: '所属应用 id（app 模式），可空' },
      { name: 'provider_id', kind: 'bigint', desc: '绑定服务商 id（dedicated 模式），可空' },
      { name: 'upstream_api_key_enc', kind: 'text', sensitive: true, desc: '上游 key（明文存储，禁查）' },
      { name: 'name', kind: 'string', desc: '密钥名称' },
      { name: 'permissions', kind: 'json', desc: '权限配置（含 modelPolicy：按 key 的可用模型名单与按模型日/月 token 配额），可空' },
      {
        name: 'status',
        kind: 'enum',
        enumValues: ['active', 'revoked', 'expired', 'quota_exceeded'],
        desc: '状态',
      },
      { name: 'expires_at', kind: 'datetime', desc: '过期时间，可空' },
      { name: 'created_at', kind: 'datetime', desc: '创建时间' },
    ],
  },
  {
    name: 'rate_limits',
    desc: '速率与配额规则（按 target_type + target_id 配置）',
    columns: [
      { name: 'id', kind: 'bigint', desc: '行 id' },
      { name: 'target_type', kind: 'enum', enumValues: ['global', 'app', 'user', 'api_key'], desc: '限流对象类型' },
      { name: 'target_id', kind: 'bigint', desc: '对象 id（global 时为空）' },
      { name: 'rpm', kind: 'int', desc: '每分钟请求数上限' },
      { name: 'qps', kind: 'int', desc: '每秒请求数上限' },
      { name: 'daily_tokens', kind: 'bigint', desc: '日 token 配额，可空' },
      { name: 'monthly_tokens', kind: 'bigint', desc: '月 token 配额，可空' },
      { name: 'created_at', kind: 'datetime', desc: '创建时间' },
      { name: 'updated_at', kind: 'datetime', desc: '更新时间' },
    ],
  },
  {
    name: 'ua_policies',
    desc: 'User-Agent 黑白名单规则（按 target_type + target_id 配置；block=命中正则即拒绝，allow=必须命中；四级叠加判定）',
    columns: [
      { name: 'id', kind: 'bigint', desc: '行 id' },
      { name: 'target_type', kind: 'enum', enumValues: ['global', 'app', 'user', 'api_key'], desc: '名单对象类型' },
      { name: 'target_id', kind: 'bigint', desc: '对象 id（global 时为空）' },
      { name: 'mode', kind: 'enum', enumValues: ['block', 'allow'], desc: '名单模式（block=黑名单，allow=白名单）' },
      { name: 'patterns', kind: 'json', desc: '正则表达式字符串数组（匹配 User-Agent，不区分大小写）' },
      { name: 'created_at', kind: 'datetime', desc: '创建时间' },
      { name: 'updated_at', kind: 'datetime', desc: '更新时间' },
    ],
  },
  {
    name: 'users',
    desc: '网关用户',
    columns: [
      { name: 'id', kind: 'bigint', desc: '行 id' },
      { name: 'username', kind: 'string', desc: '用户名（唯一）' },
      { name: 'identifier', kind: 'string', desc: '用户标识（唯一）' },
      { name: 'status', kind: 'enum', enumValues: ['active', 'disabled', 'quota_exceeded'], desc: '状态' },
      { name: 'group_id', kind: 'bigint', desc: '所属用户组 id，可空' },
      { name: 'created_at', kind: 'datetime', desc: '创建时间' },
      { name: 'updated_at', kind: 'datetime', desc: '更新时间' },
    ],
  },
  {
    name: 'user_groups',
    desc: '用户组',
    columns: [
      { name: 'id', kind: 'bigint', desc: '行 id' },
      { name: 'name', kind: 'string', desc: '组名（唯一）' },
      { name: 'description', kind: 'text', desc: '描述，可空' },
      { name: 'created_at', kind: 'datetime', desc: '创建时间' },
      { name: 'updated_at', kind: 'datetime', desc: '更新时间' },
    ],
  },
  {
    name: 'apps',
    desc: '应用',
    columns: [
      { name: 'id', kind: 'bigint', desc: '行 id' },
      { name: 'name', kind: 'string', desc: '应用名' },
      { name: 'description', kind: 'text', desc: '描述，可空' },
      { name: 'owner_id', kind: 'bigint', desc: '所有者用户 id，可空' },
      { name: 'status', kind: 'enum', enumValues: ['active', 'disabled', 'quota_exceeded'], desc: '状态' },
      { name: 'created_at', kind: 'datetime', desc: '创建时间' },
      { name: 'updated_at', kind: 'datetime', desc: '更新时间' },
    ],
  },
  {
    name: 'app_users',
    desc: '应用终端用户（app 模式下按 X-App-User-Id 自动创建）',
    columns: [
      { name: 'id', kind: 'bigint', desc: '行 id' },
      { name: 'app_id', kind: 'bigint', desc: '所属应用 id' },
      { name: 'external_uid', kind: 'string', desc: '终端用户外部标识' },
      { name: 'display_name', kind: 'string', desc: '展示名，可空' },
      { name: 'created_at', kind: 'datetime', desc: '创建时间' },
    ],
  },
  {
    name: 'features',
    desc: '应用功能维度（X-Feature-Id 场景标识）',
    columns: [
      { name: 'id', kind: 'bigint', desc: '行 id' },
      { name: 'app_id', kind: 'bigint', desc: '所属应用 id' },
      { name: 'feature_id', kind: 'string', desc: '功能标识' },
      { name: 'display_name', kind: 'string', desc: '展示名，可空' },
      { name: 'created_at', kind: 'datetime', desc: '创建时间' },
    ],
  },
  {
    name: 'system_settings',
    desc: '系统设置键值表（运行时配置）',
    columns: [
      { name: 'id', kind: 'bigint', desc: '行 id' },
      { name: 'key', kind: 'string', desc: '配置键（唯一）' },
      { name: 'value', kind: 'text', desc: '配置值（字符串）' },
      { name: 'created_at', kind: 'datetime', desc: '创建时间' },
      { name: 'updated_at', kind: 'datetime', desc: '更新时间' },
    ],
  },
];

// ─── Derived indices (computed once at module load) ──────────────────────────

export const TABLE_NAMES = new Set(QUERYABLE_TABLES.map((t) => t.name));

export const TABLE_BY_NAME = new Map(QUERYABLE_TABLES.map((t) => [t.name, t]));

export const COLUMN_NAMES_BY_TABLE = new Map(
  QUERYABLE_TABLES.map((t) => [t.name, new Set(t.columns.map((c) => c.name))]),
);

export const COLUMN_META_BY_TABLE = new Map(
  QUERYABLE_TABLES.map((t) => [t.name, new Map(t.columns.map((c) => [c.name, c]))]),
);

export const SENSITIVE_BY_TABLE = new Map(
  QUERYABLE_TABLES.map((t) => [
    t.name,
    new Set(t.columns.filter((c) => c.sensitive).map((c) => c.name)),
  ]),
);

export const HEAVY_BY_TABLE = new Map(
  QUERYABLE_TABLES.map((t) => [
    t.name,
    new Set(t.columns.filter((c) => c.heavy).map((c) => c.name)),
  ]),
);

/**
 * Compact Chinese table/column summary embedded into the `query_table` tool
 * description so the model can usually pick correct columns on the first call.
 * Sensitive columns are listed by name but marked 禁查 so the model avoids them
 * rather than discovering the rejection at runtime.
 */
export function buildQueryTableDescription(): string {
  const lines: string[] = ['可查询的表与列（仅这些表/列允许；敏感列禁查，时间传 ISO 8601 UTC）：'];
  for (const t of QUERYABLE_TABLES) {
    lines.push(`\n■ ${t.name} —— ${t.desc}`);
    const cols = t.columns.map((c) => {
      const tag = c.sensitive ? '（禁查）' : c.heavy ? '（大字段，默认不选）' : '';
      return `  · ${c.name} [${c.kind}]${tag} ${c.desc}`;
    });
    lines.push(...cols);
  }
  lines.push(
    '\n支持 INNER/LEFT JOIN 跨表关联（关联必须是 list_queryable_tables 列出的白名单路径）；JOIN 时每个列都要指定所属表，形如 {table, column}。',
  );
  return lines.join('\n');
}

// ─── JOIN relations (whitelist for cross-table queries) ──────────────────────
// The project has NO DB-level foreign keys (drizzle "raw" mode, no relations()),
// so legal JOINs must be declared here. This list IS the boundary that prevents
// arbitrary cross joins — without it the model could mint cartesian products or
// nonsense pairings. Each relation is symmetric: findJoinRelation() matches
// both directions. Polymorphic rows (rate_limits, ua_policies — tables whose
// target_id points at different tables depending on a target_type column)
// carry `polymorphic`; by convention the POLYMORPHIC TABLE IS ALWAYS SIDE `a`
// (the typeColumn lives there), and the typeValue comes from THIS constant
// (never from model input) and is emitted as a bound param.
// Relations needing composite keys (request_logs.feature_id → features) or
// self-joins (request_details.merged_into) are deliberately omitted.
export interface JoinRelation {
  a: string;
  b: string;
  aCol: string;
  bCol: string;
  polymorphic?: { typeColumn: string; typeValue: string };
  desc: string;
}

export const JOIN_RELATIONS: readonly JoinRelation[] = [
  // ── numeric foreign keys ──
  { a: 'usage_records', aCol: 'api_key_id', b: 'api_keys', bCol: 'id', desc: '用量桶所属 API 密钥' },
  { a: 'usage_records', aCol: 'user_id', b: 'users', bCol: 'id', desc: '用量桶所属用户' },
  { a: 'usage_records', aCol: 'app_id', b: 'apps', bCol: 'id', desc: '用量桶所属应用' },
  { a: 'request_logs', aCol: 'api_key_id', b: 'api_keys', bCol: 'id', desc: '请求所属 API 密钥' },
  { a: 'request_logs', aCol: 'user_id', b: 'users', bCol: 'id', desc: '请求所属用户' },
  { a: 'request_logs', aCol: 'app_id', b: 'apps', bCol: 'id', desc: '请求所属应用' },
  { a: 'request_logs', aCol: 'request_id', b: 'request_details', bCol: 'request_id', desc: '请求明细（UUID 字符串关联）' },
  { a: 'request_details', aCol: 'api_key_id', b: 'api_keys', bCol: 'id', desc: '请求明细所属 API 密钥' },
  { a: 'api_keys', aCol: 'user_id', b: 'users', bCol: 'id', desc: '密钥所属用户（user 模式）' },
  { a: 'api_keys', aCol: 'app_id', b: 'apps', bCol: 'id', desc: '密钥所属应用（app 模式）' },
  { a: 'api_keys', aCol: 'provider_id', b: 'providers', bCol: 'id', desc: '密钥绑定服务商（dedicated 模式）' },
  { a: 'users', aCol: 'group_id', b: 'user_groups', bCol: 'id', desc: '用户所属用户组' },
  { a: 'apps', aCol: 'owner_id', b: 'users', bCol: 'id', desc: '应用所有者' },
  { a: 'app_users', aCol: 'app_id', b: 'apps', bCol: 'id', desc: '终端用户所属应用' },
  { a: 'features', aCol: 'app_id', b: 'apps', bCol: 'id', desc: '功能维度所属应用' },
  // ── string-name associations (NOT id; value matches a unique string column) ──
  { a: 'usage_records', aCol: 'model', b: 'virtual_models', bCol: 'model_id', desc: '用量桶的虚拟模型名 → 虚拟模型定义' },
  { a: 'usage_records', aCol: 'provider', b: 'providers', bCol: 'name', desc: '用量桶的服务商名 → 服务商配置' },
  { a: 'request_logs', aCol: 'model', b: 'virtual_models', bCol: 'model_id', desc: '请求的虚拟模型名 → 虚拟模型定义' },
  { a: 'request_logs', aCol: 'provider', b: 'providers', bCol: 'name', desc: '请求的服务商名 → 服务商配置' },
  // ── polymorphic rate_limits (target_type column always on the rate_limits side) ──
  { a: 'rate_limits', aCol: 'target_id', b: 'api_keys', bCol: 'id', polymorphic: { typeColumn: 'target_type', typeValue: 'api_key' }, desc: '密钥级配额规则' },
  { a: 'rate_limits', aCol: 'target_id', b: 'users', bCol: 'id', polymorphic: { typeColumn: 'target_type', typeValue: 'user' }, desc: '用户级配额规则' },
  { a: 'rate_limits', aCol: 'target_id', b: 'apps', bCol: 'id', polymorphic: { typeColumn: 'target_type', typeValue: 'app' }, desc: '应用级配额规则' },
  // ── polymorphic ua_policies (same shape as rate_limits above) ──
  { a: 'ua_policies', aCol: 'target_id', b: 'api_keys', bCol: 'id', polymorphic: { typeColumn: 'target_type', typeValue: 'api_key' }, desc: '密钥级 UA 名单' },
  { a: 'ua_policies', aCol: 'target_id', b: 'users', bCol: 'id', polymorphic: { typeColumn: 'target_type', typeValue: 'user' }, desc: '用户级 UA 名单' },
  { a: 'ua_policies', aCol: 'target_id', b: 'apps', bCol: 'id', polymorphic: { typeColumn: 'target_type', typeValue: 'app' }, desc: '应用级 UA 名单' },
];

/**
 * Look up a declared join relation in EITHER direction. Returns the matched
 * relation plus which side (if any) is the polymorphic table (rate_limits /
 * ua_policies — carries a target_type discriminator), so the SQL builder knows
 * where to pin the target_type condition. null when the pair isn't
 * whitelisted — callers reject the query.
 */
export function findJoinRelation(
  from: string,
  to: string,
  fromCol: string,
  toCol: string,
): { relation: JoinRelation; polymorphicSide: 'from' | 'to' | null } | null {
  for (const r of JOIN_RELATIONS) {
    // forward: from=r.a, to=r.b
    if (r.a === from && r.b === to && r.aCol === fromCol && r.bCol === toCol) {
      return { relation: r, polymorphicSide: polymorphicSideOf(r, true) };
    }
    // reverse: from=r.b, to=r.a
    if (r.a === to && r.b === from && r.aCol === toCol && r.bCol === fromCol) {
      return { relation: r, polymorphicSide: polymorphicSideOf(r, false) };
    }
  }
  return null;
}

// By convention the polymorphic table is side `a` of the relation (the
// typeColumn lives there), so forward → 'from', reverse → 'to'. Kept as a
// function (not inlined) to document the convention next to the data.
function polymorphicSideOf(r: JoinRelation, forward: boolean): 'from' | 'to' | null {
  if (!r.polymorphic) return null;
  return forward ? 'from' : 'to';
}

/**
 * Human-readable join-path strings for list_queryable_tables, generated from
 * the single source of truth above (no hand-maintained duplicate list).
 * Polymorphic rows annotate the required target_type value.
 */
export function describeJoinPaths(): string[] {
  return JOIN_RELATIONS.map((r) => {
    const arrow = r.polymorphic
      ? `${r.a}.${r.aCol}（target_type='${r.polymorphic.typeValue}'）→ ${r.b}.${r.bCol}`
      : `${r.a}.${r.aCol} → ${r.b}.${r.bCol}`;
    return `${arrow}　${r.desc}`;
  });
}
