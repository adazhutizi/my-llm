// ── Common ────────────────────────────────────────────────────────────────

export interface ApiError {
  message: string;
  status: number;
}

export interface UsageSummary {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCacheReadTokens?: number;
  totalCacheCreationTokens?: number;
  totalTokens: number;
  totalRequests: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  summary?: UsageSummary;
}

// ── Dashboard / Stats ─────────────────────────────────────────────────────

export interface DashboardStats {
  // 主值统一近 30 天口径（与「总请求数」「总 Token 数」卡片一致），副标题带今日
  totalRequests: number;
  totalTokens: number;
  errorRate: number;
  requestsToday: number;
  tokensToday: number;
  cacheTokens30d?: number;
  cacheTokensToday?: number;
  errorRateToday?: number;
}

export interface UsagePoint {
  time: string;
  requests: number;
  tokens: number;
  cacheTokens?: number;
}

// ── API Keys ──────────────────────────────────────────────────────────────

// ── Per-key model policy (lives inside api_keys.permissions JSON) ──────────

export interface ModelLimit {
  dailyTokens?: number | null;
  monthlyTokens?: number | null;
}

export interface ModelPolicy {
  mode: 'all' | 'allow' | 'block';
  models: string[];
  limits?: Record<string, ModelLimit>;
}

export interface ApiKey {
  id: number;
  keyPrefix: string;
  mode: 'user' | 'app' | 'admin' | 'dedicated';
  userId: number | null;
  appId: number | null;
  providerId: number | null;
  name: string;
  status: 'active' | 'revoked' | 'expired' | 'quota_exceeded';
  expiresAt: string | null;
  createdAt: string;
  keySecret?: string;
  permissions?: { modelPolicy?: ModelPolicy } | null;
  provider?: { id: number; name: string } | null;
  user?: { id: number; username: string } | null;
  app?: { id: number; name: string } | null;
  borrow?: ApiKeyBorrow | null;
}

export interface CreateApiKeyRequest {
  mode: 'user' | 'app' | 'admin' | 'dedicated';
  name: string;
  userId?: number;
  appId?: number;
  expiresAt?: string;
  providerId?: number;
  upstreamApiKey?: string;
  permissions?: { modelPolicy?: ModelPolicy } | null;
}

export interface CreateApiKeyResponse {
  plainText: string;
  record: ApiKey;
}

export interface UpdateApiKeyRequest {
  name?: string;
  expiresAt?: string | null;
  providerId?: number;
  upstreamApiKey?: string;
  permissions?: { modelPolicy?: ModelPolicy } | null;
}

/** 一对一 key 的上游借调状态（admin 列表/详情返回，不含借来 key 的明文）。 */
export interface ApiKeyBorrow {
  /** 进行中（已到开始时间且未到期）。 */
  active: boolean;
  /** 已预约未开始（开始时间在未来）。 */
  scheduled: boolean;
  /** 到期时间已过（auth 惰性恢复会清除，或手动还原）。 */
  expired: boolean;
  /** 调用模式：passthrough=原样透传（从密钥借）；provider=走 Provider 管线（手动指定）。 */
  mode: 'passthrough' | 'provider';
  providerId: number;
  providerName: string | null;
  /** 来源一对一密钥（从密钥借时展示「借自谁」；手动指定为 null）。 */
  fromKeyId: number | null;
  fromKeyName: string | null;
  startedAt: string | null;
  expiresAt: string | null;
  note: string | null;
}

export interface BorrowUpstreamRequest {
  /** 从另一个一对一 key 借（复制其当前生效凭证快照）。 */
  sourceKeyId?: number;
  /** 来源生效服务商与当前密钥绑定的服务商不同时须显式传 true（默认仅同服务商）。 */
  allowCrossProvider?: boolean;
  /** 手动指定：providerId 必填；upstreamApiKey 留空则用该服务商的默认密钥。 */
  providerId?: number;
  upstreamApiKey?: string;
  /** 借调开始时间（ISO），缺省 = 立即开始；可预约未来时刻。 */
  startAt?: string | null;
  /** 借调到期时间（ISO），null/缺省 = 不限期直到手动还原。 */
  expiresAt?: string | null;
  note?: string;
}

