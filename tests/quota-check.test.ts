import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from '../src/middleware/auth.js';

// Mock DB-dependent quota functions
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

vi.mock('../src/services/quota-cache.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/quota-cache.js')>(
    '../src/services/quota-cache.js'
  );
  return {
    ...actual,
    getQuotaCache: vi.fn(async () => null),
  };
});

import { quotaCheckMiddleware } from '../src/middleware/quota-check.js';
import { sumTokensUsed, getRateLimitConfig } from '../src/services/quota.js';

beforeEach(() => {
  vi.clearAllMocks();
});

function makeApp(auth: AuthContext) {
  const app = new Hono();
  app.use('*', (c, next) => {
    c.set('auth', auth);
    return next();
  });
  app.use('*', quotaCheckMiddleware);
  app.post('/openai/v1/chat/completions', (c) => c.json({ ok: true }));
  return app;
}

describe('quotaCheckMiddleware', () => {
  it('passes through when no rate limits configured', async () => {
    const auth: AuthContext = { mode: 'user', keyId: 1, userId: 10 };
    const app = makeApp(auth);

    const res = await app.request('/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ max_tokens: 100 }),
    });

    expect(res.status).toBe(200);
  });

  it('rejects when daily quota would be exceeded', async () => {
    vi.mocked(getRateLimitConfig).mockResolvedValue({
      id: 1,
      targetType: 'api_key',
      targetId: 1,
      rpm: 60,
      qps: 10,
      dailyTokens: 1000,
      monthlyTokens: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    vi.mocked(sumTokensUsed).mockResolvedValue(950);

    const auth: AuthContext = { mode: 'user', keyId: 1, userId: 10 };
    const app = makeApp(auth);

    const res = await app.request('/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ max_tokens: 600 }),
    });

    expect(res.status).toBe(429);
    const body = await res.json() as any;
    expect(body.error.code).toBe('quota_exceeded');
    expect(body.error.message).toContain('daily');
  });

  it('rejects when monthly quota would be exceeded', async () => {
    vi.mocked(getRateLimitConfig).mockResolvedValue({
      id: 1,
      targetType: 'api_key',
      targetId: 1,
      rpm: 60,
      qps: 10,
      dailyTokens: null,
      monthlyTokens: 5000,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    vi.mocked(sumTokensUsed).mockResolvedValue(4800);

    const auth: AuthContext = { mode: 'user', keyId: 1, userId: 10 };
    const app = makeApp(auth);

    const res = await app.request('/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ max_tokens: 300 }),
    });

    expect(res.status).toBe(429);
    const body = await res.json() as any;
    expect(body.error.message).toContain('monthly');
  });

  it('passes when usage is within limits', async () => {
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
    vi.mocked(sumTokensUsed).mockResolvedValue(100);

    const auth: AuthContext = { mode: 'user', keyId: 1, userId: 10 };
    const app = makeApp(auth);

    const res = await app.request('/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ max_tokens: 500 }),
    });

    expect(res.status).toBe(200);
  });

  it('uses default max_tokens when body has none', async () => {
    vi.mocked(getRateLimitConfig).mockResolvedValue({
      id: 1,
      targetType: 'api_key',
      targetId: 1,
      rpm: 60,
      qps: 10,
      dailyTokens: 5000,
      monthlyTokens: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    vi.mocked(sumTokensUsed).mockResolvedValue(1500);

    const auth: AuthContext = { mode: 'user', keyId: 1, userId: 10 };
    const app = makeApp(auth);

    // No max_tokens in body -> default 4096; 1500 + 4096 = 5596 > 5000 -> reject
    const res = await app.request('/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });

    expect(res.status).toBe(429);
  });
});
