import { Hono } from 'hono';
import {
  listUserGroups,
  getUserGroupById,
  createUserGroup,
  updateUserGroup,
  deleteUserGroup,
} from '../../db/repositories/user-groups.js';

export const adminUserGroups = new Hono();

// GET /admin/user-groups - list all groups with member counts
adminUserGroups.get('/', async (c) => {
  const groups = await listUserGroups();
  return c.json({ data: groups });
});

// POST /admin/user-groups - create group
adminUserGroups.post('/', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const name = (body.name as string | undefined)?.trim();
  if (!name) {
    return c.json({ error: 'name is required' }, 400);
  }
  const description = body.description as string | undefined;

  try {
    const group = await createUserGroup({ name, description });
    return c.json({ data: group }, 201);
  } catch (err) {
    // name has a UNIQUE constraint — surface a friendly message on collision.
    if (err instanceof Error && /Duplicate entry/i.test(err.message)) {
      return c.json({ error: '分组名已存在' }, 400);
    }
    throw err;
  }
});

// PATCH /admin/user-groups/:id - update group
adminUserGroups.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid group ID' }, 400);
  }

  const existing = await getUserGroupById(id);
  if (!existing) {
    return c.json({ error: 'Group not found' }, 404);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const updates: { name?: string; description?: string | null } = {};
  if (body.name !== undefined) {
    const name = (body.name as string).trim();
    if (!name) return c.json({ error: 'name cannot be empty' }, 400);
    updates.name = name;
  }
  if (body.description !== undefined) {
    updates.description = body.description as string | null;
  }

  try {
    await updateUserGroup(id, updates);
    const updated = await getUserGroupById(id);
    return c.json({ data: updated });
  } catch (err) {
    if (err instanceof Error && /Duplicate entry/i.test(err.message)) {
      return c.json({ error: '分组名已存在' }, 400);
    }
    throw err;
  }
});

// DELETE /admin/user-groups/:id - delete group (members are unbound, not deleted)
adminUserGroups.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid group ID' }, 400);
  }

  const existing = await getUserGroupById(id);
  if (!existing) {
    return c.json({ error: 'Group not found' }, 404);
  }

  await deleteUserGroup(id);
  return c.json({ data: { message: 'Group deleted' } });
});
