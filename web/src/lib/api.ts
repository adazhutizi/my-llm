import type {
  ApiError,
  PaginatedResponse,
  DashboardStats,
  UsagePoint,
  ApiKey,
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  UpdateApiKeyRequest,
  User,
  UserGroup,
  AdminUser,
  CreateAdminRequest,
  App,
  AppUser,
  Feature,
  AppUserUsage,
  FeatureUsage,
  VirtualModel,
  Provider,
  RequestLog,
  RequestDetail,
  LogSummaryResult,
  ArchiveStats,
  RateLimitConfig,
  LogRetentionConfig,
  SystemInfo,
  QuotaStatus,
  UsageSummary,
  AnalysisStreamEvent,
  ReportOverview,
  ReportTrendPoint,
  ReportDimensionItem,
  ReportStatusItem,
  ReportFilterParams,
  ReportGranularity,
} from './types';
import { beijingTodayStart } from './utils';

// ── Fetch wrapper ─────────────────────────────────────────────────────────
//
// Backend conventions:
//   - Sub-path routes wrap responses: { data: T } or { data: T[], pagination: {...} }
//   - Quota routes (mounted at /admin) return unwrapped: { success, type, id, ... }
//
// Helpers:
//   fetchJSON<T>()        – raw response.json() (for unwrapped endpoints)
//   fetchUnwrap<T>()      – extract .data from { data: T }
//   fetchPaginated<T>()   – flatten { data: T[], pagination: {...} } into PaginatedResponse<T>

// In dev mode (port 3001), proxy to backend on port 3000.
// In production, requests go to the same origin (Hono serves both).
const isDev = typeof window !== 'undefined' && window.location.port === '3001';
const ADMIN_BASE = isDev ? 'http://localhost:3000/admin' : '/admin';

function buildHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extra,
  };
  const token = localStorage.getItem('admin_jwt_token');
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

async function fetchJSON<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `${ADMIN_BASE}${path}`;
  const headers = buildHeaders(options.headers as Record<string, string>);

  const response = await fetch(url, { ...options, headers });

  // Sliding renewal: server mints a fresh token when the JWT nears expiry.
  // Only adopt it from successful responses.
  if (response.ok) {
    const renewed = response.headers.get('X-Renewed-Token');
    if (renewed) localStorage.setItem('admin_jwt_token', renewed);
  }

  // Global 401 handling: session expired/invalid — clear local auth and bounce
  // to the login page. `hadToken` guards the login request itself (which also
  // returns 401 on bad credentials, but carries no token).
  if (response.status === 401) {
    const hadToken = !!localStorage.getItem('admin_jwt_token');
    localStorage.removeItem('admin_jwt_token');
    localStorage.removeItem('admin_user');
    if (hadToken && typeof window !== 'undefined') {
      window.location.assign('/dashboard/login');
    }
    throw { message: '会话已过期，请重新登录', status: 401 } as ApiError;
  }

  if (!response.ok) {
    let message = `Request failed: ${response.status}`;
    try {
      const body = await response.json();
      message = body.error?.message || body.error || body.message || message;
    } catch {
      // ignore parse errors
    }
    throw { message, status: response.status } as ApiError;
  }

  if (response.status === 204) return undefined as T;
  return response.json();
}

/** Extract .data from backend envelope: { data: T } → T */
async function fetchUnwrap<T>(path: string, options: RequestInit = {}): Promise<T> {
  const envelope = await fetchJSON<{ data: T }>(path, options);
  return envelope.data;
}

/** Flatten { data: T[], pagination: {...}, summary?: {...} } → PaginatedResponse<T> */
async function fetchPaginated<T>(path: string): Promise<PaginatedResponse<T>> {
  const raw = await fetchJSON<{ data: T[]; pagination: { page: number; pageSize: number; total: number }; summary?: UsageSummary }>(path);
  return {
    data: raw.data,
    total: raw.pagination.total,
    page: raw.pagination.page,
    pageSize: raw.pagination.pageSize,
    summary: raw.summary,
  };
}

