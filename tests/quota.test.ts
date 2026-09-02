import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  getDayStart,
  getMonthStart,
  getPrevMonthStart,
  extractMaxTokens,
  buildQuotaChecks,
  quotaTargetColumn,
  DEFAULT_MAX_TOKENS,
  sumTokensUsed,
  getUsageByModelForKey,
  getRateLimitConfig,
} from '../src/services/quota.js';
import type { AuthContext } from '../src/middleware/auth.js';

// ── DB + drizzle mocks for the query-building tests below ───────────────────
// `and` is replaced with an argument collector so the where() conditions can
// be counted; eq/gte/lt stay real so their output shape is unchanged.

const mockDb = vi.hoisted(() => {
  const db: any = {
    select: vi.fn(() => db.__select),
  };
  db.__select = {
    from: vi.fn(() => db.__from),
  };
  // where() returns a THENABLE builder (drizzle semantics): awaiting it
  // resolves the rows; getUsageByModelForKey chains .groupBy() on it and
  // getRateLimitConfig chains .limit() before awaiting.
  db.__whereResult = {
    groupBy: vi.fn(async () => db.__groupedRows ?? []),
    limit: vi.fn(async () => db.__limitRows ?? []),
    then: (resolve: any, reject: any) =>
      Promise.resolve([{ total: '42' }]).then(resolve, reject),
  };
  db.__from = {
    where: vi.fn(() => db.__whereResult),
  };
  return db;
});

vi.mock('../src/db/index.js', () => ({ getDb: vi.fn(() => mockDb) }));

const andCollector = vi.hoisted(() => vi.fn((...args: unknown[]) => ({ __and: args })));
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, and: andCollector };
});

// Config-cache primitives are mocked so the tests observe getRateLimitConfig's
// cache decisions directly (hit → no DB query, miss → DB + write-back).
const cfgCache = vi.hoisted(() => ({
  get: vi.fn(async (): Promise<unknown> => undefined),
  set: vi.fn(async () => {}),
}));
vi.mock('../src/services/quota-cache.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getRateLimitConfigCache: cfgCache.get,
    setRateLimitConfigCache: cfgCache.set,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getDayStart', () => {
  it('returns start of today in Beijing time (UTC+8)', () => {
    // 2026-05-29 15:30 UTC = 2026-05-29 23:30 Beijing → day starts at 2026-05-29 00:00 Beijing
    vi.setSystemTime(new Date('2026-05-29T15:30:00Z'));
    const result = getDayStart();
    expect(result.toISOString()).toBe('2026-05-28T16:00:00.000Z');
  });

  it('aligns to the Beijing day boundary across UTC midnight', () => {
    // 2026-05-31 16:30 UTC = 2026-06-01 00:30 Beijing → day starts at 2026-06-01 00:00 Beijing
    vi.setSystemTime(new Date('2026-05-31T16:30:00Z'));
    const result = getDayStart();
    expect(result.toISOString()).toBe('2026-05-31T16:00:00.000Z');
  });
});

describe('getMonthStart', () => {
  it('returns start of current month in Beijing time (UTC+8)', () => {
    // 2026-05-29 15:30 UTC = 2026-05-29 23:30 Beijing → month starts at 2026-05-01 00:00 Beijing
    vi.setSystemTime(new Date('2026-05-29T15:30:00Z'));
    const result = getMonthStart();
    expect(result.toISOString()).toBe('2026-04-30T16:00:00.000Z');
  });

  it('handles January correctly (rolls back into December UTC)', () => {
    // 2026-01-15 10:00 UTC = 2026-01-15 18:00 Beijing → month starts at 2026-01-01 00:00 Beijing
    vi.setSystemTime(new Date('2026-01-15T10:00:00Z'));
    const result = getMonthStart();
    expect(result.toISOString()).toBe('2025-12-31T16:00:00.000Z');
  });
});

