import { getRedis } from '../redis/index.js';
import { getConfig } from '../config/index.js';

export interface QuotaCacheEntry {
  dailyUsed: number;
  monthlyUsed: number;
}

// TTL matches the prior in-process cache (5s). The DB-backed sumTokensUsed
// re-queries on miss, and incrementQuotaCache bridges the gap until the next
// miss. Crucially the key now lives in Redis, so increments are visible
// cluster-wide — the in-process Map was per-pod, which let multi-pod traffic
// blow through the quota precheck near the limit.
export const CACHE_TTL_MS = 5_000;
const CACHE_TTL_SEC = Math.ceil(CACHE_TTL_MS / 1000);

// Prefix every key with the configured Redis keyPrefix so all gateway services
// share one namespace. Callers pass a logical key like "quota:api_key:1".
// (We don't use ioredis keyPrefix because it doesn't apply inside Lua scripts.)
function prefixed(key: string): string {
  return `${getConfig().redis.keyPrefix}${key}`;
}

/**
 * Get cache entry if it exists and is within TTL.
 * Returns null on cache miss, expiry, or Redis error (fail-open → caller
 * falls back to a direct DB query in quota-check).
 */
export async function getQuotaCache(key: string): Promise<QuotaCacheEntry | null> {
  try {
    const raw = await getRedis().get(prefixed(key));
    if (!raw) return null;
    const obj = JSON.parse(raw) as QuotaCacheEntry;
    return { dailyUsed: obj.dailyUsed, monthlyUsed: obj.monthlyUsed };
  } catch {
    return null;
  }
}

/**
 * Store or overwrite a cache entry with TTL.
 */
export async function setQuotaCache(
  key: string,
  data: { dailyUsed: number; monthlyUsed: number },
): Promise<void> {
  try {
    await getRedis().set(
      prefixed(key),
      JSON.stringify({ dailyUsed: data.dailyUsed, monthlyUsed: data.monthlyUsed }),
      'EX',
      CACHE_TTL_SEC,
    );
  } catch {
    // fail-open: a write failure just means the next read misses and re-queries
    // the DB. Swallow to avoid surfacing Redis errors to callers.
  }
}

/**
 * Optimistically increment daily and monthly usage for a key.
 * Atomic via Lua (QUOTA_INCR_LUA): GET→update→SET in one script, so concurrent
 * pods can't lose updates. No-op if the entry is absent (matches prior
 * in-process semantics — a miss is rebuilt by the precheck side).
 */
export async function incrementQuotaCache(key: string, tokens: number): Promise<void> {
  try {
    await getRedis().quotaIncr(prefixed(key), tokens, CACHE_TTL_SEC);
  } catch {
    // fail-open: cache drifts slightly until the next TTL expiry re-seeds from
    // the DB. Swallow.
  }
}

/**
 * No-op. Redis TTL self-expires entries, and clearing the shared cache across
 * all pods (SCAN+DEL) is only useful in tests. Kept for existing call sites.
 */
export function clearQuotaCache(): void {}

// ── rate_limits CONFIG cache ─────────────────────────────────────────────────
// Reads of the rate_limits row happen on EVERY request (quota precheck per
// target, post-response checkQuota, and the rate limiter) even though the
// config almost never changes — that was 2-6 uncached point queries per
// request. Cached here with the same short TTL as usage; the admin PUT path
// invalidates explicitly so config changes apply immediately.

/** Cached shape: the business fields of a rate_limits row (no timestamps —
 *  Date doesn't round-trip through JSON and no consumer reads them). */
export interface CachedRateLimitRow {
  id: number;
  targetType: string;
  targetId: number | null;
  rpm: number;
  qps: number;
  dailyTokens: number | null;
  monthlyTokens: number | null;
}

export function rateLimitConfigCacheKey(type: string, id: number | null): string {
  return `ratelimit:cfg:${type}:${id ?? 'global'}`;
}

/**
 * Returns the cached row, null when "no config exists" is itself cached
 * (the overwhelmingly common case — most targets have no rate_limits row,
 * so caching the absence is where most of the savings come from), or
 * undefined on miss / Redis error (caller falls back to the DB).
 */
export async function getRateLimitConfigCache(
  key: string,
): Promise<CachedRateLimitRow | null | undefined> {
  try {
    const raw = await getRedis().get(prefixed(key));
    if (raw === null) return undefined; // key absent → genuine miss
    return JSON.parse(raw) as CachedRateLimitRow | null;
  } catch {
    return undefined;
  }
}

export async function setRateLimitConfigCache(
  key: string,
  row: CachedRateLimitRow | null,
): Promise<void> {
  try {
    await getRedis().set(prefixed(key), JSON.stringify(row), 'EX', CACHE_TTL_SEC);
  } catch {
    // fail-open: next read misses and re-queries the DB
  }
}

export async function invalidateRateLimitConfig(type: string, id: number | null): Promise<void> {
  try {
    await getRedis().del(prefixed(rateLimitConfigCacheKey(type, id)));
  } catch {
    // fail-open: entry self-expires via TTL anyway
  }
}

// ── Cleanup (no-op, preserved for app.ts / index.ts call sites) ──────────────
// Entries now expire via Redis EX, so there is no in-process cleanup to run.

export function startQuotaCacheCleanup(): void {}

export function stopQuotaCacheCleanup(): void {}
