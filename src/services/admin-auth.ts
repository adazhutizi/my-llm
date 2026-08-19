import bcrypt from 'bcrypt';
import { sign, verify } from 'hono/jwt';
import { getDb } from '../db/index.js';
import { adminUsers } from '../db/schema.js';
import { eq, and, like, sql, count } from 'drizzle-orm';
import { formatUtcDateTime } from '../db/repositories/logs.js';
import { likePattern } from '../db/repositories/like.js';
import { getConfig } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import crypto from 'crypto';

const SALT_ROUNDS = 10;
let _logger: ReturnType<typeof createLogger> | null = null;
function getLogger() {
  if (!_logger) _logger = createLogger('admin-auth');
  return _logger;
}

export interface AdminUser {
  id: number;
  username: string;
  role: 'admin' | 'super_admin';
}

export interface LoginResult {
  token: string;
  user: AdminUser;
}

// ── Password verification + JWT issuance ──────────────────────────────────

export async function verifyPassword(
  username: string,
  password: string,
): Promise<LoginResult | null> {
  const db = getDb();

  const [user] = await db
    .select()
    .from(adminUsers)
    .where(and(eq(adminUsers.username, username), eq(adminUsers.status, 'active')))
    .limit(1);

  if (!user) return null;

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return null;

  // Update last login time
  await db
    .update(adminUsers)
    // UTC wall-clock literal: the connection session is pinned to UTC
    // (db/index.ts), so bind UTC to match. See formatUtcDateTime.
    .set({ lastLoginAt: sql`${formatUtcDateTime(new Date())}` })
    .where(eq(adminUsers.id, user.id));

  const config = getConfig();
  const now = Math.floor(Date.now() / 1000);

  const token = await sign(
    {
      sub: String(user.id),
      username: user.username,
      role: user.role,
      iat: now,
      exp: now + config.jwt.expiresIn,
    },
    config.jwt.secret,
    'HS256',
  );

  return {
    token,
    user: { id: user.id, username: user.username, role: user.role },
  };
}

// ── JWT verification ──────────────────────────────────────────────────────

export async function verifyJwtToken(
  token: string,
): Promise<Record<string, unknown> | null> {
  try {
    const config = getConfig();
    const payload = await verify(token, config.jwt.secret, 'HS256');
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── Bootstrap default admin on first startup ──────────────────────────────

const PASSWORD_CHARS = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%';

function generatePassword(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let result = '';
  for (let i = 0; i < length; i++) {
    result += PASSWORD_CHARS[bytes[i] % PASSWORD_CHARS.length];
  }
  return result;
}

export async function bootstrapDefaultAdmin(): Promise<void> {
  const db = getDb();
  const existing = await db.select({ id: adminUsers.id }).from(adminUsers).limit(1);

  if (existing.length > 0) {
    getLogger().info('Admin user(s) already exist, skipping bootstrap');
    return;
  }

  const username = 'admin';
  const password = generatePassword(16);
  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);

  await db.insert(adminUsers).values({
    username,
    passwordHash,
    role: 'super_admin',
    status: 'active',
  });

  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log('══════════════════════════════════════════════════════');
  // eslint-disable-next-line no-console
  console.log('  Default Admin Account Created');
  // eslint-disable-next-line no-console
  console.log('══════════════════════════════════════════════════════');
  // eslint-disable-next-line no-console
  console.log(`  Username: ${username}`);
  // eslint-disable-next-line no-console
  console.log(`  Password: ${password}`);
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log('  ⚠  Please change this password after first login!');
  // eslint-disable-next-line no-console
  console.log('══════════════════════════════════════════════════════');
  // eslint-disable-next-line no-console
  console.log('');
}

// ── Change password ────────────────────────────────────────────────────────

export async function changePassword(
  userId: number,
  currentPassword: string,
  newPassword: string,
): Promise<{ success: boolean; error?: string }> {
  const db = getDb();

  const [user] = await db
    .select()
    .from(adminUsers)
    .where(eq(adminUsers.id, userId))
    .limit(1);

  if (!user) return { success: false, error: '用户不存在' };

  const match = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!match) return { success: false, error: '当前密码不正确' };

  const newPasswordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await db
    .update(adminUsers)
    // updated_at has ON UPDATE CURRENT_TIMESTAMP, so omitting it lets MySQL
    // set it in session tz (correct). Setting it explicitly via drizzle would
    // serialize to a UTC literal and skew 8h.
    .set({ passwordHash: newPasswordHash })
    .where(eq(adminUsers.id, user.id));

  return { success: true };
}

