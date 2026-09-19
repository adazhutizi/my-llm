import { describe, it, expect, vi, beforeEach } from 'vitest';

// The middleware is tested with a fake Hono context; the service layer
// (getUaPoliciesForRequest / evaluateUaPolicies) is mocked so these tests
// isolate chain behaviour: target construction, skip guards, error shape,
// fail-open, and the "never set usage" invariant.

const svc = vi.hoisted(() => ({
  // Typed as unknown: individual tests resolve mixed (policy|null)[] values.
  getUaPoliciesForRequest: vi.fn(),
}));

vi.mock('../src/services/ua-policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/ua-policy.js')>();
  return { ...actual, getUaPoliciesForRequest: svc.getUaPoliciesForRequest };
});
vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
}));

import { uaPolicyMiddleware } from '../src/middleware/ua-policy.js';
import type { AuthContext } from '../src/middleware/auth.js';

interface FakeCtx {
  req: {
    header: (name: string) => string | undefined;
    path: string;
    method: string;
  };
  get: (key: string) => unknown;
  set: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
}

function makeCtx(overrides?: {
  auth?: Partial<AuthContext>;
  ua?: string;
  path?: string;
}): FakeCtx {
  const auth: AuthContext = {
    mode: 'user',
    keyId: 7,
    userId: 3,
    authMethod: 'api_key',
    ...overrides?.auth,
  };
  return {
    req: {
      header: (name: string) => (name === 'user-agent' ? overrides?.ua : undefined),
      path: overrides?.path ?? '/openai/v1/chat/completions',
      method: 'POST',
    },
    get: (key: string) => (key === 'auth' ? auth : key === 'requestId' ? 'req-1' : undefined),
    set: vi.fn(),
    json: vi.fn((body: unknown, status?: number) => ({ body, status })),
  };
}

beforeEach(() => {
  // Default: no level has a policy (all-null aligned with the default target
  // set global/user/api_key; tests that use other target sets re-mock).
  svc.getUaPoliciesForRequest.mockReset().mockResolvedValue([null, null, null]);
});

