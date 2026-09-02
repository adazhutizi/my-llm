import { Hono } from 'hono';
import { getDb } from '../../db/index.js';
import { rateLimits } from '../../db/schema.js';
import { eq, and, sql, type SQL } from 'drizzle-orm';
import { invalidateRateLimitConfig } from '../../services/quota-cache.js';

export const adminRateLimits = new Hono();

// GET /admin/rate-limits - query rate limit config
adminRateLimits.get('/', async (c) => {
  const db = getDb();
  const targetType = c.req.query('targetType') as 'global' | 'app' | 'user' | 'api_key' | undefined;
  const targetId = c.req.query('targetId') ? Number(c.req.query('targetId')) : undefined;

  const conditions: SQL[] = [];
  if (targetType) {
    conditions.push(eq(rateLimits.targetType, targetType));
  }
  if (targetId !== undefined) {
    conditions.push(eq(rateLimits.targetId, targetId));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const items = await db
    .select()
    .from(rateLimits)
    .where(where);

  return c.json({ data: items });
});

// PUT /admin/rate-limits - set rate limit (upsert by targetType+targetId)
adminRateLimits.put('/', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const targetType = body.targetType as 'global' | 'app' | 'user' | 'api_key' | undefined;
  if (!targetType || !['global', 'app', 'user', 'api_key'].includes(targetType)) {
    return c.json({ error: 'targetType is required and must be global, app, user, or api_key' }, 400);
  }

  const targetId = (body.targetId as number) ?? null;
  const rpm = (body.rpm as number) ?? 60;
  const qps = (body.qps as number) ?? 10;
  const dailyTokens = body.dailyTokens as number | undefined;
  const monthlyTokens = body.monthlyTokens as number | undefined;

  const db = getDb();

  // Check if a rate limit entry already exists for this target
  const targetIdCondition = targetId !== null
    ? eq(rateLimits.targetId, targetId)
    : sql`${rateLimits.targetId} IS NULL`;

  const existing = await db
    .select()
    .from(rateLimits)
    .where(and(eq(rateLimits.targetType, targetType), targetIdCondition))
    .limit(1);

  if (existing.length > 0) {
    // Update existing
    await db
      .update(rateLimits)
      .set({
        rpm,
        qps,
        dailyTokens: dailyTokens ?? null,
        monthlyTokens: monthlyTokens ?? null,
      })
      .where(eq(rateLimits.id, existing[0].id));

    // Drop the cached config row so the new limits apply on the very next
    // request instead of after the 5s TTL.
    await invalidateRateLimitConfig(targetType, targetId);

    const updated = await db
      .select()
      .from(rateLimits)
      .where(eq(rateLimits.id, existing[0].id))
      .limit(1);

    return c.json({ data: updated[0] });
  } else {
    // Insert new
    await db.insert(rateLimits).values({
      targetType,
      targetId,
      rpm,
      qps,
      dailyTokens: dailyTokens ?? null,
      monthlyTokens: monthlyTokens ?? null,
    });

    // A previously-cached "no config" entry must go too — this target may
    // have been read (and its absence cached) moments before creation.
    await invalidateRateLimitConfig(targetType, targetId);

    const inserted = await db
      .select()
      .from(rateLimits)
      .where(and(eq(rateLimits.targetType, targetType), targetIdCondition))
      .limit(1);

    return c.json({ data: inserted[0] }, 201);
  }
});
