import { Context, Next } from 'hono';

export async function adminAuthMiddleware(c: Context, next: Next) {
  const auth = c.get('auth');
  if (auth.mode !== 'admin') {
    return c.json({ error: 'Admin access required' }, 403);
  }
  await next();
}

/** Restrict a route to super_admin only (e.g. managing admin accounts). Must
 *  run after authMiddleware so c.get('auth').adminRole is populated from the
 *  JWT payload. */
export async function superAdminGuard(c: Context, next: Next) {
  const auth = c.get('auth');
  if (auth.adminRole !== 'super_admin') {
    return c.json({ error: '需要超级管理员权限' }, 403);
  }
  await next();
}
