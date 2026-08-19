import { getDb } from '../index.js';
import { userGroups, users } from '../schema.js';
import { count, eq, sql } from 'drizzle-orm';

export interface UserGroupWithCount {
  id: number;
  name: string;
  description: string | null;
  memberCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * List all groups with their member counts. Groups are small in cardinality,
 * so no pagination. LEFT JOIN so an empty group still appears with memberCount=0
 * (COUNT(users.id) ignores the NULL row from the LEFT JOIN).
 *
 * COUNT() returns BIGINT → mysql2 hands back a string; wrap with Number() so the
 * API emits a real number (same reason SUM() is wrapped elsewhere, see CLAUDE.md).
 */
export async function listUserGroups(): Promise<UserGroupWithCount[]> {
  const db = getDb();

  const rows = await db
    .select({
      id: userGroups.id,
      name: userGroups.name,
      description: userGroups.description,
      createdAt: userGroups.createdAt,
      updatedAt: userGroups.updatedAt,
      memberCount: count(users.id),
    })
    .from(userGroups)
    .leftJoin(users, eq(users.groupId, userGroups.id))
    .groupBy(userGroups.id)
    .orderBy(sql`${userGroups.createdAt} DESC`);

  return rows.map((r) => ({ ...r, memberCount: Number(r.memberCount) }));
}

export async function getUserGroupById(id: number) {
  const db = getDb();

  const results = await db.select().from(userGroups).where(eq(userGroups.id, id)).limit(1);
  return results[0] ?? null;
}

export async function createUserGroup(data: { name: string; description?: string | null }) {
  const db = getDb();

  await db.insert(userGroups).values({
    name: data.name,
    description: data.description ?? null,
  });

  // name is UNIQUE — look the new row back up by name.
  const results = await db
    .select()
    .from(userGroups)
    .where(eq(userGroups.name, data.name))
    .limit(1);

  return results[0] ?? null;
}

/**
 * Partial update. description may be explicitly set to null (clearing it),
 * hence the `!== undefined` guard (null is a meaningful value).
 */
export async function updateUserGroup(
  id: number,
  updates: { name?: string; description?: string | null },
) {
  const db = getDb();

  const setFields: Record<string, unknown> = {};
  if (updates.name !== undefined) setFields.name = updates.name;
  if (updates.description !== undefined) setFields.description = updates.description;

  if (Object.keys(setFields).length === 0) return;

  await db.update(userGroups).set(setFields).where(eq(userGroups.id, id));
}

/**
 * Delete a group. Members are NOT deleted — their group_id is nulled first
 * (they become ungrouped). Done in a transaction so a failure between the
 * unbind and the delete can't leave members pointing at a group that's about
 * to vanish. There is no DB-level foreign key (project convention: no
 * relations()), so this code is the sole integrity guard.
 */
export async function deleteUserGroup(id: number) {
  const db = getDb();

  await db.transaction(async (tx) => {
    await tx.update(users).set({ groupId: null }).where(eq(users.groupId, id));
    await tx.delete(userGroups).where(eq(userGroups.id, id));
  });
}
