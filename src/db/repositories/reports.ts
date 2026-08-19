import { getDb } from '../index.js';
import { requestLogs, requestDetails } from '../schema.js';
import { eq, and, sql, type SQL } from 'drizzle-orm';
import {
  buildRequestLogConditions,
  logFilterNeedsDetails,
  type ListRequestLogsFilters,
} from './logs.js';

// Report aggregation over request_logs, reusing the EXACT same WHERE-condition
// builder as listRequestLogs (buildRequestLogConditions) so the report charts
// and the log list always agree on what's filtered — single source of truth.
//
// Why request_logs and not usage_records: the log list exposes 14 filter
// dimensions (statusCode / requestPath / userAgent / appUserId / featureId /
// groupId / model / provider / …) that simply don't exist on the hourly
// usage_records aggregate table. To honor "reuse the log filters" we aggregate
// the detail rows directly, the same way getUsageByAppUser/getUsageByFeature do.
//
// Each function mirrors the inlined two-branch pattern of getUsageByAppUser
// (rather than a generic helper): drizzle's query-builder generics don't survive
// a custom wrapper (SelectedFields needs type args, AnyColumn isn't a
// MySqlColumn, groupBy's overloads reject the union), so we let drizzle infer
// each concrete select shape directly.

export type ReportFilters = ListRequestLogsFilters;

export interface ReportTrendFilters extends ReportFilters {
  granularity?: 'hour' | 'day' | 'week' | 'month';
}

// ── Shared SQL fragments ─────────────────────────────────────────────────
//
// request_logs' cache_read_tokens / cache_creation_tokens are nullable int with
// no default (persistRequestLog writes NULL on OpenAI/DashScope traffic that
// doesn't report prompt cache). SUM over an all-NULL column returns NULL, and
// NULL + x = NULL, so a single outer COALESCE collapses the total to 0 for any
// group that is all-NULL on one column (every OpenAI-only group). Wrap each SUM
// individually so a NULL column contributes 0 instead. Same red line as
// getUsageByAppUser/getUsageByFeature — CLAUDE.md "per-column COALESCE".
const SUM_PROMPT = sql<number>`COALESCE(SUM(${requestLogs.promptTokens}), 0)`;
const SUM_COMPLETION = sql<number>`COALESCE(SUM(${requestLogs.completionTokens}), 0)`;
const SUM_CACHE_READ = sql<number>`COALESCE(SUM(${requestLogs.cacheReadTokens}), 0)`;
const SUM_CACHE_CREATE = sql<number>`COALESCE(SUM(${requestLogs.cacheCreationTokens}), 0)`;
const SUM_TOKENS = sql<number>`COALESCE(SUM(${requestLogs.promptTokens}), 0) + COALESCE(SUM(${requestLogs.completionTokens}), 0) + COALESCE(SUM(${requestLogs.cacheReadTokens}), 0) + COALESCE(SUM(${requestLogs.cacheCreationTokens}), 0)`;
// Errors = HTTP status_code >= 400 (4xx client + 5xx server). NULL status (rare,
// dedicated logs that never got a response) counts as neither success nor error.
const SUM_ERRORS = sql<number>`SUM(CASE WHEN ${requestLogs.statusCode} >= 400 THEN 1 ELSE 0 END)`;

function reportWhere(filters: ReportFilters): SQL | undefined {
  const conditions = buildRequestLogConditions(filters);
  return conditions.length > 0 ? and(...conditions) : undefined;
}

function granularityDateFormat(granularity: 'hour' | 'day' | 'week' | 'month'): string {
  switch (granularity) {
    case 'hour':
      return '%Y-%m-%d %H:00:00';
    case 'day':
      return '%Y-%m-%d';
    case 'week':
      return '%Y-%u';
    case 'month':
      return '%Y-%m';
  }
}

// No MAX_EXECUTION_TIME optimizer hint: drizzle's query builder can't attach
// one (same reason runLogArchive resorts to raw SQL for FORCE INDEX). The
// date-range index idx_request_logs_created_at + the dimension LIMIT bound the
// work; the front end defaults to a 7-day window.

// ── Overview (KPI, single row) ────────────────────────────────────────────

export interface ReportOverview {
  totalRequests: number;
  totalErrors: number;
  /** 0–1 (fraction). 0 when no requests. Front end ×100 for display. */
  errorRate: number;
  avgLatencyMs: number;
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
}

