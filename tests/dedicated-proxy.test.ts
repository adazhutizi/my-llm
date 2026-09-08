import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from '../src/middleware/auth.js';
import { dedicatedProxyMiddleware } from '../src/middleware/dedicated-proxy.js';

// dedicated-proxy 在流式 finally 里直接调 trackUsage / persistRequestLog(不经
// 中间件),mock 掉以免触碰 DB。logger mock 同 passthrough.test.ts(避免 pino +
// getConfig 初始化副作用)。
vi.mock('../src/middleware/usage-track.js', () => ({ trackUsage: vi.fn() }));
vi.mock('../src/middleware/request-log.js', () => ({ persistRequestLog: vi.fn() }));
vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  }),
}));

const fetchMock = vi.fn();

/** 装一个最小 Hono app:预置 dedicated AuthContext,处理交 dedicatedProxyMiddleware。 */
function buildApp(auth: Partial<AuthContext>) {
  const app = new Hono();
  app.use('*', (c, next) => {
    c.set('auth', { mode: 'dedicated', keyId: 1, ...auth } as AuthContext);
    c.set('requestId', 'req-test-1');
    return next();
  });
  app.use('*', dedicatedProxyMiddleware);
  app.all('/*', (c) => c.json({ error: 'unreachable' }, 500));
  return app;
}

const dedicatedAuth: Partial<AuthContext> = {
  mode: 'dedicated',
  keyId: 1,
  providerBaseUrl: 'https://api.example.com/v1',
  upstreamApiKey: 'sk-real',
  providerName: 'example',
  providerEstimateFallback: false,
};

describe('dedicatedProxyMiddleware (一对一透传)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('流式响应 content-type 透传上游原值(charset 变体),其余上游头不透传', async () => {
    // 回归:stream() 裸调 c.newResponse 不带任何头,流式响应曾完全没有 content-type
    // (上游的 text/event-stream 只进了日志的 responseHeaders,没到客户端)。修复:
    // 单透传上游 content-type 原值,charset 变体原样保留;其余上游头(content-encoding
    // 已被 fetch 自动解压 / 上游 x-request-id 与网关回显双 id)刻意不透传。
    const sseBody = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n';
    fetchMock.mockResolvedValue(
      new Response(sseBody, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream;charset=UTF-8',
          'content-encoding': 'gzip',
          'x-request-id': 'upstream-req-999',
        },
      }),
    );

    const app = buildApp(dedicatedAuth);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ded_sk_x' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    await res.text();

    // 上游 URL = providerBaseUrl 的 origin + 客户端原始 path
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/chat/completions');

    // 上游原值原样透传(含无空格 charset 变体)
    expect(res.headers.get('content-type')).toBe('text/event-stream;charset=UTF-8');
    // 其余上游头不透传
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('x-request-id')).toBeNull();
  });

  it('非流式响应透传上游 content-type(application/json 原样)', async () => {
    fetchMock.mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const app = buildApp(dedicatedAuth);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ded_sk_x' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.status).toBe(200);
  });

  it('非 dedicated 密钥 no-op(直接 next)', async () => {
    const app = buildApp({ mode: 'app' } as Partial<AuthContext>);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o' }),
    });
    // 落到兜底路由 = middleware no-op 放行
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
  });
});
