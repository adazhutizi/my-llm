import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Proves the daily archive runs AT MOST ONCE per UTC day across: the immediate
// boot tick, repeated hourly ticks, pod restarts, and concurrent pods — AND that
// a crashed/failed run is recovered the SAME day. The previous "one lock held
// 24h, never released" design lost the whole day on any mid-run crash or thrown
// runLogArchive; the split into a short releasable execution lock + a
// success-only "done today" marker is what makes it recoverable. tick() is
// module-private, so we drive it through the real startLogArchiveCleanup() under
// fake timers and assert on runLogArchive / tryAcquireLock / Redis call counts.
//
// vi.resetModules() per test reloads log-archive.js so the module-level
// `lastRunDate` guard starts empty every time.

describe('log archive scheduler — at most one run per UTC day, crash-recoverable', () => {
  let startLogArchiveCleanup: () => void;
  let stopLogArchiveCleanup: () => void;
  let runLogArchiveMock: ReturnType<typeof vi.fn>;
  let tryAcquireLockMock: ReturnType<typeof vi.fn>;
  let releaseLockMock: ReturnType<typeof vi.fn>;
  let redisGetMock: ReturnType<typeof vi.fn>;
  let redisSetMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    runLogArchiveMock = vi.fn(async () => ({
      deleted: 0,
      scanned: 0,
      cleaned: 0,
      kept: 0,
    }));
    tryAcquireLockMock = vi.fn(async () => true); // default: we win the exec lock
    releaseLockMock = vi.fn(async () => {});
    redisGetMock = vi.fn(async () => null); // done marker absent by default
    redisSetMock = vi.fn(async () => 'OK');

    vi.resetModules();
    vi.doMock('../src/redis/lock.js', () => ({
      tryAcquireLock: tryAcquireLockMock,
      releaseLock: releaseLockMock,
    }));
    vi.doMock('../src/redis/index.js', () => ({
      podId: 'test-pod',
      getRedis: () => ({ get: redisGetMock, set: redisSetMock }),
    }));
    vi.doMock('../src/config/index.js', () => ({
      getConfig: () => ({
        log: {
          archive: {
            enabled: true,
            runHour: 3,
            retentionDays: 1,
            sessionTimeoutMin: 10080,
            batchSize: 5000,
            maxAgeDays: 30,
          },
        },
        redis: { keyPrefix: 'llmgw:' },
      }),
    }));
    vi.doMock('../src/db/repositories/logs.js', () => ({
      runLogArchive: runLogArchiveMock,
    }));
    vi.doMock('../src/utils/logger.js', () => ({
      getLogger: () => ({
        info: () => {},
        error: () => {},
        warn: () => {},
      }),
    }));

    const mod = await import('../src/services/log-archive.js');
    startLogArchiveCleanup = mod.startLogArchiveCleanup;
    stopLogArchiveCleanup = mod.stopLogArchiveCleanup;
  });

  afterEach(() => {
    stopLogArchiveCleanup();
    vi.useRealTimers();
  });

  it('runs only once across the boot tick + later hourly ticks (lastRunDate short-circuits)', async () => {
    vi.useFakeTimers({ now: new Date(Date.UTC(2026, 5, 23, 10, 0, 0)) }); // UTC 10:00, past runHour=3
    startLogArchiveCleanup(); // fires the immediate boot tick (runHour satisfied)
    await vi.advanceTimersByTimeAsync(0);
    expect(runLogArchiveMock).toHaveBeenCalledTimes(1);

    // Three more hourly ticks — all must short-circuit on lastRunDate.
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    expect(runLogArchiveMock).toHaveBeenCalledTimes(1);
    // lastRunDate short-circuits BEFORE the Redis done-check and the lock, so
    // neither is re-hit after the first successful run.
    expect(redisGetMock).toHaveBeenCalledTimes(1);
    expect(tryAcquireLockMock).toHaveBeenCalledTimes(1);
  });

  it('does not run when another pod holds the execution lock (SET NX rejects)', async () => {
    tryAcquireLockMock.mockResolvedValue(false);
    vi.useFakeTimers({ now: new Date(Date.UTC(2026, 5, 23, 10, 0, 0)) });
    startLogArchiveCleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(runLogArchiveMock).not.toHaveBeenCalled();
  });

  it('does not run before runHour (UTC) even on the boot tick', async () => {
    vi.useFakeTimers({ now: new Date(Date.UTC(2026, 5, 23, 1, 0, 0)) }); // UTC 01:00 < runHour=3
    startLogArchiveCleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(runLogArchiveMock).not.toHaveBeenCalled();
  });

  it('skips when another pod already completed today (done marker, checked before the lock)', async () => {
    redisGetMock.mockResolvedValue('other-pod'); // done marker present
    vi.useFakeTimers({ now: new Date(Date.UTC(2026, 5, 23, 10, 0, 0)) });
    startLogArchiveCleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(runLogArchiveMock).not.toHaveBeenCalled();
    // The done-check precedes the lock, so we don't even contend for it.
    expect(tryAcquireLockMock).not.toHaveBeenCalled();
  });

  it('retries the same day when runLogArchive throws (no done marker / no lastRunDate on failure)', async () => {
    runLogArchiveMock.mockRejectedValue(new Error('boom'));
    vi.useFakeTimers({ now: new Date(Date.UTC(2026, 5, 23, 10, 0, 0)) });
    startLogArchiveCleanup();
    await vi.advanceTimersByTimeAsync(0); // boot tick: run throws
    expect(runLogArchiveMock).toHaveBeenCalledTimes(1);
    expect(redisSetMock).not.toHaveBeenCalled(); // no done marker written on failure
    expect(releaseLockMock).toHaveBeenCalledTimes(1); // exec lock still released in finally

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // next hourly tick
    expect(runLogArchiveMock).toHaveBeenCalledTimes(2); // retried same day
  });
});