export async function getReportOverview(filters: ReportFilters): Promise<ReportOverview> {
  const db = getDb();
  const where = reportWhere(filters);
  const selectShape = {
    totalRequests: sql<number>`COUNT(*)`,
    totalErrors: SUM_ERRORS,
    totalPromptTokens: SUM_PROMPT,
    totalCompletionTokens: SUM_COMPLETION,
    totalCacheReadTokens: SUM_CACHE_READ,
    totalCacheCreationTokens: SUM_CACHE_CREATE,
    totalTokens: SUM_TOKENS,
    avgLatencyMs: sql<number>`AVG(${requestLogs.latencyMs})`,
  };

  const rows = logFilterNeedsDetails(filters)
    ? await db
        .select(selectShape)
        .from(requestLogs)
        .leftJoin(requestDetails, eq(requestDetails.requestId, requestLogs.requestId))
        .where(where)
    : await db.select(selectShape).from(requestLogs).where(where);
  const row = rows[0];

  const totalRequests = Number(row?.totalRequests ?? 0);
  const totalErrors = Number(row?.totalErrors ?? 0);
  return {
    totalRequests,
    totalErrors,
    errorRate: totalRequests > 0 ? totalErrors / totalRequests : 0,
    avgLatencyMs: Number(row?.avgLatencyMs ?? 0),
    totalTokens: Number(row?.totalTokens ?? 0),
    totalPromptTokens: Number(row?.totalPromptTokens ?? 0),
    totalCompletionTokens: Number(row?.totalCompletionTokens ?? 0),
    totalCacheReadTokens: Number(row?.totalCacheReadTokens ?? 0),
    totalCacheCreationTokens: Number(row?.totalCacheCreationTokens ?? 0),
  };
}

// ── Trends (time series) ──────────────────────────────────────────────────

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

export async function getReportTrends(filters: ReportTrendFilters): Promise<ReportTrendPoint[]> {
  const db = getDb();
  const where = reportWhere(filters);
  const dateFormat = granularityDateFormat(filters.granularity ?? 'day');
  // created_at is a UTC wall-clock literal under the pinned UTC session; DATE_FORMAT
  // reads it at face value (no tz awareness), so shift to Beijing (+08:00) first —
  // otherwise buckets split on the UTC day boundary (08:00 CST) instead of the
  // Beijing day, misaligning with dashboard/quota "today". Same as getUsageTrends.
  const timeBucket = sql<string>`DATE_FORMAT(CONVERT_TZ(${requestLogs.createdAt}, '+00:00', '+08:00'), ${dateFormat})`.as('time_bucket');
  const selectShape = {
    timeBucket,
    totalRequests: sql<number>`COUNT(*)`,
    totalErrors: SUM_ERRORS,
    totalPromptTokens: SUM_PROMPT,
    totalCompletionTokens: SUM_COMPLETION,
    totalCacheReadTokens: SUM_CACHE_READ,
    totalCacheCreationTokens: SUM_CACHE_CREATE,
    totalTokens: SUM_TOKENS,
  };

  const rows = logFilterNeedsDetails(filters)
    ? await db
        .select(selectShape)
        .from(requestLogs)
        .leftJoin(requestDetails, eq(requestDetails.requestId, requestLogs.requestId))
        .where(where)
        .groupBy(timeBucket)
        .orderBy(timeBucket)
        .limit(100_000)
    : await db
        .select(selectShape)
        .from(requestLogs)
        .where(where)
        .groupBy(timeBucket)
        .orderBy(timeBucket)
        .limit(100_000);
  return rows.map((row) => ({
    timeBucket: row.timeBucket,
    totalRequests: Number(row.totalRequests ?? 0),
    totalErrors: Number(row.totalErrors ?? 0),
    totalTokens: Number(row.totalTokens ?? 0),
    totalPromptTokens: Number(row.totalPromptTokens ?? 0),
    totalCompletionTokens: Number(row.totalCompletionTokens ?? 0),
    totalCacheReadTokens: Number(row.totalCacheReadTokens ?? 0),
    totalCacheCreationTokens: Number(row.totalCacheCreationTokens ?? 0),
  }));
}

// ── By dimension (model / provider) ───────────────────────────────────────

export interface ReportDimensionItem {
  /** The model / provider value. NULL → "未知" (unknown) on the front end. */
  key: string | null;
  totalRequests: number;
  totalErrors: number;
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
}

