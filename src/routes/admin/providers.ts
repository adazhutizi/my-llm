import { Hono } from 'hono';
import { getDb } from '../../db/index.js';
import { providers } from '../../db/schema.js';
import { eq, sql } from 'drizzle-orm';

export const adminProviders = new Hono();

// GET /admin/providers - list providers
adminProviders.get('/', async (c) => {
  const db = getDb();

  const items = await db
    .select()
    .from(providers)
    .orderBy(sql`${providers.createdAt} DESC`);

  return c.json({ data: items });
});

// POST /admin/providers - create provider
adminProviders.post('/', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const name = body.name as string | undefined;
  const apiType = body.apiType as 'openai' | 'anthropic' | undefined;
  const baseUrl = body.baseUrl as string | undefined;

  if (!name || !baseUrl) {
    return c.json({ error: 'name and baseUrl are required' }, 400);
  }

  if (apiType !== undefined && apiType !== 'openai' && apiType !== 'anthropic') {
    return c.json({ error: 'apiType must be openai or anthropic' }, 400);
  }

  const db = getDb();

  await db.insert(providers).values({
    name,
    apiType: apiType ?? 'openai',
    baseUrl,
    apiKeyEnc: ((body.apiKey ?? body.apiKeyEnc) as string | null | undefined) ?? null,
    config: (body.config as Record<string, unknown>) ?? null,
    isActive: (body.isActive as boolean) ?? true,
  });

  const results = await db
    .select()
    .from(providers)
    .where(eq(providers.name, name))
    .limit(1);

  return c.json({ data: results[0] }, 201);
});

// PATCH /admin/providers/:id - update provider
adminProviders.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid provider ID' }, 400);
  }

  const db = getDb();

  const existing = await db
    .select()
    .from(providers)
    .where(eq(providers.id, id))
    .limit(1);

  if (!existing[0]) {
    return c.json({ error: 'Provider not found' }, 404);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const setFields: Record<string, unknown> = {};
  if (body.name !== undefined) setFields.name = body.name;
  if (body.apiType !== undefined) {
    if (body.apiType !== 'openai' && body.apiType !== 'anthropic') {
      return c.json({ error: 'apiType must be openai or anthropic' }, 400);
    }
    setFields.apiType = body.apiType;
  }
  if (body.baseUrl !== undefined) setFields.baseUrl = body.baseUrl;
  if (body.apiKey !== undefined) setFields.apiKeyEnc = body.apiKey;
  if (body.apiKeyEnc !== undefined) setFields.apiKeyEnc = body.apiKeyEnc;
  if (body.config !== undefined) setFields.config = body.config;
  if (body.isActive !== undefined) setFields.isActive = body.isActive;

  if (Object.keys(setFields).length > 0) {
    await db.update(providers).set(setFields).where(eq(providers.id, id));
  }

  const updated = await db
    .select()
    .from(providers)
    .where(eq(providers.id, id))
    .limit(1);

  return c.json({ data: updated[0] });
});

// DELETE /admin/providers/:id - delete provider (only if disabled)
adminProviders.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid provider ID' }, 400);
  }

  const db = getDb();

  const [existing] = await db
    .select()
    .from(providers)
    .where(eq(providers.id, id))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Provider not found' }, 404);
  }

  if (existing.isActive) {
    return c.json({ error: '服务商正在使用中，请先禁用后再删除' }, 400);
  }

  await db.delete(providers).where(eq(providers.id, id));
  return c.json({ data: { message: 'Provider deleted' } });
});
