import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/db/repositories/api-keys.js', () => ({
  listApiKeys: vi.fn(),
  getApiKeyById: vi.fn(),
  revokeApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  updateApiKey: vi.fn(),
  getApiKeySecret: vi.fn(),
  providerExists: vi.fn(),
  setApiKeyBorrow: vi.fn(),
  clearApiKeyBorrow: vi.fn(),
  getDedicatedCredentialSnapshot: vi.fn(),
  getProviderDefaultKey: vi.fn(),
}));

vi.mock('../src/services/api-key.js', () => ({
  createApiKey: vi.fn(),
}));

import { adminApiKeys } from '../src/routes/admin/api-keys.js';
import {
  getApiKeyById,
  updateApiKey,
  setApiKeyBorrow,
  clearApiKeyBorrow,
  getDedicatedCredentialSnapshot,
  getProviderDefaultKey,
  providerExists,
} from '../src/db/repositories/api-keys.js';
import { createApiKey } from '../src/services/api-key.js';

const mockedGetApiKeyById = vi.mocked(getApiKeyById);
const mockedUpdateApiKey = vi.mocked(updateApiKey);
const mockedCreateApiKey = vi.mocked(createApiKey);
const mockedSetApiKeyBorrow = vi.mocked(setApiKeyBorrow);
const mockedClearApiKeyBorrow = vi.mocked(clearApiKeyBorrow);
const mockedGetSnapshot = vi.mocked(getDedicatedCredentialSnapshot);
const mockedGetProviderDefaultKey = vi.mocked(getProviderDefaultKey);
const mockedProviderExists = vi.mocked(providerExists);

const validPolicy = {
  mode: 'allow',
  models: ['gpt-4o'],
  limits: { 'gpt-4o': { dailyTokens: 1_000_000, monthlyTokens: null } },
};

const existingKey = {
  id: 1,
  keySecret: 'usr_sk_x',
  keyPrefix: 'usr_sk_x',
  mode: 'user',
  userId: 10,
  appId: null,
  providerId: null,
  upstreamApiKeyEnc: null,
  name: 'K1',
  permissions: null,
  status: 'active',
  expiresAt: null,
  createdAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /admin/api-keys - modelPolicy validation', () => {
  function makeApp() {
    const app = new Hono();
    app.route('/', adminApiKeys);
    return app;
  }

  it('accepts a valid modelPolicy and passes permissions through', async () => {
    mockedCreateApiKey.mockResolvedValue({
      record: existingKey,
      plainText: 'usr_sk_new',
    } as never);

    const res = await makeApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'user',
        userId: 10,
        name: 'K1',
        permissions: { modelPolicy: validPolicy },
      }),
    });

    expect(res.status).toBe(201);
    expect(mockedCreateApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: { modelPolicy: validPolicy } })
    );
  });

  it('rejects a malformed modelPolicy with 400 and does not create', async () => {
    const res = await makeApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'user',
        userId: 10,
        permissions: { modelPolicy: { mode: 'whitelist', models: [] } },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('modelPolicy');
    expect(mockedCreateApiKey).not.toHaveBeenCalled();
  });

  it('leaves requests without permissions untouched', async () => {
    mockedCreateApiKey.mockResolvedValue({
      record: existingKey,
      plainText: 'usr_sk_new',
    } as never);

    const res = await makeApp().request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'user', userId: 10, name: 'K1' }),
    });

    expect(res.status).toBe(201);
    expect(mockedCreateApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: undefined })
    );
  });
});

describe('PATCH /admin/api-keys/:id - modelPolicy validation', () => {
  function makeApp() {
    const app = new Hono();
    app.route('/', adminApiKeys);
    return app;
  }

  it('accepts a valid modelPolicy on update', async () => {
    mockedGetApiKeyById.mockResolvedValue(existingKey as never);
    mockedGetApiKeyById.mockResolvedValueOnce(existingKey as never);
    mockedUpdateApiKey.mockResolvedValue();
    // second getApiKeyById call returns the updated row
    mockedGetApiKeyById.mockResolvedValue({ ...existingKey, permissions: { modelPolicy: validPolicy } } as never);

    const res = await makeApp().request('/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions: { modelPolicy: validPolicy } }),
    });

    expect(res.status).toBe(200);
    expect(mockedUpdateApiKey).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ permissions: { modelPolicy: validPolicy } })
    );
  });

  it('rejects a malformed modelPolicy with 400 and does not update', async () => {
    mockedGetApiKeyById.mockResolvedValue(existingKey as never);

    const res = await makeApp().request('/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        permissions: { modelPolicy: { mode: 'allow', models: ['ok', 123] } },
      }),
    });

    expect(res.status).toBe(400);
    expect(mockedUpdateApiKey).not.toHaveBeenCalled();
  });
});

describe('POST /admin/api-keys/:id/borrow - upstream borrow', () => {
  function makeApp() {
    const app = new Hono();
    app.route('/', adminApiKeys);
    return app;
  }

  const dedicatedKey = {
    ...existingKey,
    id: 7,
    mode: 'dedicated',
    userId: null,
    providerId: 2,
    upstreamApiKeyEnc: 'sk-original',
    borrow: null,
  };

  function request(body: unknown, id = 7) {
    return makeApp().request(`/${id}/borrow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('rejects non-dedicated keys with 400', async () => {
    mockedGetApiKeyById.mockResolvedValue(existingKey as never);
    const res = await request({ sourceKeyId: 9 }, 1);
    expect(res.status).toBe(400);
    expect(mockedSetApiKeyBorrow).not.toHaveBeenCalled();
  });

  it('rejects borrowing from itself', async () => {
    mockedGetApiKeyById.mockResolvedValue(dedicatedKey as never);
    const res = await request({ sourceKeyId: 7 });
    expect(res.status).toBe(400);
    expect(mockedGetSnapshot).not.toHaveBeenCalled();
  });

  it('rejects when the source key does not exist or is not dedicated', async () => {
    mockedGetApiKeyById.mockResolvedValue(dedicatedKey as never);
    mockedGetSnapshot.mockResolvedValue(null);
    const res = await request({ sourceKeyId: 404 });
    expect(res.status).toBe(404);
    expect(mockedSetApiKeyBorrow).not.toHaveBeenCalled();
  });

  it('rejects when the source key has no usable credential', async () => {
    mockedGetApiKeyById.mockResolvedValue(dedicatedKey as never);
    mockedGetSnapshot.mockResolvedValue({
      providerId: null,
      upstreamApiKey: null,
      borrowedProviderId: null,
      borrowedUpstreamKey: null,
      borrowStartedAt: null,
      borrowExpiresAt: null,
    });
    const res = await request({ sourceKeyId: 9 });
    expect(res.status).toBe(400);
    expect(mockedSetApiKeyBorrow).not.toHaveBeenCalled();
  });

  it('copies the source key ORIGINAL credential when the source is not borrowing', async () => {
    mockedGetApiKeyById.mockResolvedValue(dedicatedKey as never);
    mockedGetSnapshot.mockResolvedValue({
      providerId: 2, // 与目标密钥同服务商（跨服务商场景见下方专项用例）
      upstreamApiKey: 'sk-src-original',
      borrowedProviderId: null,
      borrowedUpstreamKey: null,
      borrowStartedAt: null,
      borrowExpiresAt: null,
    });

    const res = await request({ sourceKeyId: 9, note: '  从张三借用  ' });

    expect(res.status).toBe(200);
    expect(mockedSetApiKeyBorrow).toHaveBeenCalledWith(7, {
      borrowedUpstreamKey: 'sk-src-original',
      borrowedProviderId: 2,
      borrowStartAt: null,
      borrowExpiresAt: null,
      borrowNote: '从张三借用',
      borrowMode: 'passthrough',
      borrowedFromKeyId: 9,
    });
  });

  it('copies the source key CURRENTLY-EFFECTIVE credential when the source is itself borrowing', async () => {
    mockedGetApiKeyById.mockResolvedValue(dedicatedKey as never);
    mockedGetSnapshot.mockResolvedValue({
      providerId: 2, // 来源原服务商与目标一致
      upstreamApiKey: 'sk-src-original',
      borrowedProviderId: 2, // 来源借用中的凭证也同家
      borrowedUpstreamKey: 'sk-src-borrowed',
      borrowStartedAt: new Date(Date.now() - 3600_000),
      borrowExpiresAt: new Date(Date.now() + 3600_000),
    });

    const res = await request({ sourceKeyId: 9 });

    expect(res.status).toBe(200);
    expect(mockedSetApiKeyBorrow).toHaveBeenCalledWith(7, {
      borrowedUpstreamKey: 'sk-src-borrowed',
      borrowedProviderId: 2,
      borrowStartAt: null,
      borrowExpiresAt: null,
      borrowNote: null,
      borrowMode: 'passthrough',
      borrowedFromKeyId: 9,
    });
  });

  it('rejects a CROSS-provider source without an explicit allowCrossProvider flag', async () => {
    mockedGetApiKeyById.mockResolvedValue(dedicatedKey as never); // 绑 provider 2
    mockedGetSnapshot.mockResolvedValue({
      providerId: 3, // 来源绑的是另一家
      upstreamApiKey: 'sk-src',
      borrowedProviderId: null,
      borrowedUpstreamKey: null,
      borrowStartedAt: null,
      borrowExpiresAt: null,
    });

    const res = await request({ sourceKeyId: 9 });

    expect(res.status).toBe(400);
    const body = await res.json();
    // 面向管理员的文案：给操作路径（勾选开关 / 改手动方式），不带 API 字段名
    expect(body.error).toContain('另一家服务商');
    expect(body.error).toContain('手动指定服务商');
    expect(mockedSetApiKeyBorrow).not.toHaveBeenCalled();
  });

  it('allows a cross-provider source when allowCrossProvider is explicitly true', async () => {
    mockedGetApiKeyById.mockResolvedValue(dedicatedKey as never); // 绑 provider 2
    mockedGetSnapshot.mockResolvedValue({
      providerId: 3,
      upstreamApiKey: 'sk-src',
      borrowedProviderId: null,
      borrowedUpstreamKey: null,
      borrowStartedAt: null,
      borrowExpiresAt: null,
    });

    const res = await request({ sourceKeyId: 9, allowCrossProvider: true });

    expect(res.status).toBe(200);
    expect(mockedSetApiKeyBorrow).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ borrowedUpstreamKey: 'sk-src', borrowedProviderId: 3, borrowMode: 'passthrough', borrowedFromKeyId: 9 }),
    );
  });

  it('rejects manual borrow missing providerId (key alone is not a source)', async () => {
    mockedGetApiKeyById.mockResolvedValue(dedicatedKey as never);
    const res = await request({ upstreamApiKey: 'sk-x' });
    expect(res.status).toBe(400);
    expect(mockedSetApiKeyBorrow).not.toHaveBeenCalled();
  });

  it('uses the provider DEFAULT key when upstreamApiKey is omitted', async () => {
    mockedGetApiKeyById.mockResolvedValue(dedicatedKey as never);
    mockedProviderExists.mockResolvedValue(true);
    mockedGetProviderDefaultKey.mockResolvedValue('sk-provider-default');

    const res = await request({ providerId: 2 });

    expect(res.status).toBe(200);
    expect(mockedGetProviderDefaultKey).toHaveBeenCalledWith(2);
    expect(mockedSetApiKeyBorrow).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ borrowedUpstreamKey: 'sk-provider-default', borrowedProviderId: 2, borrowMode: 'provider', borrowedFromKeyId: null }),
    );
  });

  it('rejects an omitted key when the provider has no default key configured', async () => {
    mockedGetApiKeyById.mockResolvedValue(dedicatedKey as never);
    mockedProviderExists.mockResolvedValue(true);
    mockedGetProviderDefaultKey.mockResolvedValue(null);

    const res = await request({ providerId: 2 });

    expect(res.status).toBe(400);
    expect(mockedSetApiKeyBorrow).not.toHaveBeenCalled();
  });

  it('rejects manual borrow with a non-existent provider', async () => {
    mockedGetApiKeyById.mockResolvedValue(dedicatedKey as never);
    mockedProviderExists.mockResolvedValue(false);
    const res = await request({ providerId: 99, upstreamApiKey: 'sk-x' });
    expect(res.status).toBe(404);
    expect(mockedSetApiKeyBorrow).not.toHaveBeenCalled();
  });

  it('rejects when no source is specified at all', async () => {
    mockedGetApiKeyById.mockResolvedValue(dedicatedKey as never);
    const res = await request({});
    expect(res.status).toBe(400);
  });

  it('rejects an expiry at or before now', async () => {
    mockedGetApiKeyById.mockResolvedValue(dedicatedKey as never);
    mockedProviderExists.mockResolvedValue(true);
    const res = await request({
      providerId: 2,
      upstreamApiKey: 'sk-x',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(res.status).toBe(400);
    expect(mockedSetApiKeyBorrow).not.toHaveBeenCalled();
  });

  it('accepts manual borrow with a future expiry and passes it through', async () => {
    mockedGetApiKeyById.mockResolvedValue(dedicatedKey as never);
    mockedProviderExists.mockResolvedValue(true);
    const exp = new Date(Date.now() + 86_400_000);

    const res = await request({ providerId: 2, upstreamApiKey: 'sk-x', expiresAt: exp.toISOString() });

    expect(res.status).toBe(200);
    const called = mockedSetApiKeyBorrow.mock.calls[0];
    expect(called?.[1].borrowedUpstreamKey).toBe('sk-x');
    expect(called?.[1].borrowedProviderId).toBe(2);
    expect(called?.[1].borrowStartAt).toBeNull();
    // 手动指定 → 走 Provider 管线（模型路由 + 协议转换）
    expect(called?.[1].borrowMode).toBe('provider');
    // toEqual 按值比较 Date，跨时区安全
    expect(called?.[1].borrowExpiresAt).toEqual(exp);
  });

  it('rejects a start time in the past', async () => {
    mockedGetApiKeyById.mockResolvedValue(dedicatedKey as never);
    mockedProviderExists.mockResolvedValue(true);

    const res = await request({
      providerId: 2,
      upstreamApiKey: 'sk-x',
      startAt: new Date(Date.now() - 86_400_000).toISOString(),
    });

    expect(res.status).toBe(400);
    expect(mockedSetApiKeyBorrow).not.toHaveBeenCalled();
  });

  it('rejects an expiry at or before the start time', async () => {
    mockedGetApiKeyById.mockResolvedValue(dedicatedKey as never);
    mockedProviderExists.mockResolvedValue(true);

    const res = await request({
      providerId: 2,
      upstreamApiKey: 'sk-x',
      startAt: new Date(Date.now() + 7_200_000).toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    expect(res.status).toBe(400);
    expect(mockedSetApiKeyBorrow).not.toHaveBeenCalled();
  });

  it('accepts a pre-set borrow with a future start time and passes it through', async () => {
    mockedGetApiKeyById.mockResolvedValue(dedicatedKey as never);
    mockedProviderExists.mockResolvedValue(true);
    const start = new Date(Date.now() + 3_600_000);
    const exp = new Date(Date.now() + 86_400_000);

    const res = await request({
      providerId: 2,
      upstreamApiKey: 'sk-x',
      startAt: start.toISOString(),
      expiresAt: exp.toISOString(),
    });

    expect(res.status).toBe(200);
    const called = mockedSetApiKeyBorrow.mock.calls[0];
    expect(called?.[1].borrowStartAt).toEqual(start);
    expect(called?.[1].borrowExpiresAt).toEqual(exp);
  });
});

describe('DELETE /admin/api-keys/:id/borrow - manual restore', () => {
  function makeApp() {
    const app = new Hono();
    app.route('/', adminApiKeys);
    return app;
  }

  it('clears the borrow and returns the updated key (idempotent success)', async () => {
    mockedGetApiKeyById.mockResolvedValue({
      ...existingKey,
      id: 7,
      mode: 'dedicated',
      providerId: 2,
    } as never);

    const res = await makeApp().request('/7/borrow', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(mockedClearApiKeyBorrow).toHaveBeenCalledWith(7);
  });

  it('rejects non-dedicated keys with 400', async () => {
    mockedGetApiKeyById.mockResolvedValue(existingKey as never);

    const res = await makeApp().request('/1/borrow', { method: 'DELETE' });

    expect(res.status).toBe(400);
    expect(mockedClearApiKeyBorrow).not.toHaveBeenCalled();
  });
});
