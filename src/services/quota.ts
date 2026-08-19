import { eq, and, gte, lt, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { rateLimits, usageRecords, users, apiKeys, apps } from '../db/schema.js';
import type { AuthContext } from '../middleware/auth.js';

export const DEFAULT_MAX_TOKENS = 4096;

export type QuotaTargetType = 'app' | 'user' | 'api_key';

export interface QuotaCheck {
  type: QuotaTargetType;
  id: number;
}

// Quota cycles are measured in Beijing time (UTC+8): a "day" runs from
// 00:00 to 24:00 CST, matching what admins expect on the dashboard. The
// returned Date is a UTC instant (the lower bound for usage_records queries).
const QUOTA_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * Start of the current quota day in Beijing time (UTC+8), as a UTC Date.
 */
export function getDayStart(): Date {
  const now = new Date();
  // Shift into Beijing wall-clock, truncate to the day, then shift back to UTC.
  const bj = new Date(now.getTime() + QUOTA_TZ_OFFSET_MS);
  return new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - QUOTA_TZ_OFFSET_MS);
}

/**
 * Start of the current quota month in Beijing time (UTC+8), as a UTC Date.
 */
export function getMonthStart(): Date {
  const now = new Date();
  const bj = new Date(now.getTime() + QUOTA_TZ_OFFSET_MS);
  return new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), 1) - QUOTA_TZ_OFFSET_MS);
}

/**
 * Start of the previous quota month in Beijing time (UTC+8), as a UTC Date.
 * Used to report last month's usage on the dashboard (the full natural month
 * before the current quota month). month-1 rolls back into December of the
 * prior year automatically (Date.UTC normalises a negative month).
 */
export function getPrevMonthStart(): Date {
  const now = new Date();
  const bj = new Date(now.getTime() + QUOTA_TZ_OFFSET_MS);
  return new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth() - 1, 1) - QUOTA_TZ_OFFSET_MS);
}

/**
 * Extract max_tokens from an OpenAI or Anthropic request body.
 * Returns DEFAULT_MAX_TOKENS if absent or invalid.
 */
export function extractMaxTokens(body: unknown, path: string): number {
  // Image generation does not consume tokens
  if (path.includes('/images/generations')) return 0;

  if (!body || typeof body !== 'object') return DEFAULT_MAX_TOKENS;

  const raw = (body as Record<string, unknown>).max_tokens;
  if (typeof raw !== 'number' || raw <= 0) return DEFAULT_MAX_TOKENS;

  return raw;
}

/**
 * Build ordered quota check targets from auth context.
 * Order: app -> user -> api_key (only includes present targets).
 */
export function buildQuotaChecks(auth: AuthContext): QuotaCheck[] {
  const checks: QuotaCheck[] = [];

  if (auth.appId != null) {
    checks.push({ type: 'app', id: auth.appId });
  }
  if (auth.userId != null) {
    checks.push({ type: 'user', id: auth.userId });
  }
  checks.push({ type: 'api_key', id: auth.keyId });

  return checks;
}

/**
 * Maps quota target type to the corresponding FK column on usage_records.
 */
export function quotaTargetColumn(type: QuotaTargetType): 'apiKeyId' | 'userId' | 'appId' {
  switch (type) {
    case 'api_key': return 'apiKeyId';
    case 'user': return 'userId';
    case 'app': return 'appId';
  }
}

/**
 * Sum total tokens used by a target in a half-open time range [since, until).
 * `until` is optional for backward compatibility (open-ended upper bound).
 * Used for daily/monthly usage (since only) and last-month usage
 * (since = prev month start, until = current month start).
 *
 * NOTE: this function queries usage_records directly — the 5s precheck cache
 * lives one layer up in quota-check.ts and only caches daily/monthly, so
 * adding `until` here cannot collide with it.
 */
