import { describe, it, expect, vi, beforeEach } from 'vitest';

// getUaPoliciesForRequest reads drizzle chains and Redis. Both mocked: DB as
// a thenable-style builder whose limit() resolves rows from a FIFO queue (one
// entry per point query, in target order), Redis as an in-memory store with
// real MGET/SET/DEL semantics so sentinel caching can be asserted.

const fakeDb = vi.hoisted(() => {
  const queue: unknown[][] = [];
  return {
    queue,
    setRows: (rows: unknown[]) => queue.push(rows),
    select: vi.fn(() => fakeDb),
    from: vi.fn(() => fakeDb),
    where: vi.fn(() => fakeDb),
    limit: vi.fn(async () => queue.shift() ?? []),
  };
});

const fakeRedis = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    mget: vi.fn(async (...keys: string[]) => keys.map((k) => (store.has(k) ? store.get(k)! : null))),
    get: vi.fn(async (key: string) => (store.has(key) ? store.get(key)! : null)),
    set: vi.fn(async (key: string, val: string) => {
      store.set(key, val);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
      return 1;
    }),
  };
});

vi.mock('../src/db/index.js', () => ({ getDb: () => fakeDb }));
vi.mock('../src/config/index.js', () => ({
  // log.level feeds the lazily-created pino logger (warn/error paths in
  // fail-open branches); 'silent' keeps test output clean.
  getConfig: () => ({ redis: { keyPrefix: 'llmgw:' }, log: { level: 'silent' } }),
}));
vi.mock('../src/redis/index.js', () => ({ getRedis: () => fakeRedis }));

import {
  parseUaPolicy,
  evaluateUaPolicies,
  compilePolicyRegexes,
  checkUaPatternSafety,
  getUaPoliciesForRequest,
  uaPolicyCacheKey,
} from '../src/services/ua-policy.js';

// evaluateUaPolicies levels shortcut
function L(type: 'global' | 'app' | 'user' | 'api_key', policy: unknown) {
  return { target: { type, id: type === 'global' ? null : 1 }, policy: policy as never };
}

beforeEach(() => {
  fakeDb.queue.length = 0;
  fakeRedis.store.clear();
  fakeDb.select.mockClear();
  fakeRedis.mget.mockClear();
});

describe('parseUaPolicy (fail-open)', () => {
  it('returns null for absent/malformed values instead of throwing', () => {
    expect(parseUaPolicy(null)).toBeNull();
    expect(parseUaPolicy(undefined)).toBeNull();
    expect(parseUaPolicy('block')).toBeNull();
    expect(parseUaPolicy({ mode: 'nope', patterns: ['a'] })).toBeNull();
    expect(parseUaPolicy({ mode: 'block', patterns: 'nope' })).toBeNull();
    expect(parseUaPolicy({ mode: 'block', patterns: [''] })).toBeNull(); // min(1)
  });

  it('parses a valid policy (extra keys tolerated by zod strip)', () => {
    expect(parseUaPolicy({ mode: 'allow', patterns: ['^my-app', 'curl'] })).toEqual({
      mode: 'allow',
      patterns: ['^my-app', 'curl'],
    });
  });
});

