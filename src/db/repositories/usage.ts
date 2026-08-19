import { getDb } from '../index.js';
import { usageRecords, requestLogs, appUsers, features } from '../schema.js';
import { formatUtcDateTime } from './logs.js';
import { likePattern } from './like.js';
import { eq, and, sql, gte, lte, isNotNull, type SQL } from 'drizzle-orm';

export interface UsageFilters {
  startDate?: Date;
  endDate?: Date;
  apiKeyId?: number;
  appId?: number;
  userId?: number;
}

export interface TrendFilters extends UsageFilters {
  granularity?: 'hour' | 'day' | 'week' | 'month';
}

function buildDateConditions(filters: UsageFilters): SQL[] {
  const conditions: SQL[] = [];
  if (filters.startDate) {
    conditions.push(gte(usageRecords.recordTime, filters.startDate));
  }
  if (filters.endDate) {
    conditions.push(lte(usageRecords.recordTime, filters.endDate));
  }
  if (filters.apiKeyId !== undefined) {
    conditions.push(eq(usageRecords.apiKeyId, filters.apiKeyId));
  }
  if (filters.appId !== undefined) {
    conditions.push(eq(usageRecords.appId, filters.appId));
  }
  if (filters.userId !== undefined) {
    conditions.push(eq(usageRecords.userId, filters.userId));
  }
  return conditions;
}

