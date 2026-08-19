import { Hono } from 'hono';
import {
  listApiKeys,
  getApiKeyById,
  revokeApiKey,
  deleteApiKey,
  updateApiKey,
  getApiKeySecret,
  providerExists,
} from '../../db/repositories/api-keys.js';
import { createApiKey } from '../../services/api-key.js';

export const adminApiKeys = new Hono();

// GET /admin/api-keys - list API keys
adminApiKeys.get('/', async (c) => {
  const page = Number(c.req.query('page') ?? 1);
  const pageSize = Number(c.req.query('pageSize') ?? 20);

  const mode = c.req.query('mode') as 'user' | 'app' | 'admin' | 'dedicated' | undefined;
  const userId = c.req.query('userId') ? Number(c.req.query('userId')) : undefined;
  const groupId = c.req.query('groupId') ? Number(c.req.query('groupId')) : undefined;
  const appId = c.req.query('appId') ? Number(c.req.query('appId')) : undefined;
  const status = c.req.query('status') as 'active' | 'revoked' | 'expired' | undefined;
  const search = c.req.query('search')?.trim() || undefined;

  const result = await listApiKeys(
    { mode, userId, groupId, appId, status, search },
    { page, pageSize },
  );

  return c.json({
    data: result.items,
    pagination: { page, pageSize, total: result.total },
  });
});

// POST /admin/api-keys - create API key
adminApiKeys.post('/', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const mode = body.mode as 'user' | 'app' | 'admin' | 'dedicated' | undefined;
  if (!mode || !['user', 'app', 'admin', 'dedicated'].includes(mode)) {
    return c.json({ error: 'mode is required and must be user, app, admin, or dedicated' }, 400);
  }

  const name = (body.name as string) ?? `${mode}-key`;
  const userId = body.userId as number | undefined;
  const appId = body.appId as number | undefined;
  const permissions = body.permissions as Record<string, unknown> | undefined;
  const expiresAt = body.expiresAt ? new Date(body.expiresAt as string) : undefined;
  const providerId = body.providerId as number | undefined;
  const upstreamApiKey = body.upstreamApiKey as string | undefined;

  if (mode === 'user' && !userId) {
    return c.json({ error: 'userId is required for user mode keys' }, 400);
  }
  if (mode === 'app' && !appId) {
    return c.json({ error: 'appId is required for app mode keys' }, 400);
  }
  if (mode === 'dedicated') {
    if (!providerId) {
      return c.json({ error: 'providerId is required for dedicated mode keys' }, 400);
    }
    if (!upstreamApiKey) {
      return c.json({ error: 'upstreamApiKey is required for dedicated mode keys' }, 400);
    }
  }

  const result = await createApiKey({
    mode,
    name,
    userId,
    appId,
    permissions,
    expiresAt,
    providerId: mode === 'dedicated' ? providerId : undefined,
    upstreamApiKey: mode === 'dedicated' ? upstreamApiKey : undefined,
  });

  return c.json({ data: { ...result.record, plainText: result.plainText } }, 201);
});

// GET /admin/api-keys/:id - get key details
adminApiKeys.get('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid key ID' }, 400);
  }

  const key = await getApiKeyById(id);
  if (!key) {
    return c.json({ error: 'API key not found' }, 404);
  }

  return c.json({ data: key });
});

// GET /admin/api-keys/:id/secret - reveal full API key
adminApiKeys.get('/:id/secret', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid key ID' }, 400);
  }

  const key = await getApiKeyById(id);
  if (!key) {
    return c.json({ error: 'API key not found' }, 404);
  }

  const secret = await getApiKeySecret(id);
  return c.json({ data: { id, keySecret: secret } });
});

// PATCH /admin/api-keys/:id - update key
adminApiKeys.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid key ID' }, 400);
  }

  const existing = await getApiKeyById(id);
  if (!existing) {
    return c.json({ error: 'API key not found' }, 404);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const name = body.name as string | undefined;
  const permissions = body.permissions as Record<string, unknown> | undefined;
  const expiresAt = body.expiresAt !== undefined
    ? (body.expiresAt ? new Date(body.expiresAt as string) : null)
    : undefined;
  const upstreamApiKey = body.upstreamApiKey as string | undefined;

  // Only dedicated keys bind to a provider; re-binding changes the upstream
  // baseUrl. Reject other modes and validate the target provider exists.
  const providerIdRaw = body.providerId;
  let providerId: number | undefined;
  if (providerIdRaw !== undefined) {
    if (existing.mode !== 'dedicated') {
      return c.json({ error: '只有一对一转发密钥可以绑定服务商' }, 400);
    }
    const pid = Number(providerIdRaw);
    if (!pid || isNaN(pid)) {
      return c.json({ error: 'providerId 无效' }, 400);
    }
    if (!(await providerExists(pid))) {
      return c.json({ error: '服务商不存在' }, 404);
    }
    providerId = pid;
  }

  await updateApiKey(id, { name, permissions, expiresAt, upstreamApiKey, providerId });

  const updated = await getApiKeyById(id);
  return c.json({ data: updated });
});

// POST /admin/api-keys/:id/revoke - revoke key
adminApiKeys.post('/:id/revoke', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid key ID' }, 400);
  }

  const existing = await getApiKeyById(id);
  if (!existing) {
    return c.json({ error: 'API key not found' }, 404);
  }

  await revokeApiKey(id);
  const updated = await getApiKeyById(id);
  return c.json({ data: updated });
});

// DELETE /admin/api-keys/:id - delete key (only if revoked/expired)
adminApiKeys.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid key ID' }, 400);
  }

  const existing = await getApiKeyById(id);
  if (!existing) {
    return c.json({ error: 'API key not found' }, 404);
  }

  if (existing.status === 'active') {
    return c.json({ error: '密钥正在使用中，请先撤销后再删除' }, 400);
  }

  await deleteApiKey(id);
  return c.json({ data: { message: 'API key deleted' } });
});
