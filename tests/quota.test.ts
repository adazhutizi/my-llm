import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getDayStart,
  getMonthStart,
  getPrevMonthStart,
  extractMaxTokens,
  buildQuotaChecks,
  quotaTargetColumn,
  DEFAULT_MAX_TOKENS,
} from '../src/services/quota.js';
import type { AuthContext } from '../src/middleware/auth.js';

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
