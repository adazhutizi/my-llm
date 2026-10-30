import { Hono } from 'hono';
import {
  listApiKeys,
  getApiKeyById,
  revokeApiKey,
  deleteApiKey,
  updateApiKey,
  getApiKeySecret,
  providerExists,
  setApiKeyBorrow,
  clearApiKeyBorrow,
  getDedicatedCredentialSnapshot,
  getProviderDefaultKey,
} from '../../db/repositories/api-keys.js';
import { createApiKey } from '../../services/api-key.js';
import { ModelPolicySchema } from '../../services/model-policy.js';
import { isBorrowActive } from '../../services/borrow.js';

export const adminApiKeys = new Hono();

/**
 * Validate the modelPolicy key inside a permissions payload. Other
 * permissions keys pass through untouched (forward compatibility), but a
 * present modelPolicy must parse cleanly — persisting malformed policy would
 * make every request on that key fail-open (parseModelPolicy treats bad data
 * as unrestricted), silently discarding the admin's intent.
 * Returns an error message or null when acceptable.
 */
function checkPermissions(permissions: unknown): string | null {
  if (!permissions || typeof permissions !== 'object') return null;
  const modelPolicy = (permissions as Record<string, unknown>).modelPolicy;
  if (modelPolicy === undefined) return null;

  const parsed = ModelPolicySchema.safeParse(modelPolicy);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.path.length > 0 ? ` at "${issue.path.join('.')}"` : '';
    return `invalid permissions.modelPolicy${path}: ${issue.message}`;
  }
  return null;
}

// GET /admin/api-keys - list API keys
adminApiKeys.get('/', async (c) => {
  const page = Number(c.req.query('page') ?? 1);
  const pageSize = Number(c.req.query('pageSize') ?? 20);

  const mode = c.req.query('mode') as 'user' | 'app' | 'admin' | 'dedicated' | undefined;
  const userId = c.req.query('userId') ? Number(c.req.query('userId')) : undefined;
  const groupId = c.req.query('groupId') ? Number(c.req.query('groupId')) : undefined;
  const appId = c.req.query('appId') ? Number(c.req.query('appId')) : undefined;
  const status = c.req.query('status') as 'active' | 'revoked' | 'expired' | 'quota_exceeded' | undefined;
  const search = c.req.query('search')?.trim() || undefined;

  const result = await listApiKeys(
    { mode, userId, groupId, appId, status, search },
    { page, pageSize },
  );

  return c.json({
    data: result.items,
    pagination: { page, pageSize, total: result.total },
  });
});

// POST /admin/api-keys - create API key
adminApiKeys.post('/', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const mode = body.mode as 'user' | 'app' | 'admin' | 'dedicated' | undefined;
  if (!mode || !['user', 'app', 'admin', 'dedicated'].includes(mode)) {
    return c.json({ error: 'mode is required and must be user, app, admin, or dedicated' }, 400);
  }

  const permissionsError = checkPermissions(body.permissions);
  if (permissionsError) {
    return c.json({ error: permissionsError }, 400);
  }

  const name = (body.name as string) ?? `${mode}-key`;
  const userId = body.userId as number | undefined;
  const appId = body.appId as number | undefined;
  const permissions = body.permissions as Record<string, unknown> | undefined;
  const expiresAt = body.expiresAt ? new Date(body.expiresAt as string) : undefined;
  const providerId = body.providerId as number | undefined;
  const upstreamApiKey = body.upstreamApiKey as string | undefined;

  if (mode === 'user' && !userId) {
    return c.json({ error: 'userId is required for user mode keys' }, 400);
  }
  if (mode === 'app' && !appId) {
    return c.json({ error: 'appId is required for app mode keys' }, 400);
  }
  if (mode === 'dedicated') {
    if (!providerId) {
      return c.json({ error: 'providerId is required for dedicated mode keys' }, 400);
    }
    if (!upstreamApiKey) {
      return c.json({ error: 'upstreamApiKey is required for dedicated mode keys' }, 400);
    }
  }

  const result = await createApiKey({
    mode,
    name,
    userId,
    appId,
    permissions,
    expiresAt,
    providerId: mode === 'dedicated' ? providerId : undefined,
    upstreamApiKey: mode === 'dedicated' ? upstreamApiKey : undefined,
  });

  return c.json({ data: { ...result.record, plainText: result.plainText } }, 201);
});

// GET /admin/api-keys/:id - get key details
adminApiKeys.get('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid key ID' }, 400);
  }

  const key = await getApiKeyById(id);
  if (!key) {
    return c.json({ error: 'API key not found' }, 404);
  }

  return c.json({ data: key });
});

// GET /admin/api-keys/:id/secret - reveal full API key
adminApiKeys.get('/:id/secret', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid key ID' }, 400);
  }

  const key = await getApiKeyById(id);
  if (!key) {
    return c.json({ error: 'API key not found' }, 404);
  }

  const secret = await getApiKeySecret(id);
  return c.json({ data: { id, keySecret: secret } });
});

