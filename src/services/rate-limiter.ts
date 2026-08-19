import { eq, and } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { rateLimits } from '../db/schema.js';
import { getRedis } from '../redis/index.js';
import { getConfig } from '../config/index.js';

/** Fallback limits applied when a target has no explicit record in `rate_limits`. */
const DEFAULT_QPS = 10;
const DEFAULT_RPM = 60;

// Token-bucket rate limiting backed by Redis so the limit is shared across all
// pods (single-instance Map scaled N× under horizontal scaling). The bucket
// math runs as an atomic Lua script (scripts.ts RATE_LIMIT_LUA) — one eval
// handles both the qps and rpm buckets, so concurrent pods can't lose updates.
// Redis failures degrade fail-open (see checkRateLimit): a transient outage
// briefly disables rate limiting rather than blocking traffic.

export async function checkRateLimit(
  targetType: 'global' | 'app' | 'user' | 'api_key',
  targetId: number | null
): Promise<boolean> {
  const db = getDb();

  const condition =
    targetId !== null
      ? and(
          eq(rateLimits.targetType, targetType),
          eq(rateLimits.targetId, targetId)
        )
      : eq(rateLimits.targetType, targetType);

  const [limit] = await db
    .select()
    .from(rateLimits)
    .where(condition)
    .limit(1);

  const qps = limit?.qps ?? DEFAULT_QPS;
  const rpm = limit?.rpm ?? DEFAULT_RPM;

  const prefix = getConfig().redis.keyPrefix;
  const bucket = `${targetType}:${targetId ?? 'global'}`;

  try {
    const r = getRedis();
    // rateLimit(qpsKey, rpmKey, now, qpsCap, qpsRefill, rpmCap, rpmRefill).
    // qps bucket: capacity=qps, refills at qps/s. rpm bucket: capacity=rpm,
    // refills at rpm/60 per s. Mirrors the prior in-process TokenBucket.
    const ok = await r.rateLimit(
      `${prefix}ratelimit:${bucket}:qps`,
      `${prefix}ratelimit:${bucket}:rpm`,
      Date.now(),
      qps,
      qps,
      rpm,
      rpm / 60,
    );
    return ok === 1;
  } catch {
    // fail-open: Redis unreachable → allow the request. Rate limiting is a
    // protective measure; a brief outage is preferable to blocking traffic.
    return true;
  }
}

// Buckets self-expire via PEXPIRE in the Lua script, so there is no in-process
// cleanup to schedule. These are kept as no-ops so app.ts / index.ts keep their
// existing start/stop call sites unchanged.
export function startCleanup(): void {}

export function stopCleanup(): void {}
