import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory fake of the Redis commands the lock helpers use: SET ... NX, GET,
// and the releaseLock Lua (compare-value-then-DEL). vi.hoisted so the mock
// factory and tests share one Map.
const fakeRedis = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    set: vi.fn(
      async (key: string, value: string, _ex?: string, _ttl?: number, nx?: string) => {
        if (nx === 'NX') {
          if (store.has(key)) return null;
          store.set(key, value);
          return 'OK';
        }
        store.set(key, value);
        return 'OK';
      },
    ),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    // Emulates RELEASE_LOCK_LUA: delete only if the stored value matches.
    releaseLock: vi.fn(async (key: string, value: string) => {
      if (store.get(key) === value) {
        store.delete(key);
        return 1;
      }
      return 0;
    }),
  };
});

vi.mock('../src/redis/index.js', () => ({
  getRedis: () => fakeRedis,
}));

import { tryAcquireLock, releaseLock, waitForLockRelease } from '../src/redis/lock.js';

beforeEach(() => {
  fakeRedis.store.clear();
  fakeRedis.set.mockClear();
  fakeRedis.get.mockClear();
  fakeRedis.releaseLock.mockClear();
});

describe('distributed lock', () => {
  it('acquires an uncontended lock', async () => {
    expect(await tryAcquireLock('k', 'pod-a', 60)).toBe(true);
  });

  it('rejects a second acquirer while held', async () => {
    expect(await tryAcquireLock('k', 'pod-a', 60)).toBe(true);
    expect(await tryAcquireLock('k', 'pod-b', 60)).toBe(false);
  });

  it('release by the holder frees the lock for another pod', async () => {
    await tryAcquireLock('k', 'pod-a', 60);
    await releaseLock('k', 'pod-a');
    expect(await tryAcquireLock('k', 'pod-b', 60)).toBe(true);
  });

  it('release with the wrong value does NOT delete (prevents stealing an expired lock)', async () => {
    await tryAcquireLock('k', 'pod-a', 60);
    await releaseLock('k', 'pod-b'); // wrong holder — no-op
    expect(await tryAcquireLock('k', 'pod-c', 60)).toBe(false);
  });

  it('waitForLockRelease returns true once the lock disappears', async () => {
    vi.useFakeTimers();
    await tryAcquireLock('k', 'pod-a', 60);
    setTimeout(() => {
      fakeRedis.store.delete('k');
    }, 600);
    const p = waitForLockRelease('k', 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toBe(true);
    vi.useRealTimers();
  });

  it('waitForLockRelease returns false on timeout (lock never released)', async () => {
    vi.useFakeTimers();
    await tryAcquireLock('k', 'pod-a', 60); // held forever in this test
    const p = waitForLockRelease('k', 1_000);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await p).toBe(false);
    vi.useRealTimers();
  });

  it('waitForLockRelease returns false on Redis error (fail-open, does not crash)', async () => {
    // Redis goes away mid-poll: r.get() rejects. The fix returns false (same as
    // timeout) so the caller proceeds fail-open instead of rejecting up to
    // main().catch → exit(1).
    fakeRedis.get.mockRejectedValueOnce(new Error('connection lost'));
    expect(await waitForLockRelease('k', 5_000)).toBe(false);
  });
});
