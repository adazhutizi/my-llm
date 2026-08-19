import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from '../src/middleware/auth.js';

// Mock DB
const mockDb = {
  select: vi.fn(),
  update: vi.fn(),
};

vi.mock('../src/db/index.js', () => ({
  getDb: vi.fn(() => mockDb),
}));

// Mock quota functions
vi.mock('../src/services/quota.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/quota.js')>(
    '../src/services/quota.js'
  );
  return {
    ...actual,
    sumTokensUsed: vi.fn(async () => 0),
    getRateLimitConfig: vi.fn(async () => null),
  };
});

import { adminQuotas } from '../src/routes/admin/quotas.js';
import { sumTokensUsed, getRateLimitConfig } from '../src/services/quota.js';

beforeEach(() => {
  vi.clearAllMocks();
});

function makeApp() {
  const app = new Hono();
  // Simulate admin auth
  app.use('*', (c, next) => {
    c.set('auth', { mode: 'admin', keyId: 1 } as AuthContext);
    return next();
  });
  app.route('/admin', adminQuotas);
  return app;
}

describe('POST /admin/:type/:id/restore', () => {
  it('returns 404 when target not found', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn(async () => []),
        }),
      }),
    });

    const app = makeApp();
    const res = await app.request('/admin/api_keys/999/restore', { method: 'POST' });

    expect(res.status).toBe(404);
  });

  it('returns 400 when target is not quota_exceeded', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn(async () => [{ id: 1, status: 'active', name: 'test-key' }]),
        }),
      }),
    });

    const app = makeApp();
    const res = await app.request('/admin/api_keys/1/restore', { method: 'POST' });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('not_quota_exceeded');
  });

  it('restores quota_exceeded target to active', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn(async () => [{ id: 1, status: 'quota_exceeded', name: 'test-key' }]),
        }),
      }),
    });
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn(async () => ({})),
      }),
    });

    const app = makeApp();
    const res = await app.request('/admin/api_keys/1/restore', { method: 'POST' });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(mockDb.update).toHaveBeenCalled();
  });
});

describe('GET /admin/quotas/:type/:id', () => {
  it('returns quota status for a target', async () => {
    vi.mocked(getRateLimitConfig).mockResolvedValue({
      id: 1,
      targetType: 'api_key',
      targetId: 1,
      rpm: 60,
      qps: 10,
      dailyTokens: 10000,
      monthlyTokens: 100000,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    vi.mocked(sumTokensUsed)
      .mockResolvedValueOnce(3000)   // daily
      .mockResolvedValueOnce(25000)  // monthly
      .mockResolvedValueOnce(18000); // lastMonth

    // Mock the status lookup
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn(async () => [{ id: 1, status: 'active', name: 'test-key' }]),
        }),
      }),
    });

    const app = makeApp();
    const res = await app.request('/admin/quotas/api_keys/1');

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.limits.dailyTokens).toBe(10000);
    expect(body.limits.monthlyTokens).toBe(100000);
    expect(body.usage.today.tokens).toBe(3000);
    expect(body.usage.today.percentage).toBe(30);
    expect(body.usage.month.tokens).toBe(25000);
    expect(body.usage.month.percentage).toBe(25);
    expect(body.usage.lastMonth.tokens).toBe(18000);
  });
});
