import { getDb } from '../index.js';
import { apps, appUsers, features } from '../schema.js';
import { eq, and, like, or, sql, count, type SQL } from 'drizzle-orm';
import { likePattern } from './like.js';

export interface Pagination {
  page: number;
  pageSize: number;
}

export async function listApps(pagination: Pagination, search?: string) {
  const db = getDb();

  const where: SQL | undefined = search
    ? or(like(apps.name, likePattern(search)), like(apps.description, likePattern(search)))
    : undefined;

  const [totalResult] = await db
    .select({ total: count() })
    .from(apps)
    .where(where);

  const offset = (pagination.page - 1) * pagination.pageSize;

  const items = await db
    .select()
    .from(apps)
    .where(where)
    .orderBy(sql`${apps.createdAt} DESC`)
    .limit(pagination.pageSize)
    .offset(offset);

  return { items, total: totalResult?.total ?? 0 };
}

export async function getAppById(id: number) {
  const db = getDb();

  const results = await db
    .select()
    .from(apps)
    .where(eq(apps.id, id))
    .limit(1);

  return results[0] ?? null;
}

export async function createApp(data: { name: string; description?: string; ownerId?: number }) {
  const db = getDb();

  await db.insert(apps).values({
    name: data.name,
    description: data.description ?? null,
    ownerId: data.ownerId ?? null,
  });

  // Retrieve the inserted record
  const results = await db
    .select()
    .from(apps)
    .where(eq(apps.name, data.name))
    .orderBy(sql`${apps.id} DESC`)
    .limit(1);

  return results[0] ?? null;
}

export async function updateApp(
  id: number,
  updates: { name?: string; description?: string; status?: 'active' | 'disabled' },
) {
  const db = getDb();

  const setFields: Record<string, unknown> = {};
  if (updates.name !== undefined) setFields.name = updates.name;
  if (updates.description !== undefined) setFields.description = updates.description;
  if (updates.status !== undefined) setFields.status = updates.status;

  if (Object.keys(setFields).length === 0) return;

  await db.update(apps).set(setFields).where(eq(apps.id, id));
}

export async function deleteApp(id: number) {
  const db = getDb();
  await db.delete(apps).where(eq(apps.id, id));
}

export async function listAppUsers(appId: number) {
  const db = getDb();

  const items = await db
    .select()
    .from(appUsers)
    .where(eq(appUsers.appId, appId))
    .orderBy(sql`${appUsers.createdAt} DESC`);

  return items;
}

export async function addAppUser(
  appId: number,
  externalUid: string,
  displayName?: string,
) {
  const db = getDb();

  await db.insert(appUsers).values({
    appId,
    externalUid,
    displayName: displayName ?? null,
  });

  const results = await db
    .select()
    .from(appUsers)
    .where(and(eq(appUsers.appId, appId), eq(appUsers.externalUid, externalUid)))
    .limit(1);

  return results[0] ?? null;
}

export async function removeAppUser(appId: number, externalUid: string) {
  const db = getDb();
  await db
    .delete(appUsers)
    .where(and(eq(appUsers.appId, appId), eq(appUsers.externalUid, externalUid)));
}

// Update an app user's display name (remark). Pure UPDATE keyed by the
// (appId, externalUid) composite — mirrors updateFeature below. Relies on the
// row existing (app mode auto-creates app_users on first X-App-User-Id sight
// in auth.ts); rows missing for non-app-mode/historical UIDs simply match 0
// rows, matching features' existing behavior.
export async function updateAppUser(
  appId: number,
  externalUid: string,
  displayName: string | null,
) {
  const db = getDb();
  await db
    .update(appUsers)
    .set({ displayName })
    .where(and(eq(appUsers.appId, appId), eq(appUsers.externalUid, externalUid)));
}

// ─── Features ────────────────────────────────────────────────────────────────

export async function listFeatures(appId: number) {
  const db = getDb();

  const items = await db
    .select()
    .from(features)
    .where(eq(features.appId, appId))
    .orderBy(sql`${features.createdAt} DESC`);

  return items;
}

export async function removeFeature(appId: number, featureId: string) {
  const db = getDb();
  await db
    .delete(features)
    .where(and(eq(features.appId, appId), eq(features.featureId, featureId)));
}

export async function updateFeature(
  appId: number,
  featureId: string,
  displayName: string | null,
) {
  const db = getDb();
  await db
    .update(features)
    .set({ displayName })
    .where(and(eq(features.appId, appId), eq(features.featureId, featureId)));
}
