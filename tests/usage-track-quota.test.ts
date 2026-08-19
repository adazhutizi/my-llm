import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from '../src/middleware/auth.js';
import type { UsageData } from '../src/middleware/usage-track.js';

// Shared mock DB object — vi.hoisted ensures it exists before vi.mock factories run.
// getDb() must return the SAME object so assertions can inspect call history.
const mockDb = vi.hoisted(() => ({
  insert: vi.fn(() => ({
    values: vi.fn(() => ({
      onDuplicateKeyUpdate: vi.fn(async () => ({})),
    })),
  })),
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(async () => ({})),
    })),
  })),
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => []),
      })),
    })),
  })),
}));

// Mock trackUsage (DB write) — note: only intercepts external imports,
// the middleware's internal call goes through the real function + mocked getDb.
vi.mock('../src/middleware/usage-track.js', async () => {
  const actual = await vi.importActual<typeof import('../src/middleware/usage-track.js')>(
    '../src/middleware/usage-track.js'
  );
  return {
    ...actual,
    trackUsage: vi.fn(async () => {}),
  };
});

// Mock DB-dependent quota functions
vi.mock('../src/services/quota.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/quota.js')>(
    '../src/services/quota.js'
  );
  return {
    ...actual,
    // checkQuota is what usage-track's checkAndDisableIfQuotaExceeded actually
    // calls (cross-module import → vi.mock applies). Mocking sumTokensUsed /
    // getRateLimitConfig instead does NOT work: the real checkQuota calls them
    // via its own intra-module binding, which ignores the mocked exports, so
    // the disable branch never fired (getRateLimitConfig hit the mocked empty
    // DB and returned null → over:false unconditionally).
    checkQuota: vi.fn(async () => ({ over: false })),
    sumTokensUsed: vi.fn(async () => 0),
    getRateLimitConfig: vi.fn(async () => null),
  };
});

// Mock getDb — needs insert (trackUsage), update (disableTarget), select (getRateLimitConfig)
vi.mock('../src/db/index.js', () => ({
  getDb: vi.fn(() => mockDb),
}));

// Mock logger to avoid initialization requirement
vi.mock('../src/utils/logger.js', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  })),
  createLogger: vi.fn(),
}));

import { usageTrackMiddleware } from '../src/middleware/usage-track.js';
import { checkQuota } from '../src/services/quota.js';

beforeEach(() => {
  vi.clearAllMocks();
});

function makeApp(auth: AuthContext, usage: UsageData) {
  const app = new Hono();
  app.use('*', (c, next) => {
    c.set('auth', auth);
    c.set('usage', usage);
    return next();
  });
  app.use('*', usageTrackMiddleware);
  app.post('/test', (c) => c.json({ ok: true }));
  return app;
}

describe('usageTrackMiddleware - quota auto-disable', () => {
  it('does not disable when usage is within limits', async () => {
    vi.mocked(checkQuota).mockResolvedValue({ over: false });

    const auth: AuthContext = { mode: 'user', keyId: 1, userId: 10 };
    const usage: UsageData = {
      model: 'gpt-4',
      provider: 'openai',
      promptTokens: 100,
      completionTokens: 200,
      isError: false,
    };

    const app = makeApp(auth, usage);
    await app.request('/test', { method: 'POST' });

    // DB update should NOT have been called (no disable)
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('disables api_key when daily quota exceeded after response', async () => {
    // checkQuota reports the target is over its daily limit → the middleware
    // should call setTargetStatus, which writes via the mocked db.update.
    vi.mocked(checkQuota).mockResolvedValue({
      over: true,
      reason: 'daily token quota exceeded (used: 1200, limit: 1000)',
    });

    const auth: AuthContext = { mode: 'user', keyId: 1, userId: 10 };
    const usage: UsageData = {
      model: 'gpt-4',
      provider: 'openai',
      promptTokens: 100,
      completionTokens: 200,
      isError: false,
    };

    const app = makeApp(auth, usage);
    await app.request('/test', { method: 'POST' });

    // DB update should have been called (disable triggered)
    expect(mockDb.update).toHaveBeenCalled();
  });
});
