import { getDb } from '../index.js';
import { apiKeys, users, apps, providers } from '../schema.js';
import { eq, and, like, or, sql, count, inArray, isNotNull, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { formatUtcDateTime } from './logs.js';
import { likePattern } from './like.js';
import { isBorrowActive, isBorrowExpired } from '../../services/borrow.js';

export interface ListApiKeysFilters {
  mode?: 'user' | 'app' | 'admin' | 'dedicated';
  userId?: number;
  groupId?: number;
  appId?: number;
  status?: 'active' | 'revoked' | 'expired' | 'quota_exceeded';
  search?: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
}

// ── 上游借调 ─────────────────────────────────────────────────────────────────

/** 借调展示对象（admin 列表/详情返回；不含借来 key 的明文）。 */
export interface ApiKeyBorrowView {
  /** 进行中（已到开始时间且未到期）。 */
  active: boolean;
  /** 已预约未开始（开始时间在未来）。 */
  scheduled: boolean;
  /** 到期时间已过（auth 惰性恢复会清除，或手动还原）。 */
  expired: boolean;
  /** 调用模式：passthrough=原样透传（从密钥借）；provider=走 Provider 管线（手动指定）。 */
  mode: 'passthrough' | 'provider';
  providerId: number;
  providerName: string | null;
  /** 来源一对一密钥（从密钥借时展示「借自谁」；手动指定为 null）。 */
  fromKeyId: number | null;
  fromKeyName: string | null;
  startedAt: Date | null;
  expiresAt: Date | null;
  note: string | null;
}

// 借调服务商需要第二次 join providers（原 provider join 已占用），用别名。
const borrowedProviders = alias(providers, 'borrowed_providers');
// 来源密钥展示需要自 join api_keys。
const borrowedFromKeys = alias(apiKeys, 'borrowed_from_keys');

/** 列表/详情共用：借调字段的 select 片段（借来 key 只取 IS NOT NULL 布尔，明文不出库）。 */
const borrowSelect = {
  borrowedProviderId: apiKeys.borrowedProviderId,
  borrowExpiresAt: apiKeys.borrowExpiresAt,
  borrowStartedAt: apiKeys.borrowStartedAt,
  borrowNote: apiKeys.borrowNote,
  borrowMode: apiKeys.borrowMode,
  borrowedFromKeyId: apiKeys.borrowedFromKeyId,
  hasBorrowedKey: sql<number>`(${apiKeys.borrowedUpstreamKey} IS NOT NULL)`,
  borrowedProvider: { id: borrowedProviders.id, name: borrowedProviders.name },
  fromKeyName: borrowedFromKeys.name,
};

type BorrowRow = {
  borrowedProviderId: number | null;
  borrowExpiresAt: Date | null;
  borrowStartedAt: Date | null;
  borrowNote: string | null;
  borrowMode: 'passthrough' | 'provider';
  borrowedFromKeyId: number | null;
  fromKeyName: string | null;
  hasBorrowedKey: number;
  // leftJoin 嵌套 select 的可空形状随上下文推导而异（整体 null 或内部列
  // null），两种都兼容——只用 name 且本身可空。
  borrowedProvider?: { id?: number | null; name?: string | null } | null;
};

/** 把查询行组装成脱敏的借调展示对象（无借用字段时返回 null）。 */
function buildBorrowView(row: BorrowRow): ApiKeyBorrowView | null {
  if (!Number(row.hasBorrowedKey) || row.borrowedProviderId == null) return null;
  const fields = {
    hasBorrowedKey: true,
    borrowedProviderId: row.borrowedProviderId,
    borrowStartAt: row.borrowStartedAt,
    borrowExpiresAt: row.borrowExpiresAt,
  };
  const active = isBorrowActive(fields);
  const expired = isBorrowExpired(fields);
  return {
    active,
    // 三态互斥推导：有借用字段、未到期、却不生效 → 必然是未到开始时间。
    // 不单独按时间算，避免与 isBorrowActive 的容差口径不一致出现 active+scheduled 并存。
    scheduled: !active && !expired,
    expired,
    mode: row.borrowMode,
    providerId: row.borrowedProviderId,
    providerName: row.borrowedProvider?.name ?? null,
    fromKeyId: row.borrowedFromKeyId,
    fromKeyName: row.borrowedFromKeyId != null ? (row.fromKeyName ?? null) : null,
    startedAt: row.borrowStartedAt,
    expiresAt: row.borrowExpiresAt,
    note: row.borrowNote,
  };
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
      ...borrowSelect,
    })
    .from(apiKeys)
    .leftJoin(users, eq(apiKeys.userId, users.id))
    .leftJoin(apps, eq(apiKeys.appId, apps.id))
    .leftJoin(providers, eq(apiKeys.providerId, providers.id))
    .leftJoin(borrowedProviders, eq(apiKeys.borrowedProviderId, borrowedProviders.id))
    .leftJoin(borrowedFromKeys, eq(apiKeys.borrowedFromKeyId, borrowedFromKeys.id))
    .where(where)
    .orderBy(sql`${apiKeys.createdAt} DESC`)
    .limit(pagination.pageSize)
    .offset(offset);

  return { items: items.map((item) => ({ ...item, borrow: buildBorrowView(item) })), total: totalResult?.total ?? 0 };
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
      ...borrowSelect,
    })
    .from(apiKeys)
    .leftJoin(users, eq(apiKeys.userId, users.id))
    .leftJoin(apps, eq(apiKeys.appId, apps.id))
    .leftJoin(providers, eq(apiKeys.providerId, providers.id))
    .leftJoin(borrowedProviders, eq(apiKeys.borrowedProviderId, borrowedProviders.id))
    .leftJoin(borrowedFromKeys, eq(apiKeys.borrowedFromKeyId, borrowedFromKeys.id))
    .where(eq(apiKeys.id, id))
    .limit(1);

  if (!results[0]) return null;
  return { ...results[0], borrow: buildBorrowView(results[0]) };
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