export async function getReportByModel(filters: ReportFilters): Promise<ReportDimensionItem[]> {
  const db = getDb();
  const where = reportWhere(filters);
  const selectShape = {
    key: requestLogs.model,
    totalRequests: sql<number>`COUNT(*)`,
    totalErrors: SUM_ERRORS,
    totalPromptTokens: SUM_PROMPT,
    totalCompletionTokens: SUM_COMPLETION,
    totalCacheReadTokens: SUM_CACHE_READ,
    totalCacheCreationTokens: SUM_CACHE_CREATE,
    totalTokens: SUM_TOKENS,
  };
  const rows = logFilterNeedsDetails(filters)
    ? await db
        .select(selectShape)
        .from(requestLogs)
        .leftJoin(requestDetails, eq(requestDetails.requestId, requestLogs.requestId))
        .where(where)
        .groupBy(requestLogs.model)
        .orderBy(sql`${SUM_TOKENS} DESC`)
        .limit(50)
    : await db
        .select(selectShape)
        .from(requestLogs)
        .where(where)
        .groupBy(requestLogs.model)
        .orderBy(sql`${SUM_TOKENS} DESC`)
        .limit(50);
  return rows.map((row) => ({
    key: row.key ?? null,
    totalRequests: Number(row.totalRequests ?? 0),
    totalErrors: Number(row.totalErrors ?? 0),
    totalTokens: Number(row.totalTokens ?? 0),
    totalPromptTokens: Number(row.totalPromptTokens ?? 0),
    totalCompletionTokens: Number(row.totalCompletionTokens ?? 0),
    totalCacheReadTokens: Number(row.totalCacheReadTokens ?? 0),
    totalCacheCreationTokens: Number(row.totalCacheCreationTokens ?? 0),
  }));
}

export async function getReportByProvider(filters: ReportFilters): Promise<ReportDimensionItem[]> {
  const db = getDb();
  const where = reportWhere(filters);
  const selectShape = {
    key: requestLogs.provider,
    totalRequests: sql<number>`COUNT(*)`,
    totalErrors: SUM_ERRORS,
    totalPromptTokens: SUM_PROMPT,
    totalCompletionTokens: SUM_COMPLETION,
    totalCacheReadTokens: SUM_CACHE_READ,
    totalCacheCreationTokens: SUM_CACHE_CREATE,
    totalTokens: SUM_TOKENS,
  };
  const rows = logFilterNeedsDetails(filters)
    ? await db
        .select(selectShape)
        .from(requestLogs)
        .leftJoin(requestDetails, eq(requestDetails.requestId, requestLogs.requestId))
        .where(where)
        .groupBy(requestLogs.provider)
        .orderBy(sql`${SUM_TOKENS} DESC`)
        .limit(50)
    : await db
        .select(selectShape)
        .from(requestLogs)
        .where(where)
        .groupBy(requestLogs.provider)
        .orderBy(sql`${SUM_TOKENS} DESC`)
        .limit(50);
  return rows.map((row) => ({
    key: row.key ?? null,
    totalRequests: Number(row.totalRequests ?? 0),
    totalErrors: Number(row.totalErrors ?? 0),
    totalTokens: Number(row.totalTokens ?? 0),
    totalPromptTokens: Number(row.totalPromptTokens ?? 0),
    totalCompletionTokens: Number(row.totalCompletionTokens ?? 0),
    totalCacheReadTokens: Number(row.totalCacheReadTokens ?? 0),
    totalCacheCreationTokens: Number(row.totalCacheCreationTokens ?? 0),
  }));
}

// ── By status code class ──────────────────────────────────────────────────

export interface ReportStatusItem {
  /** Hundreds class: 200 / 300 / 400 / 500. NULL → "未知". */
  statusClass: number | null;
  totalRequests: number;
  totalTokens: number;
}

export async function getReportByStatus(filters: ReportFilters): Promise<ReportStatusItem[]> {
  const db = getDb();
  const where = reportWhere(filters);
  // FLOOR(404/100)*100 = 400. NULL status (dedicated logs without a response)
  // stays NULL and renders as "未知".
  const statusClass = sql<number | null>`CASE WHEN ${requestLogs.statusCode} IS NULL THEN NULL ELSE FLOOR(${requestLogs.statusCode} / 100) * 100 END`.as('status_class');
  const selectShape = {
    statusClass,
    totalRequests: sql<number>`COUNT(*)`,
    totalTokens: SUM_TOKENS,
  };
  const rows = logFilterNeedsDetails(filters)
    ? await db
        .select(selectShape)
        .from(requestLogs)
        .leftJoin(requestDetails, eq(requestDetails.requestId, requestLogs.requestId))
        .where(where)
        .groupBy(statusClass)
        .orderBy(statusClass)
        .limit(50)
    : await db
        .select(selectShape)
        .from(requestLogs)
        .where(where)
        .groupBy(statusClass)
        .orderBy(statusClass)
        .limit(50);
  return rows.map((row) => ({
    statusClass: row.statusClass == null ? null : Number(row.statusClass),
    totalRequests: Number(row.totalRequests ?? 0),
    totalTokens: Number(row.totalTokens ?? 0),
  }));
}
