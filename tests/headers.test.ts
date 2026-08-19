import { describe, it, expect } from 'vitest';
import type { Context } from 'hono';
import { rawHeaderPairs, detectCredentialName, buildUpstreamHeaders } from '../src/utils/headers.js';

// 这三个纯函数是 dedicated 透传与同族 passthrough「发上游 header 保留客户端原始大小写」
// 的核心。集成测试(app.request)不注入 c.env.incoming → 永远走 rawHeaderPairs 的回退
// 分支(小写),测不到生产分支的「保留原始大小写」;故该行为只能在此用 fake context
// + 纯函数直接验证。

function makeCtx(opts: { rawHeaders?: string[]; whatwg?: Array<[string, string]> } = {}): Context {
  return {
    env: opts.rawHeaders ? { incoming: { rawHeaders: opts.rawHeaders } } : {},
    req: { raw: { headers: { entries: () => opts.whatwg ?? [] } } },
  } as unknown as Context;
}

describe('rawHeaderPairs', () => {
  it('有 c.env.incoming.rawHeaders 时保留客户端原始大小写成对返回', () => {
    const c = makeCtx({ rawHeaders: ['Content-Type', 'application/json', 'X-App-User-Id', 'u1'] });
    expect(rawHeaderPairs(c)).toEqual([
      ['Content-Type', 'application/json'],
      ['X-App-User-Id', 'u1'],
    ]);
  });

  it('无 rawHeaders 时回退到 c.req.raw.headers.entries()(小写)', () => {
    const c = makeCtx({ whatwg: [['content-type', 'application/json']] });
    expect(rawHeaderPairs(c)).toEqual([['content-type', 'application/json']]);
  });
});

describe('detectCredentialName', () => {
  it('Authorization 与 x-api-key 同时存在时 Authorization 优先', () => {
    const pairs: Array<[string, string]> = [['x-api-key', 'k1'], ['Authorization', 'Bearer x']];
    expect(detectCredentialName(pairs)).toBe('Authorization');
  });

  it('仅 x-api-key 时返回其原样名', () => {
    expect(detectCredentialName([['X-Api-Key', 'k1']])).toBe('X-Api-Key');
  });

  it('保留客户端原样大小写(authorization 小写)', () => {
    expect(detectCredentialName([['authorization', 'Bearer x']])).toBe('authorization');
  });

  it('都没有时返回 null', () => {
    expect(detectCredentialName([['content-type', 'application/json']])).toBeNull();
  });
});

describe('buildUpstreamHeaders', () => {
  const STRIP = new Set(['x-forwarded-for', 'authorization', 'x-api-key', 'host', 'connection']);

  it('保留客户端原样 key 大小写', () => {
    const out = buildUpstreamHeaders(
      [['Content-Type', 'application/json'], ['X-App-User-Id', 'u1']],
      STRIP,
    );
    expect(out).toEqual({ 'Content-Type': 'application/json', 'X-App-User-Id': 'u1' });
  });

  it('stripNames 命中剥离(大小写不敏感)', () => {
    const out = buildUpstreamHeaders(
      [['X-Forwarded-For', '1.2.3.4'], ['Host', 'x'], ['Connection', 'keep-alive']],
      STRIP,
    );
    expect(out).toEqual({});
  });

  it('rewrites 命中只换值不改 key(Authorization 保留客户端大小写)', () => {
    const out = buildUpstreamHeaders(
      [['Authorization', 'Bearer ded_sk_xxx']],
      STRIP,
      { authorization: 'Bearer sk-real' },
    );
    // key 仍是客户端原样 'Authorization',值换成上游真实 key
    expect(out).toEqual({ Authorization: 'Bearer sk-real' });
  });

  it('rewrites 对 content-type 保留原样名换值', () => {
    const out = buildUpstreamHeaders(
      [['Content-Type', 'text/plain']],
      new Set(),
      { 'content-type': 'application/json' },
    );
    expect(out).toEqual({ 'Content-Type': 'application/json' });
  });

  it('未命中 rewrites 的原样保留', () => {
    const out = buildUpstreamHeaders([['Accept', '*/*']], new Set(), { authorization: 'Bearer x' });
    expect(out).toEqual({ Accept: '*/*' });
  });

  it('同名(原样 key 相同)重复按 ", " append', () => {
    const out = buildUpstreamHeaders([['Accept', 'a'], ['Accept', 'b']], new Set());
    expect(out).toEqual({ Accept: 'a, b' });
  });

  it('x-api-key 凭证保留原样名换值(bare,无 Bearer)', () => {
    const out = buildUpstreamHeaders(
      [['X-Api-Key', 'ded_sk_xxx']],
      STRIP,
      { 'x-api-key': 'sk-real' },
    );
    expect(out).toEqual({ 'X-Api-Key': 'sk-real' });
  });
});