// ── 上游借调（dedicated 专用）────────────────────────────────────────────────
// 原上游 key 额度耗尽时，管理员临时借用其他上游凭证：借用期间请求改走
// borrowedProviderId 的 baseUrl + 借来的凭证；expiresAt 到期由 auth 惰性恢复，
// 或管理员随时 DELETE 手动还原。原 upstream_api_key_enc 永不被覆盖。

// POST /admin/api-keys/:id/borrow - 设置/替换借调
// 两种来源：sourceKeyId（复制另一个一对一 key 当前生效的凭证快照）或
// providerId + upstreamApiKey（手动指定）。expiresAt 可空 = 不限期。
adminApiKeys.post('/:id/borrow', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid key ID' }, 400);
  }

  const existing = await getApiKeyById(id);
  if (!existing) {
    return c.json({ error: 'API key not found' }, 404);
  }
  if (existing.mode !== 'dedicated') {
    return c.json({ error: '只有一对一转发密钥支持上游借调' }, 400);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const sourceKeyId = body.sourceKeyId as number | undefined;
  const providerId = body.providerId as number | undefined;
  const upstreamApiKey = body.upstreamApiKey as string | undefined;

  let effectiveProviderId: number;
  let effectiveKey: string;
  // 调用模式：从密钥借 = 原样透传（dedicated 一对一本义，含跨服务商——协议
  // 兼容由管理员确认）；手动指定 = 走普通密钥的 Provider 管线（模型路由 +
  // 双协议转换），解决跨服务商协议不匹配。
  let borrowMode: 'passthrough' | 'provider';
  if (sourceKeyId !== undefined) {
    borrowMode = 'passthrough';
    if (sourceKeyId === id) {
      return c.json({ error: '不能借用密钥自身的凭证，请选择其他一对一密钥' }, 400);
    }
    const src = await getDedicatedCredentialSnapshot(sourceKeyId);
    if (!src) {
      return c.json({ error: '来源密钥不存在，或不是一对一转发密钥' }, 404);
    }
    // 借出来源「当前生效」的凭证：来源自身借调中就借它正用的那个。
    const srcBorrowing = isBorrowActive({
      hasBorrowedKey: !!src.borrowedUpstreamKey,
      borrowedProviderId: src.borrowedProviderId,
      borrowStartAt: src.borrowStartedAt,
      borrowExpiresAt: src.borrowExpiresAt,
    });
    effectiveProviderId = srcBorrowing ? src.borrowedProviderId! : src.providerId!;
    effectiveKey = srcBorrowing ? src.borrowedUpstreamKey! : src.upstreamApiKey!;
    if (!effectiveProviderId || !effectiveKey) {
      return c.json({ error: '来源密钥未配置上游凭证，无法借调' }, 400);
    }
    // 跨服务商防呆：dedicated 原样透传——客户端实际怎么调用（路径/协议/请求
    // 体）就原样转发到借来的上游，与原绑定服务商无关；客户端调用方式与借来
    // 上游不兼容（如 OpenAI 协议请求打到 Anthropic 端点）会直接 4xx。默认只
    // 允许借同服务商的密钥；跨服务商须显式 allowCrossProvider: true（前端有
    // 对应开关），或改用手动指定服务商方式（borrow_mode=provider，网关按客户
    // 端协议自动转换后再发上游）。错误消息面向管理员：说清两条出路，不夹带
    // API 字段名。
    if (effectiveProviderId !== existing.providerId && body.allowCrossProvider !== true) {
      return c.json(
        {
          error:
            '所选来源密钥属于另一家服务商。从密钥借调是原样透传，需自行确认调用兼容；' +
            '如确认，请勾选「允许选择不同服务商的密钥」后重试；如需网关自动转换协议，请改用「手动指定服务商」方式借调',
        },
        400,
      );
    }
  } else if (providerId !== undefined || upstreamApiKey !== undefined) {
    borrowMode = 'provider';
    if (!providerId) {
      return c.json({ error: '请选择要借调到的服务商（上游密钥可留空，留空则使用该服务商的默认密钥）' }, 400);
    }
    if (!(await providerExists(providerId))) {
      return c.json({ error: '服务商不存在' }, 404);
    }
    effectiveProviderId = providerId;
    if (upstreamApiKey) {
      effectiveKey = upstreamApiKey;
    } else {
      // 未显式给 key → 借该服务商的默认密钥（快照语义：借调期间 provider 默认
      // key 轮换不影响进行中的借用，与「从其他密钥借」一致）。
      const defaultKey = await getProviderDefaultKey(providerId);
      if (!defaultKey) {
        return c.json({ error: '该服务商未配置默认密钥，请填写上游 API 密钥后再借调' }, 400);
      }
      effectiveKey = defaultKey;
    }
  } else {
    return c.json({ error: '请选择来源密钥（从其他一对一密钥借）或手动指定服务商' }, 400);
  }

  // 开始时间：默认立即（null）；可预约未来时刻（「提前设置」）。
  const startAtRaw = body.startAt as string | null | undefined;
  const startAt = startAtRaw ? new Date(startAtRaw) : null;
  if (startAt && (isNaN(startAt.getTime()) || startAt.getTime() < Date.now() - 60_000)) {
    return c.json({ error: '借调开始时间不能早于当前时间' }, 400);
  }

  const expiresAtRaw = body.expiresAt as string | null | undefined;
  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : null;
  if (expiresAt && (isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
    return c.json({ error: '借调到期时间必须晚于当前时间' }, 400);
  }
  if (expiresAt && startAt && expiresAt.getTime() <= startAt.getTime()) {
    return c.json({ error: '借调到期时间必须晚于开始时间' }, 400);
  }

  const noteRaw = body.note as string | undefined;
  const note = typeof noteRaw === 'string' && noteRaw.trim() ? noteRaw.trim().slice(0, 200) : null;

  await setApiKeyBorrow(id, {
    borrowedUpstreamKey: effectiveKey,
    borrowedProviderId: effectiveProviderId,
    borrowStartAt: startAt,
    borrowExpiresAt: expiresAt,
    borrowNote: note,
    borrowMode,
    // 来源密钥（从密钥借时记录，供借调中回看「借自谁」；手动指定为 null）
    borrowedFromKeyId: sourceKeyId ?? null,
  });

  const updated = await getApiKeyById(id);
  return c.json({ data: updated });
});