// ── Admin account management (super_admin only) ────────────────────────────
// This module is already the service+db+bcrypt home for admin_users (no
// separate repository), so the CRUD lives here alongside verifyPassword etc.

const adminPublicColumns = {
  id: adminUsers.id,
  username: adminUsers.username,
  role: adminUsers.role,
  status: adminUsers.status,
  lastLoginAt: adminUsers.lastLoginAt,
  createdAt: adminUsers.createdAt,
};

export async function listAdmins(
  pagination: { page: number; pageSize: number },
  search?: string,
) {
  const db = getDb();
  const where = search ? like(adminUsers.username, likePattern(search)) : undefined;

  const [totalResult] = await db
    .select({ total: count() })
    .from(adminUsers)
    .where(where);

  const offset = (pagination.page - 1) * pagination.pageSize;
  const items = await db
    .select(adminPublicColumns)
    .from(adminUsers)
    .where(where)
    .orderBy(sql`${adminUsers.createdAt} DESC`)
    .limit(pagination.pageSize)
    .offset(offset);

  return { items, total: Number(totalResult?.total ?? 0) };
}

export async function getAdminById(id: number) {
  const db = getDb();
  const [row] = await db
    .select(adminPublicColumns)
    .from(adminUsers)
    .where(eq(adminUsers.id, id))
    .limit(1);
  return row ?? null;
}

export async function createAdmin(params: {
  username: string;
  password?: string;
  role: 'admin' | 'super_admin';
}) {
  const db = getDb();
  // Empty/omitted password → generate a random one (returned once to the caller).
  const plainPassword = params.password || generatePassword(16);
  const passwordHash = bcrypt.hashSync(plainPassword, SALT_ROUNDS);

  try {
    await db.insert(adminUsers).values({
      username: params.username,
      passwordHash,
      role: params.role,
      status: 'active',
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
      throw new Error('用户名已存在');
    }
    throw err;
  }

  const [record] = await db
    .select(adminPublicColumns)
    .from(adminUsers)
    .where(eq(adminUsers.username, params.username))
    .limit(1);
  // Just inserted — must exist.
  return { record: record!, plainPassword };
}

export async function updateAdmin(
  id: number,
  updates: { role?: 'admin' | 'super_admin'; status?: 'active' | 'disabled' },
) {
  const db = getDb();
  const setFields: Record<string, unknown> = {};
  if (updates.role !== undefined) setFields.role = updates.role;
  if (updates.status !== undefined) setFields.status = updates.status;
  if (Object.keys(setFields).length === 0) return;
  await db.update(adminUsers).set(setFields).where(eq(adminUsers.id, id));
}

export async function resetAdminPassword(id: number): Promise<string> {
  const db = getDb();
  const plainPassword = generatePassword(16);
  const passwordHash = bcrypt.hashSync(plainPassword, SALT_ROUNDS);
  await db.update(adminUsers).set({ passwordHash }).where(eq(adminUsers.id, id));
  return plainPassword;
}

export async function deleteAdmin(id: number) {
  const db = getDb();
  await db.delete(adminUsers).where(eq(adminUsers.id, id));
}

/** Count of super_admin rows — used to refuse demoting/deleting the last one. */
export async function countSuperAdmins(): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ total: count() })
    .from(adminUsers)
    .where(eq(adminUsers.role, 'super_admin'));
  return Number(row?.total ?? 0);
}