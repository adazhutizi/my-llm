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
}));

vi.mock('../src/services/api-key.js', () => ({
  createApiKey: vi.fn(),
}));

import { adminApiKeys } from '../src/routes/admin/api-keys.js';
import { getApiKeyById, updateApiKey } from '../src/db/repositories/api-keys.js';
import { createApiKey } from '../src/services/api-key.js';

const mockedGetApiKeyById = vi.mocked(getApiKeyById);
const mockedUpdateApiKey = vi.mocked(updateApiKey);
const mockedCreateApiKey = vi.mocked(createApiKey);

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
