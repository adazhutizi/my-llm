import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { uaPolicies } from '../../db/schema.js';
import {
  UaPolicySchema,
  checkUaPatternSafety,
  invalidateUaPolicyConfig,
  type UaTargetType,
} from '../../services/ua-policy.js';

export const adminUaPolicies = new Hono();

const TARGET_TYPES: readonly UaTargetType[] = ['global', 'app', 'user', 'api_key'];

// Shared query-condition builder: target_id is NULL for the global row, and
// drizzle's eq() can't match NULL — same pattern as rate-limits.ts.
function targetCondition(targetType: UaTargetType, targetId: number | null) {
  return targetId !== null
    ? and(eq(uaPolicies.targetType, targetType), eq(uaPolicies.targetId, targetId))
    : and(eq(uaPolicies.targetType, targetType), sql`${uaPolicies.targetId} IS NULL`);
}

// GET /admin/ua-policies - list policies, optionally filtered by targetType/targetId
adminUaPolicies.get('/', async (c) => {
  const db = getDb();
  const targetType = c.req.query('targetType') as UaTargetType | undefined;
  const targetId = c.req.query('targetId') ? Number(c.req.query('targetId')) : undefined;

  const conditions = [];
  if (targetType) conditions.push(eq(uaPolicies.targetType, targetType));
  if (targetId !== undefined) conditions.push(eq(uaPolicies.targetId, targetId));

  const items = await db
    .select()
    .from(uaPolicies)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  return c.json({ data: items });
});

// PUT /admin/ua-policies - set a policy (upsert by targetType+targetId).
// body: { targetType, targetId?, mode: 'block'|'allow', patterns: string[] }
adminUaPolicies.put('/', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const targetType = body.targetType as UaTargetType | undefined;
  if (!targetType || !TARGET_TYPES.includes(targetType)) {
    return c.json({ error: 'targetType is required and must be global, app, user, or api_key' }, 400);
  }

  // global must carry no targetId; other types must carry a positive one.
  let targetId: number | null = null;
  if (targetType !== 'global') {
    const raw = body.targetId as unknown;
    targetId = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return c.json({ error: 'targetId is required and must be a positive integer for non-global targets' }, 400);
    }
  }

  // Zod + per-pattern safety validation. Persisting a malformed/dangerous
  // pattern would either fail-open at runtime (silently discarding the
  // admin's intent — same rationale as permissions.modelPolicy validation)
  // or, for catastrophic-backtracking shapes, burn CPU on every request.
  const parsed = UaPolicySchema.safeParse({ mode: body.mode, patterns: body.patterns });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json({ error: `invalid policy${issue.path.length > 0 ? ` at "${issue.path.join('.')}"` : ''}: ${issue.message}` }, 400);
  }
  const { mode, patterns } = parsed.data;

  if (mode === 'allow' && patterns.length === 0) {
    // An empty allow list denies EVERYTHING — almost certainly a mistake.
    // Clearing a restriction is DELETE's job.
    return c.json({ error: '白名单的 patterns 不能为空（空白名单会拒绝全部请求）；如需清除限制请用 DELETE' }, 400);
  }

  for (let i = 0; i < patterns.length; i++) {
    const problem = checkUaPatternSafety(patterns[i]);
    if (problem) {
      return c.json({ error: `patterns[${i}] 被拒绝: ${problem}` }, 400);
    }
  }

  const db = getDb();
  const existing = await db
    .select({ id: uaPolicies.id })
    .from(uaPolicies)
    .where(targetCondition(targetType, targetId))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(uaPolicies)
      .set({ mode, patterns })
      .where(eq(uaPolicies.id, existing[0].id));
  } else {
    await db.insert(uaPolicies).values({ targetType, targetId, mode, patterns });
  }

  // Drop the cached row (value OR null sentinel) so the change applies on the
  // very next request instead of after the 5s TTL.
  await invalidateUaPolicyConfig(targetType, targetId);

  const [row] = await db
    .select()
    .from(uaPolicies)
    .where(targetCondition(targetType, targetId))
    .limit(1);

  return c.json({ data: row }, existing.length > 0 ? 200 : 201);
});

// DELETE /admin/ua-policies?targetType=&targetId= - remove a policy (restore
// "unrestricted"). Idempotent: deleting an absent row still returns 200.
adminUaPolicies.delete('/', async (c) => {
  const targetType = c.req.query('targetType') as UaTargetType | undefined;
  if (!targetType || !TARGET_TYPES.includes(targetType)) {
    return c.json({ error: 'targetType is required and must be global, app, user, or api_key' }, 400);
  }

  const rawId = c.req.query('targetId');
  let targetId: number | null = null;
  if (targetType !== 'global') {
    if (rawId === undefined) {
      return c.json({ error: 'targetId is required and must be a positive integer for non-global targets' }, 400);
    }
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'targetId is required and must be a positive integer for non-global targets' }, 400);
    }
    targetId = id;
  }

  const db = getDb();
  await db.delete(uaPolicies).where(targetCondition(targetType, targetId));

  // A residual cached value OR null sentinel would go stale after deletion.
  await invalidateUaPolicyConfig(targetType, targetId);

  return c.json({ success: true });
});