// ── Dashboard / Stats ───────────────────────────────────────────────────
// Backend: GET /admin/usage/overview → { data: { totalTokens, totalRequests, totalErrors, ... } }

export async function getDashboardStats(): Promise<DashboardStats> {
  // Headline totals cover the last 30 days, aligned to the Beijing-day boundary
  // (same basis as "today" below) so the window doesn't drift by 8h vs. CST midnight.
  const rangeStart = new Date(beijingTodayStart().getTime() - 30 * 24 * 60 * 60 * 1000);
  const rangeQs = `startDate=${rangeStart.toISOString()}`;

  // Fetch rolling 30-day stats (MySQL may return numbers as strings — coerce with Number())
  const overview = await fetchUnwrap<{
    totalTokens: number | string;
    totalPromptTokens: number | string;
    totalCompletionTokens: number | string;
    totalCacheReadTokens?: number | string;
    totalCacheCreationTokens?: number | string;
    totalRequests: number | string;
    totalErrors: number | string;
  }>(`/usage/overview?${rangeQs}`);

  const totalRequests = Number(overview.totalRequests);
  const totalErrors = Number(overview.totalErrors);

  // Fetch today's stats — use the Beijing-day boundary (UTC+8) so the window
  // matches the quota "today" window, not UTC midnight (which is 08:00 CST and
  // would miscount requests made 00:00–08:00 CST as yesterday).
  const todayQs = `startDate=${beijingTodayStart().toISOString()}`;
  const today = await fetchUnwrap<{
    totalTokens: number | string;
    totalCacheReadTokens?: number | string;
    totalCacheCreationTokens?: number | string;
    totalRequests: number | string;
  }>(`/usage/overview?${todayQs}`);

  return {
    totalRequests,
    totalTokens: Number(overview.totalTokens),
    errorRate: totalRequests > 0 ? totalErrors / totalRequests : 0,
    requestsToday: Number(today.totalRequests),
    tokensToday: Number(today.totalTokens),
    cacheTokensToday:
      Number(today.totalCacheReadTokens ?? 0) + Number(today.totalCacheCreationTokens ?? 0),
  };
}

export async function getUsageTrend(params: { period?: string; from?: string; to?: string }): Promise<UsagePoint[]> {
  // Convert frontend params to backend params (startDate, endDate, granularity)
  const qs = new URLSearchParams();
  if (params.from) qs.set('startDate', params.from);
  if (params.to) qs.set('endDate', params.to);

  // Map period shorthand to date range + granularity
  if (params.period) {
    const match = params.period.match(/^(\d+)([dhwm])$/);
    if (match) {
      const amount = parseInt(match[1]);
      const unit = match[2];
      const end = new Date();
      if (unit === 'h') {
        // Hour granularity: a rolling N-hour window on the UTC timeline.
        const start = new Date();
        start.setHours(start.getHours() - amount);
        qs.set('granularity', 'hour');
        qs.set('startDate', start.toISOString());
        qs.set('endDate', end.toISOString());
      } else {
        // Day/week/month: align the start to the Beijing-day boundary (00:00 CST)
        // so each bucket matches the backend's Beijing-day DATE_FORMAT grouping
        // (which uses CONVERT_TZ on record_time). Independent of browser tz.
        const DAY = 86_400_000;
        const offsetDays = unit === 'd' ? amount - 1 : unit === 'w' ? amount * 7 - 1 : amount * 30;
        const start = new Date(beijingTodayStart().getTime() - offsetDays * DAY);
        qs.set('granularity', 'day');
        qs.set('startDate', start.toISOString());
        qs.set('endDate', end.toISOString());
      }
    }
  }

  const items = await fetchUnwrap<Array<{
    timeBucket: string;
    totalTokens: number | string;
    totalCacheReadTokens?: number | string;
    totalCacheCreationTokens?: number | string;
    totalRequests: number | string;
    totalErrors: number | string;
  }>>(`/usage/trends?${qs.toString()}`);

  // Map backend shape to frontend UsagePoint (coerce strings to numbers)
  return items.map((item) => ({
    time: item.timeBucket,
    requests: Number(item.totalRequests),
    tokens: Number(item.totalTokens),
    cacheTokens:
      Number(item.totalCacheReadTokens ?? 0) + Number(item.totalCacheCreationTokens ?? 0),
  }));
}

