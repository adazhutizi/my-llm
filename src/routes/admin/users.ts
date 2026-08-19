import { Hono } from 'hono';
import {
  listUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
} from '../../db/repositories/users.js';
import { getUsageOverview } from '../../db/repositories/usage.js';

export const adminUsers = new Hono();

// GET /admin/users - list users
adminUsers.get('/', async (c) => {
  const page = Number(c.req.query('page') ?? 1);
  const pageSize = Number(c.req.query('pageSize') ?? 20);
  const search = c.req.query('search')?.trim() || undefined;
  const groupIdRaw = c.req.query('groupId');
  const groupId = groupIdRaw ? Number(groupIdRaw) : undefined;

  const result = await listUsers(
    { page, pageSize },
    search,
    groupId != null && !Number.isNaN(groupId) ? groupId : undefined,
  );

  return c.json({
    data: result.items,
    pagination: { page, pageSize, total: result.total },
  });
});

// POST /admin/users - create user
adminUsers.post('/', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const username = body.username as string | undefined;
  if (!username) {
    return c.json({ error: 'username is required' }, 400);
  }

  const identifier = body.identifier as string | undefined;
  if (!identifier) {
    return c.json({ error: 'identifier is required' }, 400);
  }

  // groupId is optional on create; non-number values default to ungrouped (null).
  const groupId = typeof body.groupId === 'number' ? body.groupId : null;
  const user = await createUser({ username, identifier, groupId });
  return c.json({ data: user }, 201);
});

// GET /admin/users/:id - get user details with usage summary
adminUsers.get('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid user ID' }, 400);
  }

  const user = await getUserById(id);
  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  const usage = await getUsageOverview({ userId: id });

  return c.json({ data: { ...user, usage } });
});

// PATCH /admin/users/:id - update user
adminUsers.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid user ID' }, 400);
  }

  const existing = await getUserById(id);
  if (!existing) {
    return c.json({ error: 'User not found' }, 404);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const username = body.username as string | undefined;
  const identifier = body.identifier as string | undefined;
  const status = body.status as 'active' | 'disabled' | undefined;

  // groupId tri-state on PATCH: undefined = leave unchanged, null = ungroup,
  // number = assign to that group. Anything else (string, etc.) = unchanged.
  let groupId: number | null | undefined = undefined;
  if (body.groupId === null) groupId = null;
  else if (typeof body.groupId === 'number') groupId = body.groupId;

  await updateUser(id, { username, identifier, status, groupId });

  const updated = await getUserById(id);
  return c.json({ data: updated });
});

// DELETE /admin/users/:id - delete user (only if disabled)
adminUsers.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid user ID' }, 400);
  }

  const existing = await getUserById(id);
  if (!existing) {
    return c.json({ error: 'User not found' }, 404);
  }

  if (existing.status === 'active') {
    return c.json({ error: '用户正在使用中，请先禁用后再删除' }, 400);
  }

  await deleteUser(id);
  return c.json({ data: { message: 'User deleted' } });
});