describe('evaluateUaPolicies (stacked semantics table)', () => {
  it('allows when no level has a policy', () => {
    expect(evaluateUaPolicies([L('global', null), L('api_key', null)], 'curl/8.0').allowed).toBe(true);
  });

  it('block: a match at ANY level denies, no match is neutral', () => {
    expect(evaluateUaPolicies([L('global', { mode: 'block', patterns: ['^curl'] })], 'curl/8.0'))
      .toEqual({ allowed: false, reason: { level: 'global', mode: 'block', pattern: '^curl' } });
    expect(evaluateUaPolicies([L('global', { mode: 'block', patterns: ['^curl'] })], 'my-app/1.0').allowed).toBe(true);
  });

  it('allow: a configured level requires a match (no match → deny)', () => {
    expect(evaluateUaPolicies([L('global', { mode: 'allow', patterns: ['^my-app'] })], 'my-app/1.0').allowed).toBe(true);
    expect(evaluateUaPolicies([L('global', { mode: 'allow', patterns: ['^my-app'] })], 'curl/8.0'))
      .toEqual({ allowed: false, reason: { level: 'global', mode: 'allow' } });
  });

  it('empty patterns: block = neutral, allow = deny everything', () => {
    // allow+empty is rejected on PUT; reachable only via direct DB edits.
    expect(evaluateUaPolicies([L('api_key', { mode: 'block', patterns: [] })], 'x').allowed).toBe(true);
    expect(evaluateUaPolicies([L('api_key', { mode: 'allow', patterns: [] })], 'x'))
      .toEqual({ allowed: false, reason: { level: 'api_key', mode: 'allow' } });
  });

  it('stacks: global allow + key block coexist (deny wins, allow only tightens)', () => {
    const levels = [
      L('global', { mode: 'allow', patterns: ['^(my-app|curl)'] }),
      L('api_key', { mode: 'block', patterns: ['^curl'] }),
    ];
    // curl passes the global allow but hits the key block → denied
    expect(evaluateUaPolicies(levels, 'curl/8.0'))
      .toEqual({ allowed: false, reason: { level: 'api_key', mode: 'block', pattern: '^curl' } });
    // my-app passes both
    expect(evaluateUaPolicies(levels, 'my-app/1.0').allowed).toBe(true);
  });

  it('stacks: two allow levels both must match', () => {
    const levels = [
      L('user', { mode: 'allow', patterns: ['^my-app'] }),
      L('api_key', { mode: 'allow', patterns: ['/v2$'] }),
    ];
    expect(evaluateUaPolicies(levels, 'my-app/1.0/v2').allowed).toBe(true);
    expect(evaluateUaPolicies(levels, 'my-app/1.0').allowed).toBe(false); // fails key allow
    expect(evaluateUaPolicies(levels, 'other/1.0/v2').allowed).toBe(false); // fails user allow
  });

  it('matches case-insensitively (i flag)', () => {
    expect(evaluateUaPolicies([L('global', { mode: 'block', patterns: ['python-requests'] })], 'Python-Requests/2.31').allowed).toBe(false);
  });

  it('treats a missing UA as empty string (^$ can target it)', () => {
    expect(evaluateUaPolicies([L('global', { mode: 'block', patterns: ['^$'] })], '').allowed).toBe(false);
    expect(evaluateUaPolicies([L('global', { mode: 'block', patterns: ['^$'] })], 'curl/8.0').allowed).toBe(true);
  });
});

describe('compilePolicyRegexes', () => {
  it('compiles once and reuses the cached array for identical patterns', () => {
    const a = compilePolicyRegexes(['^a', 'b$']);
    const b = compilePolicyRegexes(['^a', 'b$']);
    expect(a).toBe(b); // same array object → cache hit
  });

  it('skips uncompilable patterns instead of throwing (fail-open)', () => {
    const compiled = compilePolicyRegexes(['ok-pattern', '(unclosed']);
    expect(compiled).toHaveLength(1);
  });

  it('distinct pattern arrays joined with NUL never collide', () => {
    // ['a b','c'] vs ['a','b c'] must be different cache entries.
    const x = compilePolicyRegexes(['a b', 'c']);
    const y = compilePolicyRegexes(['a', 'b c']);
    expect(x).not.toBe(y);
  });
});

