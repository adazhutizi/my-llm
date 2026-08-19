import { Hono } from 'hono';
import {
  listApps,
  getAppById,
  createApp,
  updateApp,
  deleteApp,
  listAppUsers,
  addAppUser,
  removeAppUser,
  updateAppUser,
  listFeatures,
  removeFeature,
  updateFeature,
} from '../../db/repositories/apps.js';
import { getUsageOverview } from '../../db/repositories/usage.js';

export const adminApps = new Hono();

// GET /admin/apps - list apps
adminApps.get('/', async (c) => {
  const page = Number(c.req.query('page') ?? 1);
  const pageSize = Number(c.req.query('pageSize') ?? 20);
  const search = c.req.query('search')?.trim() || undefined;

  const result = await listApps({ page, pageSize }, search);

  return c.json({
    data: result.items,
    pagination: { page, pageSize, total: result.total },
  });
});

// POST /admin/apps - create app
adminApps.post('/', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const name = body.name as string | undefined;
  if (!name) {
    return c.json({ error: 'name is required' }, 400);
  }

  const description = body.description as string | undefined;
  const ownerId = body.ownerId as number | undefined;

  const app = await createApp({ name, description, ownerId });
  return c.json({ data: app }, 201);
});

// GET /admin/apps/:id - get app details with users and usage summary
adminApps.get('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid app ID' }, 400);
  }

  const app = await getAppById(id);
  if (!app) {
    return c.json({ error: 'App not found' }, 404);
  }

  const appUserList = await listAppUsers(id);
  const featureList = await listFeatures(id);
  const usage = await getUsageOverview({ appId: id });

  return c.json({ data: { ...app, users: appUserList, features: featureList, usage } });
});

// PATCH /admin/apps/:id - update app
adminApps.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid app ID' }, 400);
  }

  const existing = await getAppById(id);
  if (!existing) {
    return c.json({ error: 'App not found' }, 404);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const name = body.name as string | undefined;
  const description = body.description as string | undefined;
  const status = body.status as 'active' | 'disabled' | undefined;

  await updateApp(id, { name, description, status });

  const updated = await getAppById(id);
  return c.json({ data: updated });
});

// DELETE /admin/apps/:id - delete app (only if disabled)
adminApps.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid app ID' }, 400);
  }

  const existing = await getAppById(id);
  if (!existing) {
    return c.json({ error: 'App not found' }, 404);
  }

  if (existing.status === 'active') {
    return c.json({ error: '应用正在使用中，请先禁用后再删除' }, 400);
  }

  await deleteApp(id);
  return c.json({ data: { message: 'App deleted' } });
});

// POST /admin/apps/:id/users - add app user
adminApps.post('/:id/users', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid app ID' }, 400);
  }

  const existing = await getAppById(id);
  if (!existing) {
    return c.json({ error: 'App not found' }, 404);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const externalUid = body.externalUid as string | undefined;
  if (!externalUid) {
    return c.json({ error: 'externalUid is required' }, 400);
  }

  const displayName = body.displayName as string | undefined;

  const appUser = await addAppUser(id, externalUid, displayName);
  return c.json({ data: appUser }, 201);
});

// DELETE /admin/apps/:id/users/:uid - remove app user
adminApps.delete('/:id/users/:uid', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid app ID' }, 400);
  }

  const uid = c.req.param('uid');
  if (!uid) {
    return c.json({ error: 'User external UID is required' }, 400);
  }

  const existing = await getAppById(id);
  if (!existing) {
    return c.json({ error: 'App not found' }, 404);
  }

  await removeAppUser(id, uid);
  return c.json({ data: { message: 'App user removed' } });
});

// PATCH /admin/apps/:id/users/:uid - update app user display name (remark)
adminApps.patch('/:id/users/:uid', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid app ID' }, 400);
  }

  const uid = c.req.param('uid');
  if (!uid) {
    return c.json({ error: 'User external UID is required' }, 400);
  }

  const existing = await getAppById(id);
  if (!existing) {
    return c.json({ error: 'App not found' }, 404);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const displayName = body.displayName as string | null | undefined;
  if (displayName === undefined) {
    return c.json({ error: 'displayName is required' }, 400);
  }

  await updateAppUser(id, uid, displayName);

  const userList = await listAppUsers(id);
  const updated = userList.find((u) => u.externalUid === uid);
  return c.json({ data: updated });
});

// GET /admin/apps/:id/features - list features for an app
adminApps.get('/:id/features', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid app ID' }, 400);
  }

  const existing = await getAppById(id);
  if (!existing) {
    return c.json({ error: 'App not found' }, 404);
  }

  const featureList = await listFeatures(id);
  return c.json({ data: featureList });
});

// DELETE /admin/apps/:id/features/:featureId - remove a feature record
adminApps.delete('/:id/features/:featureId', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid app ID' }, 400);
  }

  const featureId = c.req.param('featureId');
  if (!featureId) {
    return c.json({ error: 'Feature ID is required' }, 400);
  }

  const existing = await getAppById(id);
  if (!existing) {
    return c.json({ error: 'App not found' }, 404);
  }

  await removeFeature(id, featureId);
  return c.json({ data: { message: 'Feature removed' } });
});

// PATCH /admin/apps/:id/features/:featureId - update feature (e.g. displayName)
adminApps.patch('/:id/features/:featureId', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid app ID' }, 400);
  }

  const featureId = c.req.param('featureId');
  if (!featureId) {
    return c.json({ error: 'Feature ID is required' }, 400);
  }

  const existing = await getAppById(id);
  if (!existing) {
    return c.json({ error: 'App not found' }, 404);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const displayName = body.displayName as string | null | undefined;
  if (displayName === undefined) {
    return c.json({ error: 'displayName is required' }, 400);
  }

  await updateFeature(id, featureId, displayName);

  const featureList = await listFeatures(id);
  const updated = featureList.find((f) => f.featureId === featureId);
  return c.json({ data: updated });
});