describe('getPrevMonthStart', () => {
  it('returns start of the previous month in Beijing time (UTC+8)', () => {
    // 2026-05-29 15:30 UTC = 2026-05-29 23:30 Beijing → prev month starts at 2026-04-01 00:00 Beijing
    vi.setSystemTime(new Date('2026-05-29T15:30:00Z'));
    const result = getPrevMonthStart();
    expect(result.toISOString()).toBe('2026-03-31T16:00:00.000Z');
  });

  it('handles January correctly (rolls back into December of the prior year)', () => {
    // 2026-01-15 10:00 UTC = 2026-01-15 18:00 Beijing → prev month starts at 2025-12-01 00:00 Beijing
    vi.setSystemTime(new Date('2026-01-15T10:00:00Z'));
    const result = getPrevMonthStart();
    expect(result.toISOString()).toBe('2025-11-30T16:00:00.000Z');
  });
});

describe('extractMaxTokens', () => {
  it('extracts max_tokens from OpenAI body', () => {
    expect(extractMaxTokens({ max_tokens: 2000 }, '/openai/v1/chat/completions')).toBe(2000);
  });

  it('extracts max_tokens from Anthropic body', () => {
    expect(extractMaxTokens({ max_tokens: 4096 }, '/anthropic/v1/messages')).toBe(4096);
  });

  it('returns default when max_tokens is missing', () => {
    expect(extractMaxTokens({}, '/openai/v1/chat/completions')).toBe(DEFAULT_MAX_TOKENS);
  });

  it('returns default when body is null', () => {
    expect(extractMaxTokens(null, '/openai/v1/chat/completions')).toBe(DEFAULT_MAX_TOKENS);
  });

  it('returns default when max_tokens is zero', () => {
    expect(extractMaxTokens({ max_tokens: 0 }, '/openai/v1/chat/completions')).toBe(DEFAULT_MAX_TOKENS);
  });

  it('returns default when max_tokens is negative', () => {
    expect(extractMaxTokens({ max_tokens: -1 }, '/openai/v1/chat/completions')).toBe(DEFAULT_MAX_TOKENS);
  });

  // Responses API declares the output cap as max_output_tokens; CC o-series
  // uses max_completion_tokens. Both previously fell through to the flat
  // DEFAULT_MAX_TOKENS estimate even when the client declared a real cap.
  it('extracts max_output_tokens from Responses body', () => {
    expect(extractMaxTokens({ max_output_tokens: 8000 }, '/openai/v1/responses')).toBe(8000);
  });

  it('extracts max_completion_tokens from CC o-series body', () => {
    expect(extractMaxTokens({ max_completion_tokens: 65536 }, '/openai/v1/chat/completions')).toBe(65536);
  });

  it('prefers max_tokens over the newer field names', () => {
    expect(
      extractMaxTokens({ max_tokens: 1000, max_output_tokens: 8000 }, '/openai/v1/responses')
    ).toBe(1000);
  });

  it('falls through to max_output_tokens when max_tokens is invalid', () => {
    expect(
      extractMaxTokens({ max_tokens: 0, max_output_tokens: 3000 }, '/openai/v1/responses')
    ).toBe(3000);
  });
});

describe('buildQuotaChecks', () => {
  it('returns only api_key when no app/user', () => {
    const auth: AuthContext = { mode: 'user', keyId: 1 };
    expect(buildQuotaChecks(auth)).toEqual([{ type: 'api_key', id: 1 }]);
  });

  it('returns app + user + api_key in order', () => {
    const auth: AuthContext = { mode: 'app', keyId: 3, appId: 1, userId: 2 };
    expect(buildQuotaChecks(auth)).toEqual([
      { type: 'app', id: 1 },
      { type: 'user', id: 2 },
      { type: 'api_key', id: 3 },
    ]);
  });

  it('returns user + api_key when no app', () => {
    const auth: AuthContext = { mode: 'user', keyId: 2, userId: 1 };
    expect(buildQuotaChecks(auth)).toEqual([
      { type: 'user', id: 1 },
      { type: 'api_key', id: 2 },
    ]);
  });

  it('returns app + api_key when no user', () => {
    const auth: AuthContext = { mode: 'app', keyId: 2, appId: 1 };
    expect(buildQuotaChecks(auth)).toEqual([
      { type: 'app', id: 1 },
      { type: 'api_key', id: 2 },
    ]);
  });
});