export async function sumTokensUsed(
  check: QuotaCheck,
  since: Date,
  until?: Date,
): Promise<number> {
  const db = getDb();
  const column = usageRecords[quotaTargetColumn(check.type)];

  const conditions = [
    eq(column, check.id),
    gte(usageRecords.recordTime, since),
  ];
  if (until) conditions.push(lt(usageRecords.recordTime, until));

  const [result] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${usageRecords.totalTokens}), 0)`,
    })
    .from(usageRecords)
    .where(and(...conditions));

  return Number(result?.total ?? 0);
}

/**
 * Load rate_limits configuration for a specific target.
 * Returns null if no rate_limits row exists for this target.
 */
export async function getRateLimitConfig(
  type: QuotaTargetType | 'global',
  id: number | null,
) {
  const db = getDb();

  const condition = id !== null
    ? and(eq(rateLimits.targetType, type), eq(rateLimits.targetId, id))
    : eq(rateLimits.targetType, type);

  const [limit] = await db
    .select()
    .from(rateLimits)
    .where(condition)
    .limit(1);

  return limit ?? null;
}

/**
 * Check whether a target is CURRENTLY over quota (DB-accurate — uses
 * sumTokensUsed, which queries usage_records directly, NOT the 5s precheck
 * cache). Shared by the post-response auto-disable (usage-track) and the
 * on-request lazy restore (auth) so the two can never drift apart. "Over"
 * means the daily OR monthly limit is met/exceeded; a target with no
 * rate_limits row is never over quota.
 */
export async function checkQuota(
  check: QuotaCheck,
): Promise<{ over: boolean; reason?: string }> {
  const limit = await getRateLimitConfig(check.type, check.id);
  if (!limit) return { over: false };

  if (limit.dailyTokens != null) {
    const used = await sumTokensUsed(check, getDayStart());
    if (used >= limit.dailyTokens) {
      return { over: true, reason: `daily token quota exceeded (used: ${used}, limit: ${limit.dailyTokens})` };
    }
  }
  if (limit.monthlyTokens != null) {
    const used = await sumTokensUsed(check, getMonthStart());
    if (used >= limit.monthlyTokens) {
      return { over: true, reason: `monthly token quota exceeded (used: ${used}, limit: ${limit.monthlyTokens})` };
    }
  }
  return { over: false };
}

/**
 * Write a target's status. Shared by the auto-disable (→ quota_exceeded) and
 * the lazy/manual restore (→ active). There is no DB-level foreign key
 * (project convention: no relations()), so this is the single place that
 * flips the status column on users / api_keys / apps. Callers always pass a
 * status that is valid for all three enums ('active' | 'quota_exceeded').
 */
export async function setTargetStatus(
  type: QuotaTargetType,
  id: number,
  status: 'active' | 'quota_exceeded',
): Promise<void> {
  const db = getDb();
  if (type === 'api_key') {
    await db.update(apiKeys).set({ status }).where(eq(apiKeys.id, id));
  } else if (type === 'user') {
    await db.update(users).set({ status }).where(eq(users.id, id));
  } else {
    await db.update(apps).set({ status }).where(eq(apps.id, id));
  }
}

/**
 * Lazy restore: if a target was auto-disabled but its usage has since dropped
 * below BOTH limits — because the quota day/month rolled over past midnight
 * Beijing time (getDayStart/getMonthStart advanced, usage counter reset to 0),
 * or an admin raised the limit — flip it back to active. Returns true when
 * restored.
 *
 * Called from authMiddleware on every request that hits a quota_exceeded
 * target, so restoration is automatic and zero-delay with no background timer.
 * Deliberately uses DB-accurate checkQuota (not the 5s precheck cache): a
 * false "restored" would let an actually-over-quota target back in.
 */
export async function tryRestoreQuota(
  type: QuotaTargetType,
  id: number,
): Promise<boolean> {
  const { over } = await checkQuota({ type, id });
  if (over) return false;
  await setTargetStatus(type, id, 'active');
  return true;
}