// ── Users ─────────────────────────────────────────────────────────────────

export interface User {
  id: number;
  username: string;
  identifier: string;
  status: 'active' | 'disabled' | 'quota_exceeded';
  // Optional group membership. null = ungrouped. Always present on list/detail.
  groupId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserGroup {
  id: number;
  name: string;
  description: string | null;
  // Present on list responses (backend LEFT JOIN count); absent on the object
  // returned by create/update (backend returns the bare row). Optional so both
  // shapes satisfy this type — UI treats undefined as 0.
  memberCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminUser {
  id: number;
  username: string;
  role: 'admin' | 'super_admin';
  status: 'active' | 'disabled';
  lastLoginAt: string | null;
  createdAt: string;
}

export interface CreateAdminRequest {
  username: string;
  password?: string;
  role: 'admin' | 'super_admin';
}

// ── Apps ──────────────────────────────────────────────────────────────────

export interface App {
  id: number;
  name: string;
  description: string | null;
  ownerId: number | null;
  status: 'active' | 'disabled' | 'quota_exceeded';
  createdAt: string;
  updatedAt: string;
}

export interface AppUser {
  id: number;
  externalUid: string;
  displayName: string | null;
}

export interface Feature {
  id: number;
  appId: number;
  featureId: string;
  displayName: string | null;
  createdAt: string;
}

export interface AppUserUsage {
  appId: number | undefined;
  appUserId: string;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCacheReadTokens?: number;
  totalCacheCreationTokens?: number;
  totalTokens: number;
  totalRequests: number;
}

export interface FeatureUsage {
  appId: number | undefined;
  featureId: string;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCacheReadTokens?: number;
  totalCacheCreationTokens?: number;
  totalTokens: number;
  totalRequests: number;
}

// ── Virtual Models ────────────────────────────────────────────────────────

export interface VirtualModel {
  id: number;
  modelId: string;
  displayName: string;
  provider: string;
  realModel: string;
  fallbacks: string[] | null;
  isActive: boolean;
  createdAt: string;
}

// ── Providers ─────────────────────────────────────────────────────────────

export interface Provider {
  id: number;
  name: string;
  apiType: 'openai' | 'anthropic';
  baseUrl: string;
  isActive: boolean;
  config: Record<string, unknown> | null;
  createdAt: string;
  /** 后端列表返回全行（含密钥明文）；借调对话框用它判断能否留空借默认密钥。 */
  apiKeyEnc?: string | null;
}

// ── Request Logs ──────────────────────────────────────────────────────────

export interface RequestLog {
  id: number;
  requestId: string;
  apiKeyId: number;
  appId: number | null;
  userId: number | null;
  appUserId: string | null;
  featureId: string | null;
  model: string | null;
  provider: string | null;
  statusCode: number | null;
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  isStream: boolean;
  errorMessage: string | null;
  createdAt: string;
  archivedAt?: string | null;
  // requestId of the complete successor this row was merged into (null unless
  // archived_at is set). Used to draw a merge arrow in the logs list.
  mergedInto?: string | null;
  // Request path (from request_details via the list's LEFT JOIN). Null when
  // the details row was purged. Shown in the list's "请求路径" column.
  requestPath?: string | null;
  // User-Agent (from request_details via the list's LEFT JOIN). Null when the
  // details row was purged. Shown in the list's "UA" column.
  userAgent?: string | null;
}

export interface RequestDetail {
  id: number;
  requestId: string;
  requestMethod: string | null;
  requestPath: string | null;
  requestHeaders: Record<string, string> | null;
  requestBody: unknown;
  responseStatus: number | null;
  responseHeaders: Record<string, string> | null;
  responseBody: unknown;
  streamChunks: string | null;
  streamChunkCount: number | null;
  clientIp: string | null;
  userAgent: string | null;
  latencyMs: number | null;
  createdAt: string;
  // Log archive markers — present when this row was merged into a more complete
  // successor (big fields nulled). archivedAt != null means superseded.
  archivedAt?: string | null;
  mergedInto?: string | null;
  // Cached AI summary (null when none generated yet). Attached by the detail
  // endpoint so the dialog renders it without a second round-trip.
  aiSummary?: LogSummaryResult | null;
}

export interface LogSummaryMeta {
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  sharded: boolean;
  shardCount: number;
  generatedAt: string;
}

export interface LogSummaryResult {
  summary: string;
  meta: LogSummaryMeta;
}

export interface ArchiveStats {
  scanned: number;
  cleaned: number;
  kept: number;
  deleted?: number;
  deletedLogs?: number;
  cutoff: string;
}

// ── Settings ──────────────────────────────────────────────────────────────

export interface RateLimitConfig {
  id: number;
  targetType: 'global';
  rpm: number;
  qps: number;
  dailyTokens: number | null;
  monthlyTokens: number | null;
}

// ── UA (User-Agent) allow/block lists ─────────────────────────────────────
// One row per target in ua_policies. Levels stack: a block hit at any level
// denies; a configured allow level requires a match. 'unset' (no row) is
// represented client-side by the dialog's __unset__ sentinel, not here.

export interface UaPolicy {
  id: number;
  targetType: 'global' | 'app' | 'user' | 'api_key';
  targetId: number | null;
  mode: 'block' | 'allow';
  patterns: string[];
  createdAt: string;
  updatedAt: string;
}

export interface LogRetentionConfig {
  detailsRetentionDays: number;
  logsRetentionDays: number;
  // Log-analysis model: provider name + real model name (a 1M-window small
  // model). Empty strings when unset — the summary endpoint refuses with 400.
  analysisProvider: string;
  analysisModel: string;
  // Admin's custom summary template (system prompt). Empty string when never
  // saved — generateLogSummary falls back to the built-in default.
  analysisPromptTemplate: string;
  // The built-in default template (always the same constant). Read-only
  // reference for the UI + the "恢复默认" button.
  analysisPromptTemplateDefault: string;
  // 智能分析 Agent model: requires a TOOL-CAPABLE model (the agent drives a
  // server-side tool-calling loop). Independent of analysisModel because a
  // 1M-window summarizer (e.g. qwen-long) need not support tool calls.
  analysisAgentProvider: string;
  analysisAgentModel: string;
  analysisAgentSystemPrompt: string;
  analysisAgentSystemPromptDefault: string;
  // Whether reasoning summary streaming is enabled (o-series / gpt-5). Default
  // true; non-reasoning models reject the reasoning param so the admin can opt out.
  analysisAgentReasoningEnabled: boolean;
}

// ── 智能分析 Agent (chat) ─────────────────────────────────────────────────
// The /analysis page streams an agent run over SSE. Each assistant turn may
// fire several tool calls (cards) before producing its markdown answer.

/** A tool call card shown inside an assistant message bubble. */
export interface AnalysisToolCall {
  callId: string;
  toolName: string;
  /** Raw JSON-stringified args the model supplied. */
  args?: string;
  /** Summarised tool output (truncated server-side). Present once tool_result arrives. */
  summary?: string;
  truncated?: boolean;
  /** "running" until tool_result lands, then "done". */
  status: 'running' | 'done' | 'error';
}

/** An ordered piece of an assistant message, in the order its SSE event
 * arrived. The render walks this list top-to-bottom so reasoning / tool calls /
 * answer text are interleaved exactly the way the agent produced them — instead
 * of grouped by type (which flattened the real turn-by-turn timeline into
 * "all reasoning on top, all tools in the middle, text at the bottom").
 *
 * Tool segments store only a callId reference into `AnalysisMessage.tools`,
 * since tool_result later mutates that tool's status/summary in place. */
export type AnalysisSegment =
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; callId: string }
  | { kind: 'text'; text: string };

/** A chat message in the local conversation history. */
export interface AnalysisMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Legacy compat only — kept so old localStorage rows still render after
   * migration. New turns do NOT write this; reasoning lives in `segments`. */
  reasoning?: string;
  /** Tool calls in this turn. Acts as the lookup table that tool_result updates
   * (status/summary); `segments` references entries by callId for rendering. */
  tools?: AnalysisToolCall[];
  /** Ordered segments — the de-facto render source (reasoning / tool / text in
   * arrival order). Absent on old localStorage rows until `withSegments` runs. */
  segments?: AnalysisSegment[];
  /** Assistant turns only: token usage for this turn (from the `done` event). */
  usage?: { promptTokens: number; completionTokens: number; modelCalls: number; durationMs: number };
  /** Set when the run errored; content holds the error message. */
  error?: boolean;
}