// ── API Keys ──────────────────────────────────────────────────────────────

export function listApiKeys(params?: { page?: number; pageSize?: number; search?: string; userId?: number; groupId?: number }): Promise<PaginatedResponse<ApiKey>> {
  const qs = new URLSearchParams(
    Object.fromEntries(
      Object.entries(params || {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]),
    ),
  ).toString();
  return fetchPaginated<ApiKey>(`/api-keys?${qs}`);
}

export function createApiKey(data: CreateApiKeyRequest): Promise<CreateApiKeyResponse> {
  return fetchUnwrap<CreateApiKeyResponse>('/api-keys', { method: 'POST', body: JSON.stringify(data) });
}

export function updateApiKey(id: number, data: UpdateApiKeyRequest): Promise<ApiKey> {
  return fetchUnwrap<ApiKey>(`/api-keys/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
}

export function revokeApiKey(id: number): Promise<ApiKey> {
  return fetchUnwrap<ApiKey>(`/api-keys/${id}/revoke`, { method: 'POST' });
}

export function deleteApiKey(id: number): Promise<void> {
  return fetchUnwrap(`/api-keys/${id}`, { method: 'DELETE' });
}

/** Reveal full API key secret */
export function revealApiKey(id: number): Promise<{ id: number; keySecret: string }> {
  return fetchUnwrap<{ id: number; keySecret: string }>(`/api-keys/${id}/secret`);
}

// ── Admins ────────────────────────────────────────────────────────────────

export function listAdmins(params?: { page?: number; pageSize?: number; search?: string }): Promise<PaginatedResponse<AdminUser>> {
  const qs = new URLSearchParams(
    Object.fromEntries(
      Object.entries(params || {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]),
    ),
  ).toString();
  return fetchPaginated<AdminUser>(`/admins?${qs}`);
}

export function createAdmin(data: CreateAdminRequest): Promise<AdminUser & { plainPassword?: string }> {
  return fetchUnwrap<AdminUser & { plainPassword?: string }>('/admins', { method: 'POST', body: JSON.stringify(data) });
}

export function updateAdmin(id: number, data: Partial<Pick<AdminUser, 'role' | 'status'>>): Promise<AdminUser> {
  return fetchUnwrap<AdminUser>(`/admins/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
}

export function resetAdminPassword(id: number): Promise<{ plainPassword: string }> {
  return fetchUnwrap<{ plainPassword: string }>(`/admins/${id}/reset-password`, { method: 'POST' });
}

export function deleteAdmin(id: number): Promise<void> {
  return fetchUnwrap(`/admins/${id}`, { method: 'DELETE' });
}

// ── Users ─────────────────────────────────────────────────────────────────

export function listUsers(params?: { page?: number; pageSize?: number; search?: string; groupId?: number }): Promise<PaginatedResponse<User>> {
  const qs = new URLSearchParams(
    Object.fromEntries(
      Object.entries(params || {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]),
    ),
  ).toString();
  return fetchPaginated<User>(`/users?${qs}`);
}

export function createUser(data: { username: string; identifier: string; groupId?: number | null }): Promise<User> {
  return fetchUnwrap<User>('/users', { method: 'POST', body: JSON.stringify(data) });
}

export function updateUser(id: number, data: Partial<Pick<User, 'status' | 'username' | 'identifier' | 'groupId'>>): Promise<User> {
  return fetchUnwrap<User>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
}

export function deleteUser(id: number): Promise<void> {
  return fetchUnwrap(`/users/${id}`, { method: 'DELETE' });
}

// ── User Groups ───────────────────────────────────────────────────────────

export function listUserGroups(): Promise<UserGroup[]> {
  return fetchUnwrap<UserGroup[]>('/user-groups');
}

export function createUserGroup(data: { name: string; description?: string | null }): Promise<UserGroup> {
  return fetchUnwrap<UserGroup>('/user-groups', { method: 'POST', body: JSON.stringify(data) });
}

export function updateUserGroup(id: number, data: { name?: string; description?: string | null }): Promise<UserGroup> {
  return fetchUnwrap<UserGroup>(`/user-groups/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
}

export function deleteUserGroup(id: number): Promise<void> {
  return fetchUnwrap(`/user-groups/${id}`, { method: 'DELETE' });
}

// ── Apps ──────────────────────────────────────────────────────────────────

export function listApps(params?: { page?: number; pageSize?: number; search?: string }): Promise<PaginatedResponse<App>> {
  const qs = new URLSearchParams(
    Object.fromEntries(
      Object.entries(params || {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]),
    ),
  ).toString();
  return fetchPaginated<App>(`/apps?${qs}`);
}

export function createApp(data: { name: string; description?: string; ownerId?: number }): Promise<App> {
  return fetchUnwrap<App>('/apps', { method: 'POST', body: JSON.stringify(data) });
}

export function updateApp(id: number, data: Partial<Pick<App, 'status' | 'description'>>): Promise<App> {
  return fetchUnwrap<App>(`/apps/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
}

export function deleteApp(id: number): Promise<void> {
  return fetchUnwrap(`/apps/${id}`, { method: 'DELETE' });
}

/** Get app users — backend returns them inside GET /apps/:id response */
export async function getAppUsers(appId: number): Promise<AppUser[]> {
  const detail = await fetchUnwrap<App & { users: AppUser[] }>(`/apps/${appId}`);
  return detail.users ?? [];
}

/** Get features for an app */
export function listFeatures(appId: number): Promise<Feature[]> {
  return fetchUnwrap<Feature[]>(`/apps/${appId}/features`);
}

/** Remove a feature record */
export function removeFeature(appId: number, featureId: string): Promise<void> {
  return fetchUnwrap(`/apps/${appId}/features/${encodeURIComponent(featureId)}`, { method: 'DELETE' });
}

/** Update feature display name */
export function updateFeature(appId: number, featureId: string, displayName: string | null): Promise<Feature> {
  return fetchUnwrap<Feature>(`/apps/${appId}/features/${encodeURIComponent(featureId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ displayName }),
  });
}

/** Update app user display name (remark) */
export function updateAppUser(appId: number, externalUid: string, displayName: string | null): Promise<AppUser> {
  return fetchUnwrap<AppUser>(`/apps/${appId}/users/${encodeURIComponent(externalUid)}`, {
    method: 'PATCH',
    body: JSON.stringify({ displayName }),
  });
}

/** Get app user usage stats — token consumption per end-user within an app */
export function getAppUserUsage(
  appId?: number,
  params?: { startDate?: string; endDate?: string; featureId?: string; search?: string; page?: number; pageSize?: number },
): Promise<PaginatedResponse<AppUserUsage>> {
  const backendParams: Record<string, string> = {};
  if (appId != null) backendParams.appId = String(appId);
  if (params?.startDate) {
    // Append T00:00:00 so JS parses as local midnight (not UTC)
    backendParams.startDate = params.startDate.includes('T') ? params.startDate : `${params.startDate}T00:00:00`;
  }
  if (params?.endDate) {
    // Append T23:59:59 so JS parses as local end-of-day (not UTC midnight)
    backendParams.endDate = params.endDate.includes('T') ? params.endDate : `${params.endDate}T23:59:59`;
  }
  if (params?.featureId) backendParams.featureId = params.featureId;
  if (params?.search) backendParams.search = params.search;
  if (params?.page != null) backendParams.page = String(params.page);
  if (params?.pageSize != null) backendParams.pageSize = String(params.pageSize);

  const qs = new URLSearchParams(backendParams).toString();
  return fetchPaginated<AppUserUsage>(`/usage/by-app-user?${qs}`);
}

/** Get feature usage stats — token consumption grouped by feature identifier */
export function getFeatureUsage(
  params?: { appId?: number; appUserId?: string; search?: string; startDate?: string; endDate?: string; page?: number; pageSize?: number },
): Promise<PaginatedResponse<FeatureUsage>> {
  const backendParams: Record<string, string> = {};
  if (params?.appId != null) backendParams.appId = String(params.appId);
  if (params?.appUserId) backendParams.appUserId = params.appUserId;
  if (params?.search) backendParams.search = params.search;
  if (params?.startDate) {
    backendParams.startDate = params.startDate.includes('T') ? params.startDate : `${params.startDate}T00:00:00`;
  }
  if (params?.endDate) {
    backendParams.endDate = params.endDate.includes('T') ? params.endDate : `${params.endDate}T23:59:59`;
  }
  if (params?.page != null) backendParams.page = String(params.page);
  if (params?.pageSize != null) backendParams.pageSize = String(params.pageSize);

  const qs = new URLSearchParams(backendParams).toString();
  return fetchPaginated<FeatureUsage>(`/usage/by-feature?${qs}`);
}

// ── Virtual Models ────────────────────────────────────────────────────────

export function listModels(): Promise<VirtualModel[]> {
  return fetchUnwrap<VirtualModel[]>('/models');
}

export function createModel(data: Omit<VirtualModel, 'id' | 'createdAt'>): Promise<VirtualModel> {
  return fetchUnwrap<VirtualModel>('/models', { method: 'POST', body: JSON.stringify(data) });
}

export function updateModel(id: number, data: Partial<Omit<VirtualModel, 'id' | 'createdAt'>>): Promise<VirtualModel> {
  return fetchUnwrap<VirtualModel>(`/models/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
}

export function deleteModel(id: number): Promise<void> {
  return fetchUnwrap(`/models/${id}`, { method: 'DELETE' });
}

// ── Providers ─────────────────────────────────────────────────────────────

export function listProviders(): Promise<Provider[]> {
  return fetchUnwrap<Provider[]>('/providers');
}

export function createProvider(data: { name: string; apiType: 'openai' | 'anthropic'; baseUrl: string; apiKey?: string; config?: Record<string, unknown> }): Promise<Provider> {
  return fetchUnwrap<Provider>('/providers', { method: 'POST', body: JSON.stringify(data) });
}

export function updateProvider(id: number, data: Partial<{ name: string; apiType: 'openai' | 'anthropic'; baseUrl: string; isActive: boolean; apiKey: string; config: Record<string, unknown> }>): Promise<Provider> {
  return fetchUnwrap<Provider>(`/providers/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
}

export function deleteProvider(id: number): Promise<void> {
  return fetchUnwrap(`/providers/${id}`, { method: 'DELETE' });
}

// ── Request Logs ──────────────────────────────────────────────────────────

export function listLogs(params?: {
  page?: number;
  pageSize?: number;
  from?: string;
  to?: string;
  model?: string;
  provider?: string;
  statusCode?: number;
  apiKeyId?: number;
  userId?: number;
  appId?: number;
  appUserId?: string;
  featureId?: string;
  requestPath?: string;
  userAgent?: string;
  groupId?: number;
  hideArchived?: boolean;
}): Promise<PaginatedResponse<RequestLog>> {
  // Map frontend from/to to backend startDate/endDate
  const backendParams: Record<string, string> = {};
  if (params?.page != null) backendParams.page = String(params.page);
  if (params?.pageSize != null) backendParams.pageSize = String(params.pageSize);
  if (params?.from) backendParams.startDate = params.from;
  if (params?.to) backendParams.endDate = params.to;
  if (params?.model) backendParams.model = params.model;
  if (params?.provider) backendParams.provider = params.provider;
  if (params?.statusCode != null) backendParams.statusCode = String(params.statusCode);
  if (params?.apiKeyId != null) backendParams.apiKeyId = String(params.apiKeyId);
  if (params?.userId != null) backendParams.userId = String(params.userId);
  if (params?.appId != null) backendParams.appId = String(params.appId);
  if (params?.groupId != null) backendParams.groupId = String(params.groupId);
  if (params?.appUserId) backendParams.appUserId = params.appUserId;
  if (params?.featureId) backendParams.featureId = params.featureId;
  if (params?.requestPath) backendParams.requestPath = params.requestPath;
  if (params?.userAgent) backendParams.userAgent = params.userAgent;
  if (params?.hideArchived) backendParams.hideArchived = 'true';

  const qs = new URLSearchParams(backendParams).toString();
  return fetchPaginated<RequestLog>(`/logs?${qs}`);
}

export function getLogDetail(requestId: string): Promise<RequestDetail> {
  return fetchUnwrap<RequestDetail>(`/logs/${requestId}`);
}

/**
 * Generate (or return cached) an AI summary of a request log's body.
 * Backend: POST /admin/logs/:id/summary with { force? } → { data: LogSummaryResult }
 * force=true bypasses the Redis cache and regenerates.
 */
export function generateLogSummary(requestId: string, force = false): Promise<LogSummaryResult> {
  return fetchUnwrap<LogSummaryResult>(`/logs/${requestId}/summary`, {
    method: 'POST',
    body: JSON.stringify({ force }),
  });
}

/**
 * Merge agentic loop sessions: for each conversation keep only the tail (most
 * complete) request detail and null the superseded prefixes' big fields. Usage
 * stats (request_logs / usage_records) are untouched.
 */
export function archiveLogs(opts?: {
  retentionDays?: number;
  sessionTimeoutMin?: number;
  batchSize?: number;
}): Promise<ArchiveStats> {
  return fetchUnwrap<ArchiveStats>('/logs/archive', {
    method: 'POST',
    body: JSON.stringify(opts ?? {}),
  });
}

export function getLogFilterOptions(): Promise<{ models: string[]; providers: string[] }> {
  return fetchUnwrap<{ models: string[]; providers: string[] }>('/logs/filter-options');
}

// ── Reports ──────────────────────────────────────────────────────────────
//
// Aggregation charts over request_logs, reusing the SAME filter vocabulary as
// /logs (server-side buildRequestLogConditions is shared — single source of
// truth). Each endpoint wraps its payload as { data: T }; fetchUnwrap extracts
// .data and switches the dev/prod base automatically.

/** Build the shared filter query string from ReportFilterParams (plus optional
 * extra params like granularity). Omits undefined/empty so the URL stays clean
 * and the backend treats absence as "no filter". */
function buildReportQs(params: ReportFilterParams, extra?: Record<string, string>): string {
  const p: Record<string, string> = {};
  if (params.apiKeyId != null) p.apiKeyId = String(params.apiKeyId);
  if (params.appId != null) p.appId = String(params.appId);
  if (params.userId != null) p.userId = String(params.userId);
  if (params.groupId != null) p.groupId = String(params.groupId);
  if (params.statusCode != null) p.statusCode = String(params.statusCode);
  if (params.model) p.model = params.model;
  if (params.provider) p.provider = params.provider;
  if (params.appUserId) p.appUserId = params.appUserId;
  if (params.featureId) p.featureId = params.featureId;
  if (params.requestPath) p.requestPath = params.requestPath;
  if (params.userAgent) p.userAgent = params.userAgent;
  if (params.startDate) p.startDate = params.startDate;
  if (params.endDate) p.endDate = params.endDate;
  if (params.hideArchived) p.hideArchived = 'true';
  if (extra) Object.assign(p, extra);
  return new URLSearchParams(p).toString();
}

export function getReportOverview(params: ReportFilterParams): Promise<ReportOverview> {
  return fetchUnwrap<ReportOverview>(`/reports/overview?${buildReportQs(params)}`);
}

export function getReportTrends(
  params: ReportFilterParams & { granularity?: ReportGranularity },
): Promise<ReportTrendPoint[]> {
  const { granularity, ...rest } = params;
  const extra = granularity ? { granularity } : undefined;
  return fetchUnwrap<ReportTrendPoint[]>(`/reports/trends?${buildReportQs(rest, extra)}`);
}

export function getReportByModel(params: ReportFilterParams): Promise<ReportDimensionItem[]> {
  return fetchUnwrap<ReportDimensionItem[]>(`/reports/by-model?${buildReportQs(params)}`);
}

export function getReportByProvider(params: ReportFilterParams): Promise<ReportDimensionItem[]> {
  return fetchUnwrap<ReportDimensionItem[]>(`/reports/by-provider?${buildReportQs(params)}`);
}

export function getReportByStatus(params: ReportFilterParams): Promise<ReportStatusItem[]> {
  return fetchUnwrap<ReportStatusItem[]>(`/reports/by-status?${buildReportQs(params)}`);
}

// ── Settings ──────────────────────────────────────────────────────────────

/**
 * Get global rate limit config.
 * Backend: GET /admin/rate-limits?targetType=global → { data: RateLimitConfig[] }
 * Returns the first (and only) global entry, or default values.
 */
export async function getGlobalRateLimit(): Promise<RateLimitConfig> {
  const items = await fetchUnwrap<RateLimitConfig[]>('/rate-limits?targetType=global');
  if (items.length > 0) return items[0];
  // Return sensible defaults if no global config exists yet
  return { id: 0, targetType: 'global', rpm: 60, qps: 10, dailyTokens: null, monthlyTokens: null };
}

/**
 * Update global rate limit config.
 * Backend: PUT /admin/rate-limits with { targetType: 'global', ... }
 */
export function updateGlobalRateLimit(data: Partial<RateLimitConfig>): Promise<RateLimitConfig> {
  return fetchUnwrap<RateLimitConfig>('/rate-limits', {
    method: 'PUT',
    body: JSON.stringify({ ...data, targetType: 'global' }),
  });
}

/**
 * Get log retention config (max age in days for request_details / request_logs).
 * Backend: GET /admin/settings → { data: LogRetentionConfig }
 */
export function getLogRetention(): Promise<LogRetentionConfig> {
  return fetchUnwrap<LogRetentionConfig>('/settings');
}

/**
 * Update log retention config. Partial — only provided fields are written.
 * Backend: PUT /admin/settings with { detailsRetentionDays?, logsRetentionDays? }
 */
export function updateLogRetention(data: Partial<LogRetentionConfig>): Promise<LogRetentionConfig> {
  return fetchUnwrap<LogRetentionConfig>('/settings', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

/**
 * Get system info.
 * No dedicated admin endpoint — uses the public /health check + browser info.
 */
export async function getSystemInfo(): Promise<SystemInfo> {
  const healthUrl = isDev ? 'http://localhost:3000/health' : '/health';
  try {
    const res = await fetch(healthUrl);
    if (!res.ok) throw new Error('health check failed');
    const body = await res.json();
    return {
      version: '1.0.0',
      uptime: '-',
      database: 'connected',
      nodeEnv: 'production',
      ...body,
    } as SystemInfo;
  } catch {
    return { version: '-', uptime: '-', database: 'unknown', nodeEnv: '-' };
  }
}

// ── Quota ─────────────────────────────────────────────────────────────────

export function restoreTarget(type: 'api_keys' | 'users' | 'apps', id: number): Promise<{ success: boolean }> {
  return fetchJSON(`/${type}/${id}/restore`, { method: 'POST' });
}

export function getQuotaStatus(type: 'api_keys' | 'users' | 'apps', id: number): Promise<QuotaStatus> {
  return fetchJSON(`/quotas/${type}/${id}`);
}

// ── Per-entity Rate Limits ─────────────────────────────────────────────────

export function changePassword(currentPassword: string, newPassword: string): Promise<{ success: boolean }> {
  return fetchUnwrap<{ success: boolean }>('/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export function getEntityRateLimit(type: 'app' | 'user' | 'api_key', id: number): Promise<RateLimitConfig | null> {
  return fetchUnwrap<RateLimitConfig[]>(`/rate-limits?targetType=${type}&targetId=${id}`)
    .then(items => items.length > 0 ? items[0] : null);
}

export function setEntityRateLimit(
  type: 'app' | 'user' | 'api_key',
  id: number,
  data: { rpm?: number; qps?: number; dailyTokens?: number | null; monthlyTokens?: number | null },
): Promise<RateLimitConfig> {
  return fetchUnwrap<RateLimitConfig>('/rate-limits', {
    method: 'PUT',
    body: JSON.stringify({ ...data, targetType: type, targetId: id }),
  });
}

// ── 智能分析 Agent (SSE streaming) ────────────────────────────────────────
//
// POST /admin/analysis/chat is an SSE endpoint (streamSSE), so it can't go
// through fetchJSON (which awaits + JSON.parses the whole body). We hand-roll
// the fetch + ReadableStream + SSE frame parser here, reusing buildHeaders for
// JWT injection and ADMIN_BASE for dev/prod base switching.
//
// Transport failures (network, 401, 400 "model not configured") throw ApiError;
// business failures (agent run crashed mid-stream) arrive as a normal `{event:
// 'error'}` frame via onEvent — the response itself is 200 SSE either way.

export interface AnalysisChatHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

export async function streamAnalysisChat(opts: {
  message: string;
  history: AnalysisChatHistoryItem[];
  signal?: AbortSignal;
  onEvent: (ev: AnalysisStreamEvent) => void;
}): Promise<void> {
  const url = `${ADMIN_BASE}/analysis/chat`;
  const headers = buildHeaders({ Accept: 'text/event-stream' });
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: opts.message, history: opts.history }),
    signal: opts.signal,
  });

  // Sliding renewal works on the SSE response header too.
  if (res.ok) {
    const renewed = res.headers.get('X-Renewed-Token');
    if (renewed) localStorage.setItem('admin_jwt_token', renewed);
  }

  if (res.status === 401) {
    const hadToken = !!localStorage.getItem('admin_jwt_token');
    localStorage.removeItem('admin_jwt_token');
    localStorage.removeItem('admin_user');
    if (hadToken && typeof window !== 'undefined') {
      window.location.assign('/dashboard/login');
    }
    throw { message: '会话已过期，请重新登录', status: 401 } as ApiError;
  }

  if (!res.ok || !res.body) {
    // Non-SSE error (e.g. 400 "model not configured"): body is JSON.
    let message = `Request failed: ${res.status}`;
    try {
      const body = await res.json();
      message = body.error?.message || body.error || body.message || message;
    } catch {
      // ignore parse errors
    }
    throw { message, status: res.status } as ApiError;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line. A single read may carry
      // several frames, or split one across reads — the buffer + drain loop
      // handles both.
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const ev = parseSSEFrame(frame);
        if (ev) opts.onEvent(ev);
      }
    }
  } catch (err) {
    // 连接在流式中途被切断(ingress 空闲超时 / 上游断流 / 网络抖动):reader.read()
    // 抛 TypeError,message 多为 "Failed to fetch"——原样显示给用户很突兀。主动
    // abort(切换会话 / 新建 / 删除 / 清空)由外层 page.tsx 按 signal.aborted 判定
    // 跳过,这里原样放行不转译;其余中断统一转成中文友好提示。
    if (opts.signal?.aborted) throw err;
    throw { message: '连接已中断，请重试', status: 0 } as ApiError;
  } finally {
    reader.releaseLock();
  }
}

/** Parse one `event: x\ndata: {...}` frame into a typed event (or null). */
function parseSSEFrame(frame: string): AnalysisStreamEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const raw of frame.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^\s/, ''));
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) } as AnalysisStreamEvent;
  } catch {
    return null;
  }
}

export interface AnalysisConfig {
  provider: string;
  model: string;
  systemPrompt: string;
  systemPromptDefault: string;
  reasoningEnabled: boolean;
  featureId: string;
}

/** GET /admin/analysis/config — current Agent wiring (for the page header badge). */
export function getAnalysisConfig(): Promise<AnalysisConfig> {
  return fetchUnwrap<AnalysisConfig>('/analysis/config');
}
