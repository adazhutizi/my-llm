import { describe, it, expect, vi, beforeEach } from 'vitest';

// checkRateLimit reads the rate_limits row from the DB (drizzle chain) and
// consumes the Redis token bucket. Both are mocked here: the DB chain is a
// thenable-style builder whose limit() resolves configurable rows, and the
// Redis client records the bucket caps it was handed.
const fakeDb = vi.hoisted(() => {
  let rows: unknown[] = [];
  return {
    setRows: (r: unknown[]) => { rows = r; },
    select: vi.fn(() => fakeDb),
    from: vi.fn(() => fakeDb),
    where: vi.fn(() => fakeDb),
    limit: vi.fn(async () => rows),
  };
});

const fakeRedis = vi.hoisted(() => ({
  // 1 = allowed, 0 = throttled; default allow so tests isolate the DB-row logic
  rateLimit: vi.fn(async () => 1),
}));

vi.mock('../src/db/index.js', () => ({ getDb: () => fakeDb }));
vi.mock('../src/config/index.js', () => ({
  getConfig: () => ({ redis: { keyPrefix: 'llmgw:' } }),
}));
vi.mock('../src/redis/index.js', () => ({ getRedis: () => fakeRedis }));

import { checkRateLimit } from '../src/services/rate-limiter.js';

beforeEach(() => {
  fakeDb.setRows([]);
  fakeRedis.rateLimit.mockClear().mockResolvedValue(1);
});

describe('checkRateLimit', () => {
  it('does NOT limit the global bucket when no rate_limits row exists', async () => {
    // Regression guard: the global fallback previously applied the hardcoded
    // DEFAULT_QPS=10 / DEFAULT_RPM=60, silently throttling the entire gateway
    // on fresh deployments (seed creates no rate_limits rows). Global limiting
    // is opt-in — a targetType='global' row must be created explicitly.
    fakeDb.setRows([]);

    const allowed = await checkRateLimit('global', null);

    expect(allowed).toBe(true);
    expect(fakeRedis.rateLimit).not.toHaveBeenCalled();
  });

  it('applies the configured caps when a global row exists', async () => {
    fakeDb.setRows([
      { targetType: 'global', targetId: null, qps: 500, rpm: 30000 },
    ]);

    const allowed = await checkRateLimit('global', null);

    expect(allowed).toBe(true);
    expect(fakeRedis.rateLimit).toHaveBeenCalledWith(
      'llmgw:ratelimit:global:global:qps',
      'llmgw:ratelimit:global:global:rpm',
      expect.any(Number),
      500,
      500,
      30000,
      30000 / 60,
    );
  });

  it('keeps the per-target default (10 QPS / 60 RPM) when an api_key has no row', async () => {
    // Per-target defaults stay: they bound a single app/user/key, which is the
    // protective intent; only the gateway-wide default was spurious.
    fakeDb.setRows([]);

    const allowed = await checkRateLimit('api_key', 42);

    expect(allowed).toBe(true);
    expect(fakeRedis.rateLimit).toHaveBeenCalledWith(
      'llmgw:ratelimit:api_key:42:qps',
      'llmgw:ratelimit:api_key:42:rpm',
      expect.any(Number),
      10,
      10,
      60,
      1,
    );
  });

  it('propagates a throttled bucket (0) as false', async () => {
    fakeDb.setRows([{ targetType: 'api_key', targetId: 42, qps: 5, rpm: 30 }]);
    fakeRedis.rateLimit.mockResolvedValue(0);

    await expect(checkRateLimit('api_key', 42)).resolves.toBe(false);
  });

  it('fails open when Redis is unreachable', async () => {
    fakeDb.setRows([{ targetType: 'api_key', targetId: 42, qps: 5, rpm: 30 }]);
    fakeRedis.rateLimit.mockRejectedValue(new Error('connection lost'));

    await expect(checkRateLimit('api_key', 42)).resolves.toBe(true);
  });
});