describe('checkUaPatternSafety (ReDoS guard)', () => {
  it('accepts ordinary patterns', () => {
    expect(checkUaPatternSafety('^(curl|wget)/[\\d.]+')).toBeNull();
    expect(checkUaPatternSafety('python-requests')).toBeNull();
    expect(checkUaPatternSafety('(abc)+')).toBeNull();
  });

  it('rejects syntax errors, empty strings, oversize patterns', () => {
    expect(checkUaPatternSafety('(unclosed')).toMatch(/语法错误/);
    expect(checkUaPatternSafety('')).toMatch(/空字符串/);
    expect(checkUaPatternSafety('a'.repeat(513))).toMatch(/超过上限/);
  });

  it('rejects nested quantifiers ((a+)+ class)', () => {
    expect(checkUaPatternSafety('(a+)+')).toMatch(/嵌套量词/);
    expect(checkUaPatternSafety('(ab*)+')).toMatch(/嵌套量词/);
    expect(checkUaPatternSafety('(?:x+){2,}')).toMatch(/嵌套量词/);
  });

  it('allows quantified groups whose body has no quantifier', () => {
    expect(checkUaPatternSafety('^(curl|wget)/')).toBeNull();
  });

  it('rejects excessive group depth and quantifier counts', () => {
    expect(checkUaPatternSafety('('.repeat(11) + 'a' + ')'.repeat(11))).toMatch(/嵌套深度/);
    expect(checkUaPatternSafety('a*'.repeat(33))).toMatch(/量词数量/);
  });

  it('does not count character-class internals as groups/quantifiers', () => {
    // [+*(] inside a class must not trip the nested-quantifier heuristic.
    expect(checkUaPatternSafety('x[+*(]{1,3}y')).toBeNull();
  });
});

describe('getUaPoliciesForRequest (cache + fail-open)', () => {
  it('returns all-null on a cold cache with no DB rows AND caches the null sentinels', async () => {
    const result = await getUaPoliciesForRequest([
      { type: 'global', id: null },
      { type: 'api_key', id: 7 },
    ]);
    expect(result).toEqual([null, null]);
    // Both absences are now cached → a second call must not hit the DB.
    const selectCalls = fakeDb.select.mock.calls.length;
    const result2 = await getUaPoliciesForRequest([
      { type: 'global', id: null },
      { type: 'api_key', id: 7 },
    ]);
    expect(result2).toEqual([null, null]);
    expect(fakeDb.select.mock.calls.length).toBe(selectCalls);
  });

  it('reads a cached policy without touching the DB (one MGET)', async () => {
    fakeRedis.store.set(
      `llmgw:${uaPolicyCacheKey('global', null)}`,
      JSON.stringify({ mode: 'block', patterns: ['^curl'] }),
    );
    const before = fakeDb.select.mock.calls.length;
    const result = await getUaPoliciesForRequest([{ type: 'global', id: null }]);
    expect(result).toEqual([{ mode: 'block', patterns: ['^curl'] }]);
    expect(fakeDb.select.mock.calls.length).toBe(before);
    expect(fakeRedis.mget).toHaveBeenCalledTimes(1);
  });

  it('backfills DB rows into the cache including the null sentinel', async () => {
    // Two targets: first has a row, second has none.
    fakeDb.queue.push([{ mode: 'block', patterns: ['^curl'] }]);
    fakeDb.queue.push([]);

    const result = await getUaPoliciesForRequest([
      { type: 'global', id: null },
      { type: 'api_key', id: 7 },
    ]);

    expect(result).toEqual([
      { mode: 'block', patterns: ['^curl'] },
      null,
    ]);
    expect(fakeRedis.store.get(`llmgw:${uaPolicyCacheKey('global', null)}`))
      .toBe(JSON.stringify({ mode: 'block', patterns: ['^curl'] }));
    expect(fakeRedis.store.get(`llmgw:${uaPolicyCacheKey('api_key', 7)}`)).toBe('null');
  });

  it('DB errors degrade to "no policy" instead of throwing', async () => {
    fakeDb.limit.mockRejectedValueOnce(new Error('db down'));
    const result = await getUaPoliciesForRequest([{ type: 'global', id: null }]);
    expect(result).toEqual([null]);
  });

  it('Redis MGET failure falls back to the DB (fail-open)', async () => {
    fakeRedis.mget.mockRejectedValueOnce(new Error('redis down'));
    fakeDb.queue.push([{ mode: 'block', patterns: ['^curl'] }]);

    const result = await getUaPoliciesForRequest([{ type: 'global', id: null }]);
    expect(result).toEqual([{ mode: 'block', patterns: ['^curl'] }]);
  });
});
