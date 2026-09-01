import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Pins the 2026-09 fix: the embeddings / images passthrough routes must set
// usage (isError=true) on upstream >=400, mirroring the three chat routes'
// 2026-08 fix. Without it requestLogMiddleware's `if (!usage) return` skips
// persistence and the upstream 429/401 vanishes from /logs entirely.
vi.mock('../src/services/model-router.js', () => ({
  resolveModel: vi.fn(async () => ({ provider: 'openai-main', realModel: 'text-embedding-3-real' })),
  getProviderConfig: vi.fn(async () => ({
    baseUrl: 'https://upstream.example.com/v1',
    apiKey: 'sk-upstream',
    apiType: 'openai',
    estimateFallback: false,
  })),
  createProvider: vi.fn(),
}));

import { embeddings } from '../src/routes/openai/embeddings.js';
import { imageGenerations } from '../src/routes/openai/images-generations.js';
import { createProvider } from '../src/services/model-router.js';

// getLogger 需先 createLogger() 初始化全局单例;mock 成 no-op(项目测试惯例,
// 见 passthrough.test.ts)。路由 ≥400 分支现会经 logUpstreamError 打控制台日志。
vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  }),
}));

const mockedCreateProvider = vi.mocked(createProvider);

beforeEach(() => {
  vi.clearAllMocks();
});

interface CapturedUsage {
  model?: string;
  provider?: string;
  promptTokens?: number;
  completionTokens?: number;
  isError?: boolean;
}

function makeApp(captured: CapturedUsage[]) {
  const app = new Hono();
  // Post-response capture: reads what the route set via c.set('usage') — the
  // exact signal requestLogMiddleware branches on.
  app.use('*', async (c, next) => {
    await next();
    const usage = c.get('usage') as CapturedUsage | undefined;
    if (usage) captured.push(usage);
  });
  app.route('/openai/v1/embeddings', embeddings);
  app.route('/openai/v1/images/generations', imageGenerations);
  return app;
}

describe('embeddings + images upstream error logging', () => {
  it('marks usage isError=true on upstream 429 so the request log persists', async () => {
    mockedCreateProvider.mockReturnValue({
      send: vi.fn(async () => ({
        status: 429,
        headers: {},
        body: { error: { message: 'Rate limit reached', type: 'rate_limit_error' } },
      })),
    } as never);

    const captured: CapturedUsage[] = [];
    const app = makeApp(captured);

    const res = await app.request('/openai/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-virt', input: 'hello' }),
    });

    expect(res.status).toBe(429);
    // Without c.set('usage', …isError) the row silently disappears from /logs.
    expect(captured).toEqual([
      {
        model: 'text-embedding-virt',
        provider: 'openai-main',
        promptTokens: 0,
        completionTokens: 0,
        isError: true,
      },
    ]);
  });

  it('propagates upstream 429 verbatim (5xx would become 502)', async () => {
    mockedCreateProvider.mockReturnValue({
      send: vi.fn(async () => ({ status: 500, headers: {}, body: { error: 'boom' } })),
    } as never);

    const captured: CapturedUsage[] = [];
    const app = makeApp(captured);

    const res = await app.request('/openai/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'dall-e-virt', prompt: 'a cat' }),
    });

    expect(res.status).toBe(502);
    expect(captured[0]?.isError).toBe(true);
  });

  it('still records normal usage (isError=false) on success', async () => {
    mockedCreateProvider.mockReturnValue({
      send: vi.fn(async () => ({
        status: 200,
        headers: {},
        body: { data: [{ embedding: [0.1] }], usage: { prompt_tokens: 3, total_tokens: 3 } },
      })),
    } as never);

    const captured: CapturedUsage[] = [];
    const app = makeApp(captured);

    const res = await app.request('/openai/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-virt', input: 'hello' }),
    });

    expect(res.status).toBe(200);
    expect(captured[0]).toMatchObject({ promptTokens: 3, isError: false });
  });
});
