import { Hono } from 'hono';
import { verifyPassword, verifyJwtToken, changePassword } from '../../services/admin-auth.js';

export const adminAuth = new Hono();

// POST /admin/auth/login
adminAuth.post('/login', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: 'Invalid JSON body' } }, 400);
  }

  const username = body.username as string | undefined;
  const password = body.password as string | undefined;

  if (!username || !password) {
    return c.json({ error: { message: 'Username and password are required' } }, 400);
  }

  const result = await verifyPassword(username, password);
  if (!result) {
    return c.json({ error: { message: 'Invalid username or password' } }, 401);
  }

  return c.json({ data: result });
});

// POST /admin/auth/change-password — requires valid JWT
adminAuth.post('/change-password', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: { message: 'Not authenticated' } }, 401);
  }

  const payload = await verifyJwtToken(authHeader.slice(7));
  if (!payload) {
    return c.json({ error: { message: 'Invalid or expired token' } }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: 'Invalid JSON body' } }, 400);
  }

  const currentPassword = body.currentPassword as string | undefined;
  const newPassword = body.newPassword as string | undefined;

  if (!currentPassword || !newPassword) {
    return c.json({ error: { message: '当前密码和新密码不能为空' } }, 400);
  }

  if (newPassword.length < 8) {
    return c.json({ error: { message: '新密码长度不能少于 8 位' } }, 400);
  }

  const result = await changePassword(Number(payload.sub), currentPassword, newPassword);
  if (!result.success) {
    return c.json({ error: { message: result.error } }, 400);
  }

  return c.json({ data: { success: true } });
});

// GET /admin/auth/me — requires valid JWT in Authorization header
adminAuth.get('/me', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: { message: 'Not authenticated' } }, 401);
  }

  const payload = await verifyJwtToken(authHeader.slice(7));
  if (!payload) {
    return c.json({ error: { message: 'Invalid or expired token' } }, 401);
  }

  return c.json({
    data: {
      id: Number(payload.sub),
      username: payload.username,
      role: payload.role,
    },
  });
});
