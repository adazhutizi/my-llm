import { Context, Next } from 'hono';
import type { AuthContext } from './auth.js';
import {
  buildQuotaChecks,
  extractMaxTokens,
  sumTokensUsed,
  getRateLimitConfig,
  getDayStart,
  getMonthStart,
} from '../services/quota.js';
import { getQuotaCache, setQuotaCache } from '../services/quota-cache.js';
import { Errors, formatErrorForPath } from '../utils/errors.js';

/**
 * Read cached daily/monthly usage for a target, falling back to DB query.
 * Returns { dailyUsed, monthlyUsed } in tokens.
 */
async function getCachedUsage(
  type: 'app' | 'user' | 'api_key',
  id: number,
): Promise<{ dailyUsed: number; monthlyUsed: number }> {
  const cacheKey = `quota:${type}:${id}`;
  const cached = await getQuotaCache(cacheKey);

  if (cached) {
    return { dailyUsed: cached.dailyUsed, monthlyUsed: cached.monthlyUsed };
  }

  // Cache miss — query DB for both daily and monthly
  const dayStart = getDayStart();
  const monthStart = getMonthStart();

  const [dailyUsed, monthlyUsed] = await Promise.all([
    sumTokensUsed({ type, id }, dayStart),
    sumTokensUsed({ type, id }, monthStart),
  ]);

  await setQuotaCache(cacheKey, { dailyUsed, monthlyUsed });
  return { dailyUsed, monthlyUsed };
}

export async function quotaCheckMiddleware(c: Context, next: Next) {
  // GET requests have no body — skip token estimation (e.g. GET /openai/v1/models)
  if (c.req.method === 'GET') {
    c.set('estimatedTokens', 0);
    return next();
  }

  const auth = c.get('auth') as AuthContext;

  // For dedicated mode, skip token estimation — request body format is unknown
  if (auth.mode === 'dedicated') {
    c.set('estimatedTokens', 0);
    return next();
  }

  const checks = buildQuotaChecks(auth);
  const path = c.req.path;

  // Parse body (Hono caches the result internally — downstream can re-read)
  const body = await c.req.json().catch(() => null);
  const estimatedTokens = extractMaxTokens(body, path);

  for (const check of checks) {
    const limit = await getRateLimitConfig(check.type, check.id);
    if (!limit) continue;

    const { dailyUsed, monthlyUsed } = await getCachedUsage(check.type, check.id);

    if (limit.dailyTokens != null) {
      if (dailyUsed + estimatedTokens > limit.dailyTokens) {
        const error = Errors.quotaExceeded(
          `daily token quota exceeded (used: ${dailyUsed}, requested: ${estimatedTokens}, limit: ${limit.dailyTokens})`
        );
        return c.json(formatErrorForPath(path, error), 429);
      }
    }

    if (limit.monthlyTokens != null) {
      if (monthlyUsed + estimatedTokens > limit.monthlyTokens) {
        const error = Errors.quotaExceeded(
          `monthly token quota exceeded (used: ${monthlyUsed}, requested: ${estimatedTokens}, limit: ${limit.monthlyTokens})`
        );
        return c.json(formatErrorForPath(path, error), 429);
      }
    }
  }

  c.set('estimatedTokens', estimatedTokens);
  await next();
}
