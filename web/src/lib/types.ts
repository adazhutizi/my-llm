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
  totalRequests: number;
  totalTokens: number;
  errorRate: number;
  requestsToday: number;
  tokensToday: number;
  cacheTokensToday?: number;
}

export interface UsagePoint {
  time: string;
  requests: number;
  tokens: number;
  cacheTokens?: number;
}

// ── API Keys ──────────────────────────────────────────────────────────────

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
  provider?: { id: number; name: string } | null;
  user?: { id: number; username: string } | null;
  app?: { id: number; name: string } | null;
}

export interface CreateApiKeyRequest {
  mode: 'user' | 'app' | 'admin' | 'dedicated';
  name: string;
  userId?: number;
  appId?: number;
  expiresAt?: string;
  providerId?: number;
  upstreamApiKey?: string;
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