/** 取服务商的默认上游密钥（providers.api_key_enc），供手动借调缺省 key 时用。 */
export async function getProviderDefaultKey(id: number): Promise<string | null> {
  const db = getDb();
  const [row] = await db
    .select({ apiKeyEnc: providers.apiKeyEnc })
    .from(providers)
    .where(eq(providers.id, id))
    .limit(1);
  return row?.apiKeyEnc ?? null;
}

// ── 上游借调写操作 ───────────────────────────────────────────────────────────

export interface SetApiKeyBorrowParams {
  borrowedUpstreamKey: string;
  borrowedProviderId: number;
  /** 借调开始时间（null = 立即开始；可预约未来时刻）。 */
  borrowStartAt: Date | null;
  /** 借调到期时间（null = 不限期，直到手动还原）。 */
  borrowExpiresAt: Date | null;
  borrowNote: string | null;
  /** 调用模式：passthrough=透传（从密钥借）；provider=走 Provider 管线（手动指定）。 */
  borrowMode: 'passthrough' | 'provider';
  /** 来源一对一密钥 id（从密钥借时记录，手动指定为 null）。 */
  borrowedFromKeyId: number | null;
}

/** 设置/替换借调（覆盖语义：重新借调直接覆盖旧借用字段）。 */
export async function setApiKeyBorrow(id: number, params: SetApiKeyBorrowParams) {
  const db = getDb();
  await db
    .update(apiKeys)
    .set({
      borrowedUpstreamKey: params.borrowedUpstreamKey,
      borrowedProviderId: params.borrowedProviderId,
      borrowedFromKeyId: params.borrowedFromKeyId,
      // UTC 墙上钟字面量，与 expiresAt 同口径（session 钉死 UTC，见 formatUtcDateTime）。
      // 列 borrow_started_at 语义为「借用开始时间」：null 参数 = 立即开始（DB 当前时刻）。
      borrowStartedAt: params.borrowStartAt === null ? sql`UTC_TIMESTAMP()` : sql`${formatUtcDateTime(params.borrowStartAt)}`,
      borrowExpiresAt: params.borrowExpiresAt === null ? null : sql`${formatUtcDateTime(params.borrowExpiresAt)}`,
      borrowNote: params.borrowNote,
      borrowMode: params.borrowMode,
    })
    .where(eq(apiKeys.id, id));
}

/**
 * 清空借调字段（手动还原 / 过期惰性恢复共用）。WHERE 带 IS NOT NULL：
 * 没有借用的行是 no-op（幂等），并发恢复也只有一次实际写。
 */
export async function clearApiKeyBorrow(id: number) {
  const db = getDb();
  await db
    .update(apiKeys)
    .set({
      borrowedUpstreamKey: null,
      borrowedProviderId: null,
      borrowedFromKeyId: null,
      borrowExpiresAt: null,
      borrowStartedAt: null,
      borrowNote: null,
    })
    .where(and(eq(apiKeys.id, id), isNotNull(apiKeys.borrowedUpstreamKey)));
}

/**
 * 取一个 dedicated key 的**当前生效**上游凭证快照（作为借调来源）。
 * 来源自身处于借调中时，借出的是它此刻正在用的凭证——管理员在列表里看到的
 * 来源 key 状态就是它当前生效的凭证。返回 null 表示找不到该 dedicated key。
 */
export async function getDedicatedCredentialSnapshot(id: number): Promise<{
  providerId: number | null;
  upstreamApiKey: string | null;
  borrowedProviderId: number | null;
  borrowedUpstreamKey: string | null;
  borrowStartedAt: Date | null;
  borrowExpiresAt: Date | null;
} | null> {
  const db = getDb();
  const [row] = await db
    .select({
      providerId: apiKeys.providerId,
      upstreamApiKey: apiKeys.upstreamApiKeyEnc,
      borrowedProviderId: apiKeys.borrowedProviderId,
      borrowedUpstreamKey: apiKeys.borrowedUpstreamKey,
      borrowStartedAt: apiKeys.borrowStartedAt,
      borrowExpiresAt: apiKeys.borrowExpiresAt,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.mode, 'dedicated')))
    .limit(1);
  return row ?? null;
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
