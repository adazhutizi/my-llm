import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from '../src/middleware/auth.js';

// `and` is replaced with an argument collector so we can count WHERE
// conditions (the allow/block filter appends one to the base isActive eq).
const andCollector = vi.hoisted(() => vi.fn((...args: unknown[]) => ({ __and: args })));
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, and: andCollector };
});

// virtualModels rows returned by the mocked query
const rows = vi.hoisted(() => [
  { modelId: 'claude-sonnet-4', provider: 'anthropic', createdAt: new Date('2026-01-01T00:00:00Z') },
  { modelId: 'gpt-4o', provider: 'openai', createdAt: new Date('2026-01-02T00:00:00Z') },
  { modelId: 'qwen-max', provider: 'dashscope', createdAt: new Date('2026-01-03T00:00:00Z') },
]);

const mockDb = vi.hoisted(() => ({
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        orderBy: vi.fn(async () => rows),
      })),
    })),
  })),
}));

vi.mock('../src/db/index.js', () => ({ getDb: vi.fn(() => mockDb) }));

import { models } from '../src/routes/openai/models.js';

beforeEach(() => {
  vi.clearAllMocks();
});

function makeApp(auth?: AuthContext) {
  const app = new Hono();
  app.use('*', (c, next) => {
    if (auth) c.set('auth', auth);
    return next();
  });
  app.route('/', models);
  return app;
}

describe('GET /openai/v1/models - per-key filtering', () => {
  it('returns all active models without a policy', async () => {
    const app = makeApp({ mode: 'user', keyId: 1 });
    const res = await app.request('/', { method: 'GET' });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.object).toBe('list');
    expect(body.data).toHaveLength(3);
    expect(andCollector.mock.calls.at(-1)).toHaveLength(1); // isActive only
  });

  it('appends an inArray condition for an allowlist policy', async () => {
    const app = makeApp({
      mode: 'user',
      keyId: 1,
      permissions: { modelPolicy: { mode: 'allow', models: ['gpt-4o', 'qwen-max'] } },
    });
    const res = await app.request('/', { method: 'GET' });

    expect(res.status).toBe(200);
    expect(andCollector.mock.calls.at(-1)).toHaveLength(2); // isActive + inArray
  });

  it('appends a notInArray condition for a blocklist policy', async () => {
    const app = makeApp({
      mode: 'app',
      keyId: 2,
      appId: 1,
      permissions: { modelPolicy: { mode: 'block', models: ['gpt-4o'] } },
    });
    const res = await app.request('/', { method: 'GET' });

    expect(res.status).toBe(200);
    expect(andCollector.mock.calls.at(-1)).toHaveLength(2); // isActive + notInArray
  });

  it('returns an empty list for an empty allowlist without querying', async () => {
    const app = makeApp({
      mode: 'user',
      keyId: 1,
      permissions: { modelPolicy: { mode: 'allow', models: [] } },
    });
    const res = await app.request('/', { method: 'GET' });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data).toHaveLength(0);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('treats mode "all" and malformed policies as unrestricted', async () => {
    const app = makeApp({
      mode: 'user',
      keyId: 1,
      permissions: { modelPolicy: { mode: 'all', models: [] } },
    });
    const res = await app.request('/', { method: 'GET' });

    expect(res.status).toBe(200);
    expect(andCollector.mock.calls.at(-1)).toHaveLength(1);
  });
});
