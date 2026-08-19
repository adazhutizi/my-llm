import { Hono } from 'hono';
import { superAdminGuard } from '../../middleware/admin-auth.js';
import {
  listAdmins,
  getAdminById,
  createAdmin,
  updateAdmin,
  resetAdminPassword,
  deleteAdmin,
  countSuperAdmins,
} from '../../services/admin-auth.js';

export const adminAdmins = new Hono();

// Entire route is super_admin only. Runs after the global authMiddleware +
// adminAuthMiddleware (registered on /admin/* in app.ts), so auth.adminRole is
// already populated from the JWT payload.
adminAdmins.use('*', superAdminGuard);

// GET /admin/admins - list admins
adminAdmins.get('/', async (c) => {
  const page = Number(c.req.query('page') ?? 1);
  const pageSize = Number(c.req.query('pageSize') ?? 20);
  const search = c.req.query('search')?.trim() || undefined;

  const result = await listAdmins({ page, pageSize }, search);

  return c.json({
    data: result.items,
    pagination: { page, pageSize, total: result.total },
  });
});

// POST /admin/admins - create admin
adminAdmins.post('/', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const username = body.username as string | undefined;
  if (!username) {
    return c.json({ error: '用户名不能为空' }, 400);
  }
  const password = body.password as string | undefined;
  const role = (body.role as 'admin' | 'super_admin' | undefined) ?? 'admin';
  if (role !== 'admin' && role !== 'super_admin') {
    return c.json({ error: 'role 必须是 admin 或 super_admin' }, 400);
  }

  try {
    const { record, plainPassword } = await createAdmin({
      username,
      password: password || undefined,
      role,
    });
    return c.json({ data: { ...record, plainPassword } }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : '创建失败';
    return c.json({ error: msg }, 400);
  }
});

// GET /admin/admins/:id - get admin details
adminAdmins.get('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid admin ID' }, 400);
  }

  const admin = await getAdminById(id);
  if (!admin) {
    return c.json({ error: 'Admin not found' }, 404);
  }

  return c.json({ data: admin });
});

// PATCH /admin/admins/:id - update role/status
adminAdmins.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid admin ID' }, 400);
  }

  const auth = c.get('auth');
  // Self-protection: cannot change your own role/status.
  if (auth.adminUserId === id) {
    return c.json({ error: '不能修改当前登录的管理员账号' }, 400);
  }

  const existing = await getAdminById(id);
  if (!existing) {
    return c.json({ error: 'Admin not found' }, 404);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const role = body.role as 'admin' | 'super_admin' | undefined;
  const status = body.status as 'active' | 'disabled' | undefined;

  // Demoting a super_admin: refuse if it would leave zero super_admins.
  if (role && role !== 'super_admin' && existing.role === 'super_admin') {
    if ((await countSuperAdmins()) <= 1) {
      return c.json({ error: '至少需要保留一个超级管理员' }, 400);
    }
  }

  await updateAdmin(id, { role, status });

  const updated = await getAdminById(id);
  return c.json({ data: updated });
});

// POST /admin/admins/:id/reset-password - generate a new random password
adminAdmins.post('/:id/reset-password', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid admin ID' }, 400);
  }

  const auth = c.get('auth');
  if (auth.adminUserId === id) {
    return c.json({ error: '不能重置当前登录账号的密码，请使用修改密码功能' }, 400);
  }

  const existing = await getAdminById(id);
  if (!existing) {
    return c.json({ error: 'Admin not found' }, 404);
  }

  const plainPassword = await resetAdminPassword(id);
  return c.json({ data: { plainPassword } });
});

// DELETE /admin/admins/:id - delete admin (only if disabled)
adminAdmins.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid admin ID' }, 400);
  }

  const auth = c.get('auth');
  if (auth.adminUserId === id) {
    return c.json({ error: '不能删除当前登录的管理员账号' }, 400);
  }

  const existing = await getAdminById(id);
  if (!existing) {
    return c.json({ error: 'Admin not found' }, 404);
  }

  if (existing.status === 'active') {
    return c.json({ error: '请先禁用该管理员后再删除' }, 400);
  }

  // Deleting the last super_admin would lock everyone out of admin management.
  if (existing.role === 'super_admin' && (await countSuperAdmins()) <= 1) {
    return c.json({ error: '至少需要保留一个超级管理员' }, 400);
  }

  await deleteAdmin(id);
  return c.json({ data: { message: 'Admin deleted' } });
});