// DELETE /admin/api-keys/:id/borrow - 手动还原（幂等，无借用时同样成功）
adminApiKeys.delete('/:id/borrow', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid key ID' }, 400);
  }

  const existing = await getApiKeyById(id);
  if (!existing) {
    return c.json({ error: 'API key not found' }, 404);
  }
  if (existing.mode !== 'dedicated') {
    return c.json({ error: '只有一对一转发密钥支持上游借调' }, 400);
  }

  await clearApiKeyBorrow(id);
  const updated = await getApiKeyById(id);
  return c.json({ data: updated });
});

// PATCH /admin/api-keys/:id - update key
adminApiKeys.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid key ID' }, 400);
  }

  const existing = await getApiKeyById(id);
  if (!existing) {
    return c.json({ error: 'API key not found' }, 404);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const name = body.name as string | undefined;
  const permissions = body.permissions as Record<string, unknown> | undefined;
  const expiresAt = body.expiresAt !== undefined
    ? (body.expiresAt ? new Date(body.expiresAt as string) : null)
    : undefined;
  const upstreamApiKey = body.upstreamApiKey as string | undefined;

  const permissionsError = checkPermissions(permissions);
  if (permissionsError) {
    return c.json({ error: permissionsError }, 400);
  }

  // Only dedicated keys bind to a provider; re-binding changes the upstream
  // baseUrl. Reject other modes and validate the target provider exists.
  const providerIdRaw = body.providerId;
  let providerId: number | undefined;
  if (providerIdRaw !== undefined) {
    if (existing.mode !== 'dedicated') {
      return c.json({ error: '只有一对一转发密钥可以绑定服务商' }, 400);
    }
    const pid = Number(providerIdRaw);
    if (!pid || isNaN(pid)) {
      return c.json({ error: 'providerId 无效' }, 400);
    }
    if (!(await providerExists(pid))) {
      return c.json({ error: '服务商不存在' }, 404);
    }
    providerId = pid;
  }

  await updateApiKey(id, { name, permissions, expiresAt, upstreamApiKey, providerId });

  const updated = await getApiKeyById(id);
  return c.json({ data: updated });
});

// POST /admin/api-keys/:id/revoke - revoke key
adminApiKeys.post('/:id/revoke', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid key ID' }, 400);
  }

  const existing = await getApiKeyById(id);
  if (!existing) {
    return c.json({ error: 'API key not found' }, 404);
  }

  await revokeApiKey(id);
  const updated = await getApiKeyById(id);
  return c.json({ data: updated });
});

// DELETE /admin/api-keys/:id - delete key (only if revoked/expired)
adminApiKeys.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id)) {
    return c.json({ error: 'Invalid key ID' }, 400);
  }

  const existing = await getApiKeyById(id);
  if (!existing) {
    return c.json({ error: 'API key not found' }, 404);
  }

  if (existing.status === 'active') {
    return c.json({ error: '密钥正在使用中，请先撤销后再删除' }, 400);
  }

  await deleteApiKey(id);
  return c.json({ data: { message: 'API key deleted' } });
});
