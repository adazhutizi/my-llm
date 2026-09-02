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
  app.post('/anthropic/v1/messages', (c) => c.json({ ok: true }));
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

describe('quotaCheckMiddleware - per-key model policy', () => {
  beforeEach(() => {
    // mockResolvedValue implementations are sticky across vi.clearAllMocks()
    // (it only clears call history) — earlier tests in this file leave
    // limit/usage values behind that would 429 the policy tests below.
    vi.mocked(getRateLimitConfig).mockResolvedValue(null as never);
    vi.mocked(sumTokensUsed).mockResolvedValue(0);
  });

  function post(app: ReturnType<typeof makeApp>, path: string, body: unknown) {
    return app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('allows a model on the allowlist', async () => {
    const auth: AuthContext = {
      mode: 'user',
      keyId: 1,
      permissions: { modelPolicy: { mode: 'allow', models: ['gpt-4o'] } },
    };
    const app = makeApp(auth);

    const res = await post(app, '/openai/v1/chat/completions', { model: 'gpt-4o', max_tokens: 100 });
    expect(res.status).toBe(200);
  });

  it('rejects a model outside the allowlist with 403 model_not_allowed', async () => {
    const auth: AuthContext = {
      mode: 'user',
      keyId: 1,
      permissions: { modelPolicy: { mode: 'allow', models: ['gpt-4o'] } },
    };
    const app = makeApp(auth);

    const res = await post(app, '/openai/v1/chat/completions', { model: 'claude-sonnet-4', max_tokens: 100 });
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error.code).toBe('model_not_allowed');
    expect(body.error.message).toContain('claude-sonnet-4');
  });

  it('rejects a blocked model and allows everything else', async () => {
    const auth: AuthContext = {
      mode: 'app',
      keyId: 2,
      appId: 9,
      permissions: { modelPolicy: { mode: 'block', models: ['gpt-4o'] } },
    };
    const app = makeApp(auth);

    const blocked = await post(app, '/openai/v1/chat/completions', { model: 'gpt-4o', max_tokens: 100 });
    expect(blocked.status).toBe(403);

    const allowed = await post(app, '/openai/v1/chat/completions', { model: 'qwen-max', max_tokens: 100 });
    expect(allowed.status).toBe(200);
  });

  it('allows any model when no policy is configured', async () => {
    const auth: AuthContext = { mode: 'user', keyId: 1 };
    const app = makeApp(auth);

    const res = await post(app, '/openai/v1/chat/completions', { model: 'gpt-4o', max_tokens: 100 });
    expect(res.status).toBe(200);
  });

  it('formats 403 as Anthropic permission_error on /anthropic paths', async () => {
    const auth: AuthContext = {
      mode: 'user',
      keyId: 1,
      permissions: { modelPolicy: { mode: 'allow', models: ['claude-sonnet-4'] } },
    };
    const app = makeApp(auth);

    const res = await post(app, '/anthropic/v1/messages', { model: 'gpt-4o', max_tokens: 100 });
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error.type).toBe('permission_error');
  });

  it('403 (model not allowed) wins over total-quota 429', async () => {
    // Total quota WOULD reject (950 + 600 > 1000), but the model is not on
    // the allowlist — the permission answer must come first.
    vi.mocked(getRateLimitConfig).mockResolvedValue({
      id: 1,
      targetType: 'api_key',
      targetId: 1,
      rpm: 60,
      qps: 10,
      dailyTokens: 1000,
      monthlyTokens: null,
    });
    vi.mocked(sumTokensUsed).mockResolvedValue(950);

    const auth: AuthContext = {
      mode: 'user',
      keyId: 1,
      permissions: { modelPolicy: { mode: 'allow', models: ['gpt-4o'] } },
    };
    const app = makeApp(auth);

    const res = await post(app, '/openai/v1/chat/completions', { model: 'claude-sonnet-4', max_tokens: 600 });
    expect(res.status).toBe(403);
  });

  it('enforces per-model daily limits with the model name in the message', async () => {
    vi.mocked(sumTokensUsed).mockResolvedValue(950);

    const auth: AuthContext = {
      mode: 'user',
      keyId: 1,
      permissions: {
        modelPolicy: {
          mode: 'allow',
          models: ['gpt-4o', 'qwen-max'],
          limits: { 'gpt-4o': { dailyTokens: 1000, monthlyTokens: null } },
        },
      },
    };
    const app = makeApp(auth);

    const res = await post(app, '/openai/v1/chat/completions', { model: 'gpt-4o', max_tokens: 600 });
    expect(res.status).toBe(429);
    const body = await res.json() as any;
    expect(body.error.code).toBe('quota_exceeded');
    expect(body.error.message).toContain('for model gpt-4o');
    expect(body.error.message).toContain('daily');

    // per-model usage query must be scoped to (api_key, model)
    expect(sumTokensUsed).toHaveBeenCalledWith(
      { type: 'api_key', id: 1 },
      expect.any(Date),
      undefined,
      'gpt-4o',
    );
  });

  it('passes per-model limits when within budget', async () => {
    vi.mocked(sumTokensUsed).mockResolvedValue(100);

    const auth: AuthContext = {
      mode: 'user',
      keyId: 1,
      permissions: {
        modelPolicy: {
          mode: 'allow',
          models: ['gpt-4o'],
          limits: { 'gpt-4o': { dailyTokens: 1000, monthlyTokens: 10_000 } },
        },
      },
    };
    const app = makeApp(auth);

    const res = await post(app, '/openai/v1/chat/completions', { model: 'gpt-4o', max_tokens: 500 });
    expect(res.status).toBe(200);
  });

  it('enforces per-model monthly limits', async () => {
    vi.mocked(sumTokensUsed).mockResolvedValue(9500);

    const auth: AuthContext = {
      mode: 'user',
      keyId: 1,
      permissions: {
        modelPolicy: {
          mode: 'allow',
          models: ['gpt-4o'],
          limits: { 'gpt-4o': { dailyTokens: null, monthlyTokens: 10_000 } },
        },
      },
    };
    const app = makeApp(auth);

    const res = await post(app, '/openai/v1/chat/completions', { model: 'gpt-4o', max_tokens: 600 });
    expect(res.status).toBe(429);
    const body = await res.json() as any;
    expect(body.error.message).toContain('for model gpt-4o');
    expect(body.error.message).toContain('monthly');
  });

  it('skips policy checks when the body has no model field', async () => {
    const auth: AuthContext = {
      mode: 'user',
      keyId: 1,
      permissions: { modelPolicy: { mode: 'allow', models: ['gpt-4o'] } },
    };
    const app = makeApp(auth);

    // catch-all paths (no model in body) must not be 403'd
    const res = await post(app, '/openai/v1/chat/completions', { max_tokens: 100 });
    expect(res.status).toBe(200);
  });
});
