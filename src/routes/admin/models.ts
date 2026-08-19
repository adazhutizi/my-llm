import { Hono } from 'hono';
import { getDb } from '../../db/index.js';
import { virtualModels } from '../../db/schema.js';
import { eq, sql, count } from 'drizzle-orm';

export const adminModels = new Hono();

// GET /admin/models - list virtual models
adminModels.get('/', async (c) => {
  const db = getDb();

  const items = await db
    .select()
    .from(virtualModels)
    .orderBy(sql`${virtualModels.createdAt} DESC`);

  return c.json({ data: items });
});

// POST /admin/models - create virtual model
adminModels.post('/', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const modelId = body.modelId as string | undefined;
  const displayName = body.displayName as string | undefined;
  const provider = body.provider as string | undefined;
  const realModel = body.realModel as string | undefined;

  if (!modelId || !displayName || !provider || !realModel) {
    return c.json({ error: 'modelId, displayName, provider, and realModel are required' }, 400);
  }

  const db = getDb();

  await db.insert(virtualModels).values({
    modelId,
    displayName,
    provider,
    realModel,
    fallbacks: (body.fallbacks as unknown[]) ?? null,
    isActive: (body.isActive as boolean) ?? true,
  });

  const results = await db
    .select()
    .from(virtualModels)
    .where(eq(virtualModels.modelId, modelId))
    .limit(1);

  return c.json({ data: results[0] }, 201);
});

// PATCH /admin/models/:id - update virtual model
adminModels.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid model ID' }, 400);
  }

  const db = getDb();

  const existing = await db
    .select()
    .from(virtualModels)
    .where(eq(virtualModels.id, id))
    .limit(1);

  if (!existing[0]) {
    return c.json({ error: 'Virtual model not found' }, 404);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const setFields: Record<string, unknown> = {};
  if (body.modelId !== undefined) setFields.modelId = body.modelId;
  if (body.displayName !== undefined) setFields.displayName = body.displayName;
  if (body.provider !== undefined) setFields.provider = body.provider;
  if (body.realModel !== undefined) setFields.realModel = body.realModel;
  if (body.fallbacks !== undefined) setFields.fallbacks = body.fallbacks;
  if (body.isActive !== undefined) setFields.isActive = body.isActive;

  if (Object.keys(setFields).length > 0) {
    await db.update(virtualModels).set(setFields).where(eq(virtualModels.id, id));
  }

  const updated = await db
    .select()
    .from(virtualModels)
    .where(eq(virtualModels.id, id))
    .limit(1);

  return c.json({ data: updated[0] });
});

// DELETE /admin/models/:id - delete virtual model (only if disabled)
adminModels.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid model ID' }, 400);
  }

  const db = getDb();

  const [existing] = await db
    .select()
    .from(virtualModels)
    .where(eq(virtualModels.id, id))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Virtual model not found' }, 404);
  }

  if (existing.isActive) {
    return c.json({ error: '模型正在使用中，请先禁用后再删除' }, 400);
  }

  await db.delete(virtualModels).where(eq(virtualModels.id, id));
  return c.json({ data: { message: 'Virtual model deleted' } });
});