/** A locally-stored conversation session on the /analysis page. Many sessions
 * live side-by-side in the left history sidebar; only one is active at a time.
 * Persisted entirely in localStorage (never sent to the backend). */
export interface AnalysisSession {
  id: string;
  title: string;
  messages: AnalysisMessage[];
  /** ISO timestamps. createdAt pins list order (newest first); updatedAt is
   * informational only — we deliberately do NOT re-sort on every token. */
  createdAt: string;
  updatedAt: string;
}

/** Union of SSE events emitted by POST /admin/analysis/chat. */
export type AnalysisStreamEvent =
  | { event: 'meta'; data: { conversationId: string; model: string; provider: string } }
  | { event: 'tool_started'; data: { callId: string; toolName: string; args?: string } }
  | { event: 'tool_result'; data: { callId: string; summary: string; truncated: boolean } }
  | { event: 'reasoning_delta'; data: { delta: string } }
  | { event: 'text_delta'; data: { delta: string } }
  | { event: 'error'; data: { message: string } }
  | { event: 'done'; data: { usage: { promptTokens: number; completionTokens: number }; modelCalls: number; durationMs: number } };

export interface SystemInfo {
  version: string;
  uptime: string;
  database: string;
  nodeEnv: string;
}

// ── Quota ─────────────────────────────────────────────────────────────────

