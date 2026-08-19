import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from '../src/middleware/auth.js';
import type { UsageData } from '../src/middleware/usage-track.js';

// Shared mock DB — vi.hoisted so it exists before vi.mock factories run.
// persistRequestLog calls db.insert() twice (requestLogs + requestDetails),
// each followed by .values().onDuplicateKeyUpdate().
const mockDb = vi.hoisted(() => ({
  insert: vi.fn(() => ({
    values: vi.fn(() => ({
      onDuplicateKeyUpdate: vi.fn(async () => ({})),
    })),
  })),
}));

vi.mock('../src/db/index.js', () => ({
  getDb: vi.fn(() => mockDb),
}));

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

import { requestLogMiddleware } from '../src/middleware/request-log.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// Drive the middleware with a real Hono app. The setup handler seeds whatever
// context a given route would have left behind: `usage` is set by non-streaming
// handlers (and by dedicated-proxy's non-streaming branch on upstream errors),
// while streaming handlers deliberately leave it unset (their stream callback
// persists the log itself). The route returns a 429 to mirror the dedicated
// regression scenario.
function makeApp(auth: AuthContext, usage: UsageData | undefined) {
  const app = new Hono();
  app.use('*', (c, next) => {
    c.set('auth', auth);
    c.set('requestId', 'req-test-1');
    if (usage !== undefined) c.set('usage', usage);
    return next();
  });
  app.use('*', requestLogMiddleware);
  app.post('/test', (c) => c.json({ error: 'rate_limit' }, 429));
  return app;
}

const auth: AuthContext = { mode: 'dedicated', keyId: 1 } as AuthContext;

const errorUsage: UsageData = {
  model: 'gpt-4',
  provider: 'openai',
  promptTokens: 0,
  completionTokens: 0,
  isError: true,
};

describe('requestLogMiddleware - dedicated stream:true + non-SSE response', () => {
  it('logs when client sent stream:true but handler set usage (dedicated 429 regression)', async () => {
    // dedicated-proxy's non-streaming branch (upstream returned a non-SSE 429
    // despite the client requesting stream:true) sets usage with isError=true.
    // This MUST be logged — the old requestBody.stream skip dropped it.
    const app = makeApp(auth, errorUsage);
    await app.request('/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, model: 'gpt-4' }),
    });

    // persistRequestLog inserts into requestLogs + requestDetails ⇒ 2 inserts.
    expect(mockDb.insert).toHaveBeenCalledTimes(2);
  });

  it('skips streaming requests whose handler left usage unset (stream callback persists)', async () => {
    // Real stream handlers leave usage === undefined at streamSSE resolve time;
    // the callback sets usage + persists later. The middleware must skip here.
    const app = makeApp(auth, undefined);
    await app.request('/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, model: 'gpt-4' }),
    });

    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('logs non-streaming requests as a baseline (unchanged behavior)', async () => {
    const app = makeApp(auth, errorUsage);
    await app.request('/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: false, model: 'gpt-4' }),
    });

    expect(mockDb.insert).toHaveBeenCalledTimes(2);
  });
});
