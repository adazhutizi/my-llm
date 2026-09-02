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
import {
  parseModelPolicy,
  isModelAllowed,
  getModelLimit,
} from '../services/model-policy.js';
import { getQuotaCache, setQuotaCache } from '../services/quota-cache.js';
import { Errors, formatErrorForPath } from '../utils/errors.js';

/**
 * Read cached daily/monthly usage for a target, falling back to DB query.
 * Returns { dailyUsed, monthlyUsed } in tokens.
 * With `model`, scopes the usage to that single virtual model id (per-key
 * model limits) — the cache key gains a model segment so the total and
 * per-model buckets coexist without collisions.
 */
async function getCachedUsage(
  type: 'app' | 'user' | 'api_key',
  id: number,
  model?: string,
): Promise<{ dailyUsed: number; monthlyUsed: number }> {
  const cacheKey = model !== undefined
    ? `quota:${type}:${id}:model:${model}`
    : `quota:${type}:${id}`;
  const cached = await getQuotaCache(cacheKey);

  if (cached) {
    return { dailyUsed: cached.dailyUsed, monthlyUsed: cached.monthlyUsed };
  }

  // Cache miss — query DB for both daily and monthly
  const dayStart = getDayStart();
  const monthStart = getMonthStart();

  const [dailyUsed, monthlyUsed] = await Promise.all([
    sumTokensUsed({ type, id }, dayStart, undefined, model),
    sumTokensUsed({ type, id }, monthStart, undefined, model),
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

  // ── Per-key model policy (allow/block list + per-model token limits) ──────
  // Matches the client's body.model string (virtual model id) — deliberately
  // not anything resolved via virtual_models, so the PREFIX_MAP fallback
  // (unregistered gpt-/claude- names that still route) cannot bypass the list.
  // Rejected-before-403 runs before the total-quota loop: an unusable model
  // is a permission answer, not a quota answer.
  const rawModel = (body as Record<string, unknown> | null)?.model;
  const modelId = typeof rawModel === 'string' && rawModel.length > 0 ? rawModel : null;

  if (modelId) {
    const policy = parseModelPolicy(auth.permissions);

    if (!isModelAllowed(policy, modelId)) {
      const error = Errors.modelNotAllowed(modelId);
      return c.json(formatErrorForPath(path, error), error.statusCode);
    }

    const modelLimit = getModelLimit(policy, modelId);
    if (modelLimit) {
      const { dailyUsed, monthlyUsed } = await getCachedUsage('api_key', auth.keyId, modelId);

      if (modelLimit.dailyTokens != null) {
        if (dailyUsed + estimatedTokens > modelLimit.dailyTokens) {
          const error = Errors.quotaExceeded(
            `daily token quota exceeded for model ${modelId} (used: ${dailyUsed}, requested: ${estimatedTokens}, limit: ${modelLimit.dailyTokens})`
          );
          return c.json(formatErrorForPath(path, error), 429);
        }
      }

      if (modelLimit.monthlyTokens != null) {
        if (monthlyUsed + estimatedTokens > modelLimit.monthlyTokens) {
          const error = Errors.quotaExceeded(
            `monthly token quota exceeded for model ${modelId} (used: ${monthlyUsed}, requested: ${estimatedTokens}, limit: ${modelLimit.monthlyTokens})`
          );
          return c.json(formatErrorForPath(path, error), 429);
        }
      }
    }
  }

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
