import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../src/middleware/auth.js';

// Mock validateApiKey to return a fake record without hitting DB
vi.mock('../src/services/api-key.js', () => ({
  validateApiKey: vi.fn(),
  detectKeyMode: (key: string) => {
    if (key.startsWith('usr_sk_')) return 'user';
    if (key.startsWith('app_sk_')) return 'app';
    if (key.startsWith('adm_sk_')) return 'admin';
    return null;
  },
}));

// Mock getDb to return null (we only test the path where key is found by prefix)
vi.mock('../src/db/index.js', () => ({
  getDb: vi.fn(() => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => []),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => ({})),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async () => ({})),
    })),
  })),
}));

// Mock tryRestoreQuota → false: the test asserts the 429 branch (over-quota,
// cannot restore). The success branch calls getLogger() (would need its own
// mock) and the real checkQuota → DB chain; forcing false sidesteps both.
// importActual keeps the rest of quota.js available to auth.ts.
vi.mock('../src/services/quota.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/quota.js')>(
    '../src/services/quota.js',
  );
  return { ...actual, tryRestoreQuota: vi.fn(async () => false) };
});

import { validateApiKey } from '../src/services/api-key.js';

beforeEach(() => {
  vi.clearAllMocks();
});

function makeApp() {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.get('/test', (c) => c.json({ ok: true }));
  return app;
}

describe('Auth middleware - quota_exceeded check', () => {
  it('rejects with 429 when api_key status is quota_exceeded', async () => {
    vi.mocked(validateApiKey).mockResolvedValue({
      id: 1,
      keySecret: 'abc',
      keyPrefix: 'usr_sk_abc',
      mode: 'user',
      userId: 10,
      appId: null,
      name: 'test',
      permissions: null,
      status: 'quota_exceeded',
      expiresAt: null,
      createdAt: new Date(),
    });

    const app = makeApp();
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer usr_sk_test1234567890123456789012345678901234' },
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('quota_exceeded');
  });

  it('rejects with 401 when api_key status is revoked', async () => {
    vi.mocked(validateApiKey).mockResolvedValue({
      id: 1,
      keySecret: 'abc',
      keyPrefix: 'usr_sk_abc',
      mode: 'user',
      userId: 10,
      appId: null,
      name: 'test',
      permissions: null,
      status: 'revoked',
      expiresAt: null,
      createdAt: new Date(),
    });

    const app = makeApp();
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer usr_sk_test1234567890123456789012345678901234' },
    });

    expect(res.status).toBe(401);
  });

  it('allows active key to pass through', async () => {
    vi.mocked(validateApiKey).mockResolvedValue({
      id: 1,
      keySecret: 'abc',
      keyPrefix: 'usr_sk_abc',
      mode: 'user',
      userId: 10,
      appId: null,
      name: 'test',
      permissions: null,
      status: 'active',
      expiresAt: null,
      createdAt: new Date(),
    });

    const app = makeApp();
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer usr_sk_test1234567890123456789012345678901234' },
    });

    expect(res.status).toBe(200);
  });
});