describe('uaPolicyMiddleware', () => {
  it('passes through when no level has a policy (fast path, no regex work)', async () => {
    const ctx = makeCtx();
    const next = vi.fn();
    await uaPolicyMiddleware(ctx as never, next as never);
    expect(next).toHaveBeenCalledOnce();
    expect(ctx.json).not.toHaveBeenCalled();
    expect(ctx.set).not.toHaveBeenCalledWith('usage', expect.anything());
  });

  it('builds targets as global + app/user (when present) + api_key', async () => {
    const ctx = makeCtx({ auth: { mode: 'app', keyId: 9, appId: 5, userId: undefined } });
    await uaPolicyMiddleware(ctx as never, vi.fn() as never);
    expect(svc.getUaPoliciesForRequest).toHaveBeenCalledWith([
      { type: 'global', id: null },
      { type: 'app', id: 5 },
      { type: 'api_key', id: 9 },
    ]);
  });

  it('dedicated keys are checked (global + api_key)', async () => {
    const ctx = makeCtx({ auth: { mode: 'dedicated', keyId: 12, userId: undefined } });
    await uaPolicyMiddleware(ctx as never, vi.fn() as never);
    expect(svc.getUaPoliciesForRequest).toHaveBeenCalledWith([
      { type: 'global', id: null },
      { type: 'api_key', id: 12 },
    ]);
  });

  it('GET /openai/v1/models is still checked (admission semantics, unlike quotaCheck)', async () => {
    const ctx = makeCtx({ path: '/openai/v1/models', ua: 'curl/8.0' });
    const next = vi.fn();
    // Feed a global block that matches the UA (targets: global, user, api_key).
    svc.getUaPoliciesForRequest.mockResolvedValue([
      { mode: 'block', patterns: ['^curl'] },
      null,
      null,
    ]);
    ctx.req.method = 'GET';
    await uaPolicyMiddleware(ctx as never, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.json).toHaveBeenCalledWith(expect.anything(), 403);
  });

  it('skips JWT-authenticated requests (defensive guard)', async () => {
    const ctx = makeCtx({ auth: { mode: 'admin', keyId: 0, authMethod: 'jwt' } });
    const next = vi.fn();
    await uaPolicyMiddleware(ctx as never, next as never);
    expect(next).toHaveBeenCalledOnce();
    expect(svc.getUaPoliciesForRequest).not.toHaveBeenCalled();
  });

  it('denies with the OpenAI error shape on /openai/* paths', async () => {
    const ctx = makeCtx({ ua: 'curl/8.0' });
    svc.getUaPoliciesForRequest.mockResolvedValue([
      { mode: 'block', patterns: ['^curl'] },
      null,
    ]);
    const next = vi.fn();
    await uaPolicyMiddleware(ctx as never, next as never);
    expect(next).not.toHaveBeenCalled();
    const { body, status } = ctx.json.mock.calls[0][0] ? { body: ctx.json.mock.calls[0][0], status: ctx.json.mock.calls[0][1] } : { body: null, status: 0 };
    expect(status).toBe(403);
    expect((body as { error: { code: string } }).error.code).toBe('user_agent_not_allowed');
  });

  it('denies with the Anthropic permission_error shape on /anthropic/* paths', async () => {
    const ctx = makeCtx({ ua: 'curl/8.0', path: '/anthropic/v1/messages' });
    svc.getUaPoliciesForRequest.mockResolvedValue([
      { mode: 'allow', patterns: ['^my-app'] },
      null,
    ]);
    const next = vi.fn();
    await uaPolicyMiddleware(ctx as never, next as never);
    expect(next).not.toHaveBeenCalled();
    const body = ctx.json.mock.calls[0][0] as { type: string; error: { type: string } };
    expect(ctx.json.mock.calls[0][1]).toBe(403);
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('permission_error');
  });

  it('never sets usage on rejection (entry-layer rejections are not logged)', async () => {
    const ctx = makeCtx({ ua: 'curl/8.0' });
    svc.getUaPoliciesForRequest.mockResolvedValue([
      { mode: 'block', patterns: ['^curl'] },
      null,
    ]);
    await uaPolicyMiddleware(ctx as never, vi.fn() as never);
    const usageSets = ctx.set.mock.calls.filter(([k]) => k === 'usage');
    expect(usageSets).toHaveLength(0);
  });

  it('fails OPEN when the service throws (never blocks traffic on internal errors)', async () => {
    const ctx = makeCtx({ ua: 'curl/8.0' });
    svc.getUaPoliciesForRequest.mockRejectedValue(new Error('boom'));
    const next = vi.fn();
    await uaPolicyMiddleware(ctx as never, next as never);
    expect(next).toHaveBeenCalledOnce();
    expect(ctx.json).not.toHaveBeenCalled();
  });

  it('missing user-agent header participates as empty string (allow mode denies)', async () => {
    const ctx = makeCtx({ ua: undefined });
    svc.getUaPoliciesForRequest.mockResolvedValue([
      { mode: 'allow', patterns: ['^my-app'] },
      null,
    ]);
    const next = vi.fn();
    await uaPolicyMiddleware(ctx as never, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.json.mock.calls[0][1]).toBe(403);
  });

  it('stacked: key-level block denies even when the global allow matches', async () => {
    const ctx = makeCtx({ ua: 'my-app/1.0' });
    // targets order: global, (no app/user here), api_key
    svc.getUaPoliciesForRequest.mockResolvedValue([
      { mode: 'allow', patterns: ['^(my-app|curl)'] },
      { mode: 'block', patterns: ['^my-app'] },
    ]);
    const next = vi.fn();
    await uaPolicyMiddleware(ctx as never, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.json.mock.calls[0][1]).toBe(403);
  });

  it('truncates the UA to 512 chars before matching', async () => {
    const ctx = makeCtx({ ua: 'a'.repeat(600) });
    svc.getUaPoliciesForRequest.mockResolvedValue([
      { mode: 'block', patterns: ['^a{600}$'] }, // only matches the FULL 600-char string
      null,
    ]);
    const next = vi.fn();
    await uaPolicyMiddleware(ctx as never, next as never);
    // Truncated to 512 → the ^a{600}$ pattern must NOT match → allowed.
    expect(next).toHaveBeenCalledOnce();
    expect(ctx.json).not.toHaveBeenCalled();
  });
});