export async function getUsageOverview(filters: UsageFilters) {
  const db = getDb();
  const conditions = buildDateConditions(filters);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const results = await db
    .select({
      totalTokens: sql<number>`COALESCE(SUM(${usageRecords.totalTokens}), 0)`,
      totalPromptTokens: sql<number>`COALESCE(SUM(${usageRecords.promptTokens}), 0)`,
      totalCompletionTokens: sql<number>`COALESCE(SUM(${usageRecords.completionTokens}), 0)`,
      totalCacheReadTokens: sql<number>`COALESCE(SUM(${usageRecords.cacheReadTokens}), 0)`,
      totalCacheCreationTokens: sql<number>`COALESCE(SUM(${usageRecords.cacheCreationTokens}), 0)`,
      totalRequests: sql<number>`COALESCE(SUM(${usageRecords.requestCount}), 0)`,
      totalErrors: sql<number>`COALESCE(SUM(${usageRecords.errorCount}), 0)`,
    })
    .from(usageRecords)
    .where(where);

  return results[0];
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

export async function getUsageByKey(apiKeyId: number, filters: UsageFilters) {
  const db = getDb();
  const conditions = buildDateConditions({ ...filters, apiKeyId });
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const items = await db
    .select({
      recordTime: usageRecords.recordTime,
      model: usageRecords.model,
      totalTokens: usageRecords.totalTokens,
      promptTokens: usageRecords.promptTokens,
      completionTokens: usageRecords.completionTokens,
      requestCount: usageRecords.requestCount,
      errorCount: usageRecords.errorCount,
    })
    .from(usageRecords)
    .where(where)
    .orderBy(usageRecords.recordTime);

  return items;
}

export async function getUsageByApp(appId: number, filters: UsageFilters) {
  const db = getDb();
  const conditions = buildDateConditions({ ...filters, appId });
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const items = await db
    .select({
      recordTime: usageRecords.recordTime,
      model: usageRecords.model,
      totalTokens: usageRecords.totalTokens,
      promptTokens: usageRecords.promptTokens,
      completionTokens: usageRecords.completionTokens,
      requestCount: usageRecords.requestCount,
      errorCount: usageRecords.errorCount,
    })
    .from(usageRecords)
    .where(where)
    .orderBy(usageRecords.recordTime);

  return items;
}

export async function getUsageByUser(userId: number, filters: UsageFilters) {
  const db = getDb();
  const conditions = buildDateConditions({ ...filters, userId });
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const items = await db
    .select({
      recordTime: usageRecords.recordTime,
      model: usageRecords.model,
      totalTokens: usageRecords.totalTokens,
      promptTokens: usageRecords.promptTokens,
      completionTokens: usageRecords.completionTokens,
      requestCount: usageRecords.requestCount,
      errorCount: usageRecords.errorCount,
    })
    .from(usageRecords)
    .where(where)
    .orderBy(usageRecords.recordTime);

  return items;
}

export async function getUsageByModel(filters: UsageFilters) {
  const db = getDb();
  const conditions = buildDateConditions(filters);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const items = await db
    .select({
      model: usageRecords.model,
      totalTokens: sql<number>`COALESCE(SUM(${usageRecords.totalTokens}), 0)`,
      totalPromptTokens: sql<number>`COALESCE(SUM(${usageRecords.promptTokens}), 0)`,
      totalCompletionTokens: sql<number>`COALESCE(SUM(${usageRecords.completionTokens}), 0)`,
      totalCacheReadTokens: sql<number>`COALESCE(SUM(${usageRecords.cacheReadTokens}), 0)`,
      totalCacheCreationTokens: sql<number>`COALESCE(SUM(${usageRecords.cacheCreationTokens}), 0)`,
      totalRequests: sql<number>`COALESCE(SUM(${usageRecords.requestCount}), 0)`,
      totalErrors: sql<number>`COALESCE(SUM(${usageRecords.errorCount}), 0)`,
    })
    .from(usageRecords)
    .where(where)
    .groupBy(usageRecords.model);

  return items;
}

export async function getUsageTrends(filters: TrendFilters) {
  const db = getDb();
  const granularity = filters.granularity ?? 'day';
  const dateFormat = granularityDateFormat(granularity);
  const conditions = buildDateConditions(filters);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // record_time is a datetime column stored as a UTC wall-clock literal (drizzle
  // serializes Date params via toISOString() to UTC). DATE_FORMAT reads the
  // literal at face value with no timezone awareness, so we must shift to
  // Beijing (UTC+8) first — otherwise buckets split on the UTC day boundary
  // (08:00 CST) instead of the Beijing day, misaligning the trend with
  // dashboard "today" / quota "today" (both Beijing-based). Verified via
  // toSQL(): gte/insert emit UTC literals, so record_time is UTC, not local.
  const timeBucket = sql<string>`DATE_FORMAT(CONVERT_TZ(${usageRecords.recordTime}, '+00:00', '+08:00'), ${dateFormat})`.as('time_bucket');

  const items = await db
    .select({
      timeBucket,
      totalTokens: sql<number>`COALESCE(SUM(${usageRecords.totalTokens}), 0)`,
      totalPromptTokens: sql<number>`COALESCE(SUM(${usageRecords.promptTokens}), 0)`,
      totalCompletionTokens: sql<number>`COALESCE(SUM(${usageRecords.completionTokens}), 0)`,
      totalCacheReadTokens: sql<number>`COALESCE(SUM(${usageRecords.cacheReadTokens}), 0)`,
      totalCacheCreationTokens: sql<number>`COALESCE(SUM(${usageRecords.cacheCreationTokens}), 0)`,
      totalRequests: sql<number>`COALESCE(SUM(${usageRecords.requestCount}), 0)`,
      totalErrors: sql<number>`COALESCE(SUM(${usageRecords.errorCount}), 0)`,
    })
    .from(usageRecords)
    .where(where)
    .groupBy(timeBucket)
    .orderBy(timeBucket);

  return items;
}

// ─── App User Usage (from request_logs) ─────────────────────────────────────
//
// NULL-safe totals: request_logs' cache_* columns are nullable int (no default);
// persistRequestLog writes NULL for them on OpenAI/DashScope traffic (which
// doesn't report prompt cache). SUM(all-NULL column) returns NULL, and NULL +
// x = NULL, so wrapping the whole sum in ONE COALESCE — as this code once did —
// collapses the total to 0 whenever any grouped column is all-NULL (every
// OpenAI-only group). Wrap each SUM individually so a NULL column contributes 0
// instead of poisoning the addition. The same expression is shared by the
// summary, per-group select, and orderBy in both functions below. usage_records
// sidesteps this — it has a real total_tokens column and trackUsage writes 0 for
// unset cache — which is why only these two request_logs-backed pages showed 0.

export interface AppUserUsageFilters {
  appId?: number;
  featureId?: string;
  search?: string;
  startDate?: Date;
  endDate?: Date;
  page?: number;
  pageSize?: number;
}

export async function getUsageByAppUser(filters: AppUserUsageFilters) {
  const db = getDb();
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  // Build conditions for request_logs
  const conditions: SQL[] = [
    isNotNull(requestLogs.appUserId),
  ];
  if (filters.appId !== undefined) {
    conditions.push(eq(requestLogs.appId, filters.appId));
  }
  if (filters.startDate) {
    // created_at is a TIMESTAMP column read as UTC under the pinned UTC session
    // (db/index.ts); bind a UTC literal so the bound matches. See formatUtcDateTime.
    conditions.push(sql`${requestLogs.createdAt} >= ${formatUtcDateTime(filters.startDate)}`);
  }
  if (filters.endDate) {
    conditions.push(sql`${requestLogs.createdAt} <= ${formatUtcDateTime(filters.endDate)}`);
  }
  if (filters.featureId) {
    conditions.push(eq(requestLogs.featureId, filters.featureId));
  }
  if (filters.search) {
    // Fuzzy-match either the raw app_user_id on the log row or the matching
    // app_users.display_name (remark). An EXISTS subquery keeps the existing
    // select/from/groupBy chain untouched and never changes the row count: the
    // (app_id, external_uid) unique key means at most one app_users row per log
    // row, so the aggregate stays correct. likePattern escapes %/_/\ so user
    // input is treated literally. MySQL optimizes the correlated subquery.
    const p = likePattern(filters.search);
    conditions.push(
      sql`(${requestLogs.appUserId} LIKE ${p} OR EXISTS (SELECT 1 FROM ${appUsers} WHERE ${appUsers.appId} = ${requestLogs.appId} AND ${appUsers.externalUid} = ${requestLogs.appUserId} AND ${appUsers.displayName} LIKE ${p}))`,
    );
  }
  const where = and(...conditions);

  // When appId is specified, group by appUserId only; otherwise group by (appId, appUserId)
  const groupByAppId = filters.appId === undefined;

  // Get total count of distinct (appId, appUserId) pairs
  const [countResult] = await db
    .select({
      total: groupByAppId
        ? sql<number>`COUNT(DISTINCT CONCAT(IFNULL(${requestLogs.appId}, 0), '-', ${requestLogs.appUserId}))`
        : sql<number>`COUNT(DISTINCT ${requestLogs.appUserId})`,
    })
    .from(requestLogs)
    .where(where);
  const total = Number(countResult?.total ?? 0);

  // Build groupBy columns
  const groupByCols = groupByAppId
    ? [requestLogs.appId, requestLogs.appUserId]
    : [requestLogs.appUserId];

  // Get overall summary (unpaginated totals)
  const [summaryRow] = await db
    .select({
      totalPromptTokens: sql<number>`COALESCE(SUM(${requestLogs.promptTokens}), 0)`,
      totalCompletionTokens: sql<number>`COALESCE(SUM(${requestLogs.completionTokens}), 0)`,
      totalCacheReadTokens: sql<number>`COALESCE(SUM(${requestLogs.cacheReadTokens}), 0)`,
      totalCacheCreationTokens: sql<number>`COALESCE(SUM(${requestLogs.cacheCreationTokens}), 0)`,
      totalTokens: sql<number>`COALESCE(SUM(${requestLogs.promptTokens}), 0) + COALESCE(SUM(${requestLogs.completionTokens}), 0) + COALESCE(SUM(${requestLogs.cacheReadTokens}), 0) + COALESCE(SUM(${requestLogs.cacheCreationTokens}), 0)`,
      totalRequests: sql<number>`COUNT(*)`,
    })
    .from(requestLogs)
    .where(where);

  // Get aggregated usage per app user
  const items = await db
    .select({
      appId: requestLogs.appId,
      appUserId: requestLogs.appUserId,
      totalPromptTokens: sql<number>`COALESCE(SUM(${requestLogs.promptTokens}), 0)`,
      totalCompletionTokens: sql<number>`COALESCE(SUM(${requestLogs.completionTokens}), 0)`,
      totalCacheReadTokens: sql<number>`COALESCE(SUM(${requestLogs.cacheReadTokens}), 0)`,
      totalCacheCreationTokens: sql<number>`COALESCE(SUM(${requestLogs.cacheCreationTokens}), 0)`,
      totalTokens: sql<number>`COALESCE(SUM(${requestLogs.promptTokens}), 0) + COALESCE(SUM(${requestLogs.completionTokens}), 0) + COALESCE(SUM(${requestLogs.cacheReadTokens}), 0) + COALESCE(SUM(${requestLogs.cacheCreationTokens}), 0)`,
      totalRequests: sql<number>`COUNT(*)`,
    })
    .from(requestLogs)
    .where(where)
    .groupBy(...groupByCols)
    .orderBy(sql`COALESCE(SUM(${requestLogs.promptTokens}), 0) + COALESCE(SUM(${requestLogs.completionTokens}), 0) + COALESCE(SUM(${requestLogs.cacheReadTokens}), 0) + COALESCE(SUM(${requestLogs.cacheCreationTokens}), 0) DESC`)
    .limit(pageSize)
    .offset(offset);

  return {
    data: items.map((item) => ({
      appId: item.appId ?? undefined,
      appUserId: item.appUserId!,
      totalPromptTokens: Number(item.totalPromptTokens),
      totalCompletionTokens: Number(item.totalCompletionTokens),
      totalCacheReadTokens: Number(item.totalCacheReadTokens ?? 0),
      totalCacheCreationTokens: Number(item.totalCacheCreationTokens ?? 0),
      totalTokens: Number(item.totalTokens),
      totalRequests: Number(item.totalRequests),
    })),
    summary: {
      totalPromptTokens: Number(summaryRow?.totalPromptTokens ?? 0),
      totalCompletionTokens: Number(summaryRow?.totalCompletionTokens ?? 0),
      totalCacheReadTokens: Number(summaryRow?.totalCacheReadTokens ?? 0),
      totalCacheCreationTokens: Number(summaryRow?.totalCacheCreationTokens ?? 0),
      totalTokens: Number(summaryRow?.totalTokens ?? 0),
      totalRequests: Number(summaryRow?.totalRequests ?? 0),
    },
    total,
    page,
    pageSize,
  };
}

// ─── Feature Usage (from request_logs) ───────────────────────────────────────

export interface FeatureUsageFilters {
  appId?: number;
  appUserId?: string;
  search?: string;
  startDate?: Date;
  endDate?: Date;
  page?: number;
  pageSize?: number;
}

export async function getUsageByFeature(filters: FeatureUsageFilters) {
  const db = getDb();
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const conditions: SQL[] = [
    isNotNull(requestLogs.featureId),
  ];
  if (filters.appId !== undefined) {
    conditions.push(eq(requestLogs.appId, filters.appId));
  }
  if (filters.appUserId) {
    conditions.push(eq(requestLogs.appUserId, filters.appUserId));
  }
  if (filters.search) {
    // Fuzzy-match either the raw feature_id on the log row or the matching
    // features.display_name (remark). See getUsageByAppUser for the EXISTS
    // rationale (unique key keeps the row count unchanged; likePattern escapes).
    const p = likePattern(filters.search);
    conditions.push(
      sql`(${requestLogs.featureId} LIKE ${p} OR EXISTS (SELECT 1 FROM ${features} WHERE ${features.appId} = ${requestLogs.appId} AND ${features.featureId} = ${requestLogs.featureId} AND ${features.displayName} LIKE ${p}))`,
    );
  }
  if (filters.startDate) {
    // created_at is a TIMESTAMP column read as UTC under the pinned UTC session
    // (db/index.ts); bind a UTC literal so the bound matches. See formatUtcDateTime.
    conditions.push(sql`${requestLogs.createdAt} >= ${formatUtcDateTime(filters.startDate)}`);
  }
  if (filters.endDate) {
    conditions.push(sql`${requestLogs.createdAt} <= ${formatUtcDateTime(filters.endDate)}`);
  }
  const where = and(...conditions);

  const [countResult] = await db
    .select({
      total: sql<number>`COUNT(DISTINCT CONCAT(IFNULL(${requestLogs.appId}, 0), '-', ${requestLogs.featureId}))`,
    })
    .from(requestLogs)
    .where(where);
  const total = Number(countResult?.total ?? 0);

  // Get overall summary (unpaginated totals)
  const [summaryRow] = await db
    .select({
      totalPromptTokens: sql<number>`COALESCE(SUM(${requestLogs.promptTokens}), 0)`,
      totalCompletionTokens: sql<number>`COALESCE(SUM(${requestLogs.completionTokens}), 0)`,
      totalCacheReadTokens: sql<number>`COALESCE(SUM(${requestLogs.cacheReadTokens}), 0)`,
      totalCacheCreationTokens: sql<number>`COALESCE(SUM(${requestLogs.cacheCreationTokens}), 0)`,
      totalTokens: sql<number>`COALESCE(SUM(${requestLogs.promptTokens}), 0) + COALESCE(SUM(${requestLogs.completionTokens}), 0) + COALESCE(SUM(${requestLogs.cacheReadTokens}), 0) + COALESCE(SUM(${requestLogs.cacheCreationTokens}), 0)`,
      totalRequests: sql<number>`COUNT(*)`,
    })
    .from(requestLogs)
    .where(where);

  const items = await db
    .select({
      appId: requestLogs.appId,
      featureId: requestLogs.featureId,
      totalPromptTokens: sql<number>`COALESCE(SUM(${requestLogs.promptTokens}), 0)`,
      totalCompletionTokens: sql<number>`COALESCE(SUM(${requestLogs.completionTokens}), 0)`,
      totalCacheReadTokens: sql<number>`COALESCE(SUM(${requestLogs.cacheReadTokens}), 0)`,
      totalCacheCreationTokens: sql<number>`COALESCE(SUM(${requestLogs.cacheCreationTokens}), 0)`,
      totalTokens: sql<number>`COALESCE(SUM(${requestLogs.promptTokens}), 0) + COALESCE(SUM(${requestLogs.completionTokens}), 0) + COALESCE(SUM(${requestLogs.cacheReadTokens}), 0) + COALESCE(SUM(${requestLogs.cacheCreationTokens}), 0)`,
      totalRequests: sql<number>`COUNT(*)`,
    })
    .from(requestLogs)
    .where(where)
    .groupBy(requestLogs.appId, requestLogs.featureId)
    .orderBy(sql`COALESCE(SUM(${requestLogs.promptTokens}), 0) + COALESCE(SUM(${requestLogs.completionTokens}), 0) + COALESCE(SUM(${requestLogs.cacheReadTokens}), 0) + COALESCE(SUM(${requestLogs.cacheCreationTokens}), 0) DESC`)
    .limit(pageSize)
    .offset(offset);

  return {
    data: items.map((item) => ({
      appId: item.appId ?? undefined,
      featureId: item.featureId!,
      totalPromptTokens: Number(item.totalPromptTokens),
      totalCompletionTokens: Number(item.totalCompletionTokens),
      totalCacheReadTokens: Number(item.totalCacheReadTokens ?? 0),
      totalCacheCreationTokens: Number(item.totalCacheCreationTokens ?? 0),
      totalTokens: Number(item.totalTokens),
      totalRequests: Number(item.totalRequests),
    })),
    summary: {
      totalPromptTokens: Number(summaryRow?.totalPromptTokens ?? 0),
      totalCompletionTokens: Number(summaryRow?.totalCompletionTokens ?? 0),
      totalCacheReadTokens: Number(summaryRow?.totalCacheReadTokens ?? 0),
      totalCacheCreationTokens: Number(summaryRow?.totalCacheCreationTokens ?? 0),
      totalTokens: Number(summaryRow?.totalTokens ?? 0),
      totalRequests: Number(summaryRow?.totalRequests ?? 0),
    },
    total,
    page,
    pageSize,
  };
}
