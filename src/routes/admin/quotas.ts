import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { apiKeys, users, apps } from '../../db/schema.js';
import {
  sumTokensUsed,
  getRateLimitConfig,
  getDayStart,
  getMonthStart,
  getPrevMonthStart,
  type QuotaTargetType,
} from '../../services/quota.js';

export const adminQuotas = new Hono();

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalise the URL param to our internal type + DB table.
 * Accepts: api_keys, users, apps (plural to match REST convention).
 */
function resolveTarget(param: string): {
  type: QuotaTargetType;
  table: typeof apiKeys | typeof users | typeof apps;
} | null {
  switch (param) {
    case 'api_keys': return { type: 'api_key', table: apiKeys };
    case 'users':    return { type: 'user',    table: users };
    case 'apps':     return { type: 'app',     table: apps };
    default: return null;
  }
}

// ── POST /:type/:id/restore ─────────────────────────────────────────────────

adminQuotas.post('/:type/:id/restore', async (c) => {
  const typeParam = c.req.param('type');
  const id = Number(c.req.param('id'));

  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'invalid_id' }, 400);
  }

  const resolved = resolveTarget(typeParam);
  if (!resolved) {
    return c.json({ error: 'invalid_type', valid: ['api_keys', 'users', 'apps'] }, 400);
  }

  const db = getDb();
  const [target] = await db
    .select()
    .from(resolved.table)
    .where(eq(resolved.table.id, id))
    .limit(1);

  if (!target) {
    return c.json({ error: 'not_found', type: resolved.type, id }, 404);
  }

  if (target.status !== 'quota_exceeded') {
    return c.json({
      error: 'not_quota_exceeded',
      currentStatus: target.status,
    }, 400);
  }

  await db
    .update(resolved.table)
    .set({ status: 'active' })
    .where(eq(resolved.table.id, id));

  return c.json({
    success: true,
    type: resolved.type,
    id,
    previousStatus: 'quota_exceeded',
    newStatus: 'active',
  });
});

// ── GET /quotas/:type/:id ───────────────────────────────────────────────────

adminQuotas.get('/quotas/:type/:id', async (c) => {
  const typeParam = c.req.param('type');
  const id = Number(c.req.param('id'));

  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'invalid_id' }, 400);
  }

  const resolved = resolveTarget(typeParam);
  if (!resolved) {
    return c.json({ error: 'invalid_type', valid: ['api_keys', 'users', 'apps'] }, 400);
  }

  const db = getDb();

  // Load target for status
  const [target] = await db
    .select()
    .from(resolved.table)
    .where(eq(resolved.table.id, id))
    .limit(1);

  if (!target) {
    return c.json({ error: 'not_found', type: resolved.type, id }, 404);
  }

  // Load rate limit config
  const limit = await getRateLimitConfig(resolved.type, id);

  // Load current usage. lastMonth is the full previous natural month
  // [prevMonthStart, monthStart) — a settled historical figure shown on the
  // dashboard for month-over-month comparison (no percentage: last month has
  // no live limit to measure against).
  const [dailyUsed, monthlyUsed, lastMonthUsed] = await Promise.all([
    sumTokensUsed({ type: resolved.type, id }, getDayStart()),
    sumTokensUsed({ type: resolved.type, id }, getMonthStart()),
    sumTokensUsed({ type: resolved.type, id }, getPrevMonthStart(), getMonthStart()),
  ]);

  const limits: Record<string, number | null> = {
    dailyTokens: limit?.dailyTokens ?? null,
    monthlyTokens: limit?.monthlyTokens ?? null,
  };

  const todayUsage: { tokens: number; percentage?: number } = { tokens: dailyUsed };
  if (limit?.dailyTokens != null && limit.dailyTokens > 0) {
    todayUsage.percentage = Math.round((dailyUsed / limit.dailyTokens) * 100);
  }

  const monthUsage: { tokens: number; percentage?: number } = { tokens: monthlyUsed };
  if (limit?.monthlyTokens != null && limit.monthlyTokens > 0) {
    monthUsage.percentage = Math.round((monthlyUsed / limit.monthlyTokens) * 100);
  }

  return c.json({
    type: resolved.type,
    id,
    status: target.status,
    limits,
    usage: {
      today: todayUsage,
      month: monthUsage,
      lastMonth: { tokens: lastMonthUsed },
    },
  });
});
