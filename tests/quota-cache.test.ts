import { describe, it, expect, vi, beforeEach } from 'vitest';

// quota-cache is now Redis-backed. We mock getRedis() with an in-memory fake
// that emulates the Lua semantics the real client uses: GET/SET with EX TTL,
// and quotaIncr = atomic increment-or-noop. vi.hoisted so the mock factory and
// the test body share one Map.
const fakeRedis = vi.hoisted(() => {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    store,
    get: vi.fn(async (key: string) => {
      const e = store.get(key);
      if (!e) return null;
      if (Date.now() > e.expiresAt) {
        store.delete(key);
        return null;
      }
      return e.value;
    }),
    set: vi.fn(async (key: string, val: string, _mode: string, ttlSec: number) => {
      store.set(key, { value: val, expiresAt: Date.now() + ttlSec * 1000 });
      return 'OK';
    }),
    // Emulates QUOTA_INCR_LUA: no-op if absent, else atomic daily+monthly increment.
    quotaIncr: vi.fn(async (key: string, tokens: number, ttlSec: number) => {
      const e = store.get(key);
      if (!e || Date.now() > e.expiresAt) {
        if (e) store.delete(key);
        return 0;
      }
      const obj = JSON.parse(e.value);
      obj.dailyUsed += tokens;
      obj.monthlyUsed += tokens;
      e.value = JSON.stringify(obj);
      e.expiresAt = Date.now() + ttlSec * 1000;
      return 1;
    }),
  };
});

vi.mock('../src/config/index.js', () => ({
  getConfig: () => ({ redis: { keyPrefix: 'llmgw:' } }),
}));

vi.mock('../src/redis/index.js', () => ({
  getRedis: () => fakeRedis,
}));

import {
  getQuotaCache,
  setQuotaCache,
  incrementQuotaCache,
} from '../src/services/quota-cache.js';

beforeEach(() => {
  fakeRedis.store.clear();
  fakeRedis.get.mockClear();
  fakeRedis.set.mockClear();
  fakeRedis.quotaIncr.mockClear();
});

describe('QuotaCache (Redis-backed)', () => {
  it('returns null on cache miss', async () => {
    expect(await getQuotaCache('quota:api_key:1')).toBeNull();
  });

  it('round-trips a cached entry', async () => {
    await setQuotaCache('quota:api_key:1', { dailyUsed: 100, monthlyUsed: 500 });
    const entry = await getQuotaCache('quota:api_key:1');
    expect(entry).not.toBeNull();
    expect(entry!.dailyUsed).toBe(100);
    expect(entry!.monthlyUsed).toBe(500);
  });

  it('increments an existing entry (daily + monthly)', async () => {
    await setQuotaCache('quota:api_key:1', { dailyUsed: 100, monthlyUsed: 500 });
    await incrementQuotaCache('quota:api_key:1', 50);
    const entry = await getQuotaCache('quota:api_key:1');
    expect(entry!.dailyUsed).toBe(150);
    expect(entry!.monthlyUsed).toBe(550);
  });

  it('increment is a no-op on cache miss (matches prior in-process semantics)', async () => {
    await incrementQuotaCache('quota:api_key:999', 50);
    expect(await getQuotaCache('quota:api_key:999')).toBeNull();
  });

  it('expires entries after CACHE_TTL_MS', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-29T10:00:00Z'));
    await setQuotaCache('quota:api_key:1', { dailyUsed: 100, monthlyUsed: 500 });
    // CACHE_TTL_MS = 5000
    vi.advanceTimersByTime(6_000);
    expect(await getQuotaCache('quota:api_key:1')).toBeNull();
    vi.useRealTimers();
  });

  it('shares state across getRedis() callers (the multi-pod win)', async () => {
    // Two logical pods both go through getRedis() → same fake → same store, so a
    // write/increment by one is visible to the other (the in-process Map was not).
    await setQuotaCache('quota:api_key:1', { dailyUsed: 100, monthlyUsed: 500 });
    await incrementQuotaCache('quota:api_key:1', 50);
    const entry = await getQuotaCache('quota:api_key:1');
    expect(entry!.dailyUsed).toBe(150);
  });
});