describe('quotaTargetColumn', () => {
  it('returns correct column names', () => {
    expect(quotaTargetColumn('api_key')).toBe('apiKeyId');
    expect(quotaTargetColumn('user')).toBe('userId');
    expect(quotaTargetColumn('app')).toBe('appId');
  });
});

describe('sumTokensUsed - model scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds target + time conditions without model', async () => {
    await sumTokensUsed({ type: 'api_key', id: 1 }, new Date('2026-09-01T00:00:00Z'));
    const conditions = andCollector.mock.calls.at(-1) as unknown[];
    expect(conditions).toHaveLength(2);
  });

  it('appends a model condition when model is passed', async () => {
    await sumTokensUsed({ type: 'api_key', id: 1 }, new Date('2026-09-01T00:00:00Z'), undefined, 'gpt-4o');
    const conditions = andCollector.mock.calls.at(-1) as unknown[];
    expect(conditions).toHaveLength(3);
  });

  it('combines until + model conditions', async () => {
    await sumTokensUsed(
      { type: 'api_key', id: 1 },
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-09-02T00:00:00Z'),
      'gpt-4o',
    );
    const conditions = andCollector.mock.calls.at(-1) as unknown[];
    expect(conditions).toHaveLength(4);
  });

  it('coerces the mysql2 DECIMAL string result to a number', async () => {
    const result = await sumTokensUsed({ type: 'api_key', id: 1 }, new Date(), undefined, 'gpt-4o');
    expect(result).toBe(42);
    expect(typeof result).toBe('number');
  });
});

describe('getUsageByModelForKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('groups by model and coerces DECIMAL strings to numbers', async () => {
    // mysql2 returns SUM() results as DECIMAL strings — the Number() wraps are
    // the guard against "123" leaking to the API as a string.
    mockDb.__groupedRows = [
      { model: 'gpt-4o', todayTokens: '1234', monthTokens: '56789' },
      { model: 'qwen-max', todayTokens: '0', monthTokens: '42' },
    ];

    const rows = await getUsageByModelForKey(7);

    expect(mockDb.select).toHaveBeenCalled();
    expect(mockDb.__whereResult.groupBy).toHaveBeenCalled();
    expect(rows).toEqual([
      { model: 'gpt-4o', todayTokens: 1234, monthTokens: 56789 },
      { model: 'qwen-max', todayTokens: 0, monthTokens: 42 },
    ]);
  });
});

describe('getRateLimitConfig - Redis config cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.__limitRows = [];
  });

  it('queries the DB on miss and writes the row back to the cache', async () => {
    mockDb.__limitRows = [{
      id: 1,
      targetType: 'api_key',
      targetId: 42,
      rpm: 60,
      qps: 10,
      dailyTokens: 1000,
      monthlyTokens: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }];

    const row = await getRateLimitConfig('api_key', 42);

    expect(mockDb.select).toHaveBeenCalledTimes(1);
    // Cached shape drops the timestamp columns (Date doesn't round-trip JSON)
    expect(row).toEqual({
      id: 1, targetType: 'api_key', targetId: 42,
      rpm: 60, qps: 10, dailyTokens: 1000, monthlyTokens: null,
    });
    expect(cfgCache.set).toHaveBeenCalledWith(
      'ratelimit:cfg:api_key:42',
      expect.objectContaining({ dailyTokens: 1000 }),
    );
  });

  it('serves from the cache without touching the DB on hit', async () => {
    cfgCache.get.mockResolvedValue({
      id: 1, targetType: 'api_key', targetId: 42,
      rpm: 60, qps: 10, dailyTokens: 1000, monthlyTokens: null,
    });

    const row = await getRateLimitConfig('api_key', 42);

    expect(mockDb.select).not.toHaveBeenCalled();
    expect(cfgCache.set).not.toHaveBeenCalled();
    expect(row?.dailyTokens).toBe(1000);
  });

  it('caches "no config" as null so absent targets skip the DB too', async () => {
    cfgCache.get.mockResolvedValue(null);

    const row = await getRateLimitConfig('user', 7);

    expect(mockDb.select).not.toHaveBeenCalled();
    expect(row).toBeNull();
  });
});
