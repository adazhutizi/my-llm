import { getDb } from '../index.js';
import { users } from '../schema.js';
import { eq, like, or, and, sql, count, type SQL } from 'drizzle-orm';
import { likePattern } from './like.js';

export interface Pagination {
  page: number;
  pageSize: number;
}

export async function listUsers(pagination: Pagination, search?: string, groupId?: number) {
  const db = getDb();

  // and() filters out undefined args, so combining the optional search and
  // group conditions yields the right WHERE (or undefined when neither is set).
  const searchCond = search
    ? or(like(users.username, likePattern(search)), like(users.identifier, likePattern(search)))
    : undefined;
  const groupCond = groupId != null ? eq(users.groupId, groupId) : undefined;
  const where: SQL | undefined = and(searchCond, groupCond);

  const [totalResult] = await db
    .select({ total: count() })
    .from(users)
    .where(where);

  const offset = (pagination.page - 1) * pagination.pageSize;

  const items = await db
    .select()
    .from(users)
    .where(where)
    .orderBy(sql`${users.createdAt} DESC`)
    .limit(pagination.pageSize)
    .offset(offset);

  return { items, total: totalResult?.total ?? 0 };
}

export async function getUserById(id: number) {
  const db = getDb();

  const results = await db
    .select()
    .from(users)
    .where(eq(users.id, id))
    .limit(1);

  return results[0] ?? null;
}

export async function createUser(data: { username: string; identifier: string; groupId?: number | null }) {
  const db = getDb();

  await db.insert(users).values({
    username: data.username,
    identifier: data.identifier,
    groupId: data.groupId ?? null,
  });

  const results = await db
    .select()
    .from(users)
    .where(eq(users.username, data.username))
    .limit(1);

  return results[0] ?? null;
}

export async function updateUser(
  id: number,
  updates: {
    username?: string;
    identifier?: string;
    status?: 'active' | 'disabled';
    groupId?: number | null;
  },
) {
  const db = getDb();

  const setFields: Record<string, unknown> = {};
  if (updates.username !== undefined) setFields.username = updates.username;
  if (updates.identifier !== undefined) setFields.identifier = updates.identifier;
  if (updates.status !== undefined) setFields.status = updates.status;
  // null is meaningful here (ungroup the user), so guard on undefined — not truthiness.
  if (updates.groupId !== undefined) setFields.groupId = updates.groupId;

  if (Object.keys(setFields).length === 0) return;

  await db.update(users).set(setFields).where(eq(users.id, id));
}

export async function deleteUser(id: number) {
  const db = getDb();
  await db.delete(users).where(eq(users.id, id));
}
