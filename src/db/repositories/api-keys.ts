import { getDb } from '../index.js';
import { apiKeys, users, apps, providers } from '../schema.js';
import { eq, and, like, or, sql, count, inArray, type SQL } from 'drizzle-orm';
import { formatUtcDateTime } from './logs.js';
import { likePattern } from './like.js';

export interface ListApiKeysFilters {
  mode?: 'user' | 'app' | 'admin' | 'dedicated';
  userId?: number;
  groupId?: number;
  appId?: number;
  status?: 'active' | 'revoked' | 'expired';
  search?: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
}

export async function listApiKeys(
  filters: ListApiKeysFilters,
  pagination: Pagination,
) {
  const db = getDb();
  const conditions: SQL[] = [];

  if (filters.mode) {
    conditions.push(eq(apiKeys.mode, filters.mode));
  }
  if (filters.userId !== undefined) {
    conditions.push(eq(apiKeys.userId, filters.userId));
  }
  // A key belongs to a group via its user, so restrict to keys whose user_id
  // is a member of the group (app/admin keys have no user and are intentionally
  // excluded — they don't belong to any user group).
  if (filters.groupId !== undefined) {
    conditions.push(
      inArray(
        apiKeys.userId,
        db.select({ id: users.id }).from(users).where(eq(users.groupId, filters.groupId)),
      ),
    );
  }
  if (filters.appId !== undefined) {
    conditions.push(eq(apiKeys.appId, filters.appId));
  }
  if (filters.status) {
    conditions.push(eq(apiKeys.status, filters.status));
  }
  if (filters.search) {
    const p = likePattern(filters.search);
    conditions.push(or(like(apiKeys.name, p), like(apiKeys.keyPrefix, p))!);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [totalResult] = await db
    .select({ total: count() })
    .from(apiKeys)
    .where(where);

  const offset = (pagination.page - 1) * pagination.pageSize;

  const items = await db
    .select({
      id: apiKeys.id,
      keyPrefix: apiKeys.keyPrefix,
      mode: apiKeys.mode,
      name: apiKeys.name,
      status: apiKeys.status,
      userId: apiKeys.userId,
      appId: apiKeys.appId,
      providerId: apiKeys.providerId,
      permissions: apiKeys.permissions,
      expiresAt: apiKeys.expiresAt,
      createdAt: apiKeys.createdAt,
      user: {
        id: users.id,
        username: users.username,
      },
      app: {
        id: apps.id,
        name: apps.name,
      },
      provider: {
        id: providers.id,
        name: providers.name,
      },
    })
    .from(apiKeys)
    .leftJoin(users, eq(apiKeys.userId, users.id))
    .leftJoin(apps, eq(apiKeys.appId, apps.id))
    .leftJoin(providers, eq(apiKeys.providerId, providers.id))
    .where(where)
    .orderBy(sql`${apiKeys.createdAt} DESC`)
    .limit(pagination.pageSize)
    .offset(offset);

  return { items, total: totalResult?.total ?? 0 };
}

export async function getApiKeyById(id: number) {
  const db = getDb();

  const results = await db
    .select({
      id: apiKeys.id,
      keyPrefix: apiKeys.keyPrefix,
      mode: apiKeys.mode,
      name: apiKeys.name,
      status: apiKeys.status,
      userId: apiKeys.userId,
      appId: apiKeys.appId,
      providerId: apiKeys.providerId,
      permissions: apiKeys.permissions,
      expiresAt: apiKeys.expiresAt,
      createdAt: apiKeys.createdAt,
      user: {
        id: users.id,
        username: users.username,
        identifier: users.identifier,
      },
      app: {
        id: apps.id,
        name: apps.name,
      },
      provider: {
        id: providers.id,
        name: providers.name,
      },
    })
    .from(apiKeys)
    .leftJoin(users, eq(apiKeys.userId, users.id))
    .leftJoin(apps, eq(apiKeys.appId, apps.id))
    .leftJoin(providers, eq(apiKeys.providerId, providers.id))
    .where(eq(apiKeys.id, id))
    .limit(1);

  return results[0] ?? null;
}

export async function revokeApiKey(id: number) {
  const db = getDb();
  await db
    .update(apiKeys)
    .set({ status: 'revoked' })
    .where(eq(apiKeys.id, id));
}

export async function deleteApiKey(id: number) {
  const db = getDb();
  await db.delete(apiKeys).where(eq(apiKeys.id, id));
}

export async function updateApiKey(
  id: number,
  updates: { name?: string; permissions?: Record<string, unknown>; expiresAt?: Date | null; upstreamApiKey?: string; providerId?: number },
) {
  const db = getDb();

  const setFields: Record<string, unknown> = {};
  if (updates.name !== undefined) setFields.name = updates.name;
  if (updates.permissions !== undefined) setFields.permissions = updates.permissions;
  // See createApiKey: UTC wall-clock literal to match the pinned UTC session.
  if (updates.expiresAt !== undefined) {
    setFields.expiresAt = updates.expiresAt === null ? null : sql`${formatUtcDateTime(updates.expiresAt)}`;
  }
  if (updates.upstreamApiKey !== undefined) setFields.upstreamApiKeyEnc = updates.upstreamApiKey;
  // Dedicated keys may re-bind to another provider, which changes the upstream
  // baseUrl used for transparent forwarding. Existence is validated in the
  // route layer via providerExists before reaching here.
  if (updates.providerId !== undefined) setFields.providerId = updates.providerId;

  if (Object.keys(setFields).length === 0) return;

  await db.update(apiKeys).set(setFields).where(eq(apiKeys.id, id));
}

/** Whether a provider row exists — used to validate dedicated-key re-binding. */
export async function providerExists(id: number): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ id: providers.id })
    .from(providers)
    .where(eq(providers.id, id))
    .limit(1);
  return !!row;
}

/** Fetch the full secret for a specific API key (for admin reveal) */
export async function getApiKeySecret(id: number): Promise<string | null> {
  const db = getDb();
  const results = await db
    .select({ keySecret: apiKeys.keySecret })
    .from(apiKeys)
    .where(eq(apiKeys.id, id))
    .limit(1);
  return results[0]?.keySecret ?? null;
}