export interface QuotaStatus {
  type: string;
  id: number;
  status: string;
  limits: { dailyTokens: number | null; monthlyTokens: number | null };
  usage: {
    today: { tokens: number; percentage?: number };
    month: { tokens: number; percentage?: number };
    lastMonth: { tokens: number };
  };
  // Only present for api_keys: the parsed model policy and per-model usage
  // (models with a configured limit ∪ models used this month).
  modelPolicy?: ModelPolicy | null;
  models?: Array<{
    model: string;
    limits: { dailyTokens: number | null; monthlyTokens: number | null };
    todayTokens: number;
    monthTokens: number;
  }>;
}

// ── Reports ───────────────────────────────────────────────────────────────
//
// Aggregation charts over request_logs, reusing the same 14-dimension filter
// vocabulary as the logs list (server-side buildRequestLogConditions is shared).
// Backend coerces SUM() DECIMAL strings to Number before returning, so these
// fields are plain numbers on the client.

export type ReportGranularity = 'hour' | 'day' | 'week' | 'month';

export interface ReportOverview {
  totalRequests: number;
  totalErrors: number;
  /** 0–1 fraction (×100 for display). 0 when no requests. */
  errorRate: number;
  avgLatencyMs: number;
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
}

export interface ReportTrendPoint {
  timeBucket: string;
  totalRequests: number;
  totalErrors: number;
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
}

export interface ReportDimensionItem {
  /** The model / provider value. null → "未知" (unknown) on the front end. */
  key: string | null;
  totalRequests: number;
  totalErrors: number;
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
}

export interface ReportStatusItem {
  /** Hundreds class: 200 / 300 / 400 / 500. null → "未知". */
  statusClass: number | null;
  totalRequests: number;
  totalTokens: number;
}

/**
 * Shared report filter params — same field names as the logs list filters, so a
 * single deep-link shape (`/reports?<field>=<value>`) works identically for
 * /reports and /logs. Date values are naive datetime-local strings parsed by
 * the backend as CST, matching how /logs passes from/to (NOT ISO .toISOString()
 * — that would shift the window by the browser tz).
 */
export interface ReportFilterParams {
  apiKeyId?: number;
  appId?: number;
  userId?: number;
  groupId?: number;
  statusCode?: number;
  model?: string;
  provider?: string;
  appUserId?: string;
  featureId?: string;
  requestPath?: string;
  userAgent?: string;
  startDate?: string;
  endDate?: string;
  hideArchived?: boolean;
}
