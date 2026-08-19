import { describe, it, expect } from 'vitest';
import type { Context } from 'hono';
import { getClientIp, captureRawRequestHeaders } from '../src/middleware/request-log.js';

// Build a minimal fake Hono Context with just the surface getClientIp reads.
function makeCtx(
  headers: Record<string, string>,
  incoming?: unknown,
): Context {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  // req.raw.headers.entries() 模拟 WHATWG Headers(小写),供 captureRawRequestHeaders
  // 的 fallback 分支读取。getClientIp 不读 raw,扩展向后兼容。
  const entries = Object.entries(lower);
  return {
    req: {
      header: (name: string) => lower[name.toLowerCase()] ?? undefined,
      raw: { headers: { entries: () => entries } },
    },
    env: incoming === undefined ? {} : { incoming },
  } as unknown as Context;
}

describe('getClientIp', () => {
  it('prefers the first IP in X-Forwarded-For (multi-hop proxy chain)', () => {
    const c = makeCtx(
      { 'x-forwarded-for': '203.0.113.5, 10.0.0.1, 10.0.0.2' },
      { socket: { remoteAddress: '127.0.0.1' } },
    );
    expect(getClientIp(c)).toBe('203.0.113.5');
  });

  it('falls back to X-Real-IP when X-Forwarded-For is absent', () => {
    const c = makeCtx(
      { 'x-real-ip': '198.51.100.7' },
      { socket: { remoteAddress: '127.0.0.1' } },
    );
    expect(getClientIp(c)).toBe('198.51.100.7');
  });

  it('falls back to socket remoteAddress when no proxy headers are present', () => {
    const c = makeCtx({}, { socket: { remoteAddress: '192.0.2.9' } });
    expect(getClientIp(c)).toBe('192.0.2.9');
  });

  it('returns null when nothing is available', () => {
    const c = makeCtx({});
    expect(getClientIp(c)).toBeNull();
  });

  it('skips an empty/whitespace X-Forwarded-For and falls through', () => {
    const c = makeCtx(
      { 'x-forwarded-for': ' , ' },
      { socket: { remoteAddress: '192.0.2.9' } },
    );
    expect(getClientIp(c)).toBe('192.0.2.9');
  });

  // Regression: the old inline ternary returned the socket IP whenever
  // c.env.incoming existed, so this case used to log '127.0.0.1'.
  it('does NOT prefer socket IP over X-Forwarded-For (regression)', () => {
    const c = makeCtx(
      { 'x-forwarded-for': '203.0.113.5' },
      { socket: { remoteAddress: '127.0.0.1' } },
    );
    expect(getClientIp(c)).toBe('203.0.113.5');
  });
});

describe('captureRawRequestHeaders', () => {
  it('保留客户端原始 header 大小写(读 IncomingMessage.rawHeaders,非 WHATWG 小写)', () => {
    const c = makeCtx({}, {
      rawHeaders: ['Content-Type', 'application/json', 'X-App-User-Id', 'u1', 'anthropic-version', '2023-06-01'],
    });
    expect(captureRawRequestHeaders(c)).toEqual({
      'Content-Type': 'application/json',
      'X-App-User-Id': 'u1',
      'anthropic-version': '2023-06-01',
    });
  });

  it('同名 header 用 ", " 合并(对齐 WHATWG Headers 的 append 语义)', () => {
    const c = makeCtx({}, { rawHeaders: ['Accept', 'text/html', 'Accept', 'application/json'] });
    expect(captureRawRequestHeaders(c)).toEqual({ Accept: 'text/html, application/json' });
  });

  it('无 c.env.incoming.rawHeaders 时回退到小写化的 WHATWG Headers', () => {
    // 单测 app.request() 不注入 c.env.incoming → 走 fallback,行为同旧版(小写)。
    const c = makeCtx({ 'Content-Type': 'application/json', 'X-App-User-Id': 'u1' });
    expect(captureRawRequestHeaders(c)).toEqual({
      'content-type': 'application/json',
      'x-app-user-id': 'u1',
    });
  });
});
