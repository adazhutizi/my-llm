import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../src/middleware/auth.js';
import type { AuthContext } from '../src/middleware/auth.js';

// Mock validateApiKey to return a dedicated key row with borrow fields, no DB.
vi.mock('../src/services/api-key.js', () => ({
  validateApiKey: vi.fn(),
  detectKeyMode: (key: string) => (key.startsWith('ded_sk_') ? 'dedicated' : null),
}));

// 惰性恢复写库走 repository mock。
vi.mock('../src/db/repositories/api-keys.js', () => ({
  clearApiKeyBorrow: vi.fn(),
}));

// getLogger 在测试环境无配置（getConfig 抛错），惰性恢复分支会打日志 → mock 掉。
vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

// dedicated 分支的 provider 查询：按测试变量返回行（空数组 = provider 不存在）。
let providerRows: Record<string, unknown>[] = [];
vi.mock('../src/db/index.js', () => ({
  getDb: vi.fn(() => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => providerRows,
        }),
      }),
    }),
  })),
}));

import { validateApiKey } from '../src/services/api-key.js';
import { clearApiKeyBorrow } from '../src/db/repositories/api-keys.js';

const mockedValidate = vi.mocked(validateApiKey);
const mockedClearBorrow = vi.mocked(clearApiKeyBorrow);

const providerRow = {
  baseUrl: 'https://api.example.com/v1',
  apiType: 'openai' as const,
  isActive: true,
  name: 'BoundProvider',
  config: null,
};

/** 带（可选）借用字段的 dedicated key 行。 */
function makeDedicatedKey(borrow?: {
  key: string;
  providerId: number;
  expiresAt: Date | null;
  startAt?: Date | null;
  mode?: 'passthrough' | 'provider';
}) {
  return {
    id: 7,
    keySecret: 'ded_sk_x',
    keyPrefix: 'ded_sk_x',
    mode: 'dedicated' as const,
    userId: null,
    appId: null,
    providerId: 2,
    upstreamApiKeyEnc: 'sk-original',
    name: 'D1',
    permissions: null,
    status: 'active' as const,
    expiresAt: null,
    createdAt: new Date(),
    borrowedUpstreamKey: borrow?.key ?? null,
    borrowedProviderId: borrow?.providerId ?? null,
    borrowExpiresAt: borrow?.expiresAt ?? null,
    borrowStartedAt: borrow ? (borrow.startAt ?? new Date(Date.now() - 3600_000)) : null,
    borrowNote: null,
    borrowMode: borrow?.mode ?? 'passthrough',
  };
}

function makeApp() {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.all('/test', (c) => c.json({ auth: c.get('auth') }));
  return app;
}

async function run(key = 'ded_sk_test12345678901234567890123456789012') {
  const res = await makeApp().request('/test', {
    headers: { Authorization: `Bearer ${key}` },
  });
  return { status: res.status, body: (await res.json()) as { auth: AuthContext } };
}

beforeEach(() => {
  vi.clearAllMocks();
  providerRows = [{ ...providerRow }];
});

describe('Auth middleware - dedicated upstream borrow', () => {
  it('routes via borrowed provider + borrowed credential while the borrow is active', async () => {
    mockedValidate.mockResolvedValue(
      makeDedicatedKey({
        key: 'sk-borrowed',
        providerId: 4,
        expiresAt: new Date(Date.now() + 3600_000),
      }) as never,
    );

    const { status, body } = await run();

    expect(status).toBe(200);
    expect(body.auth.providerId).toBe(4);
    expect(body.auth.upstreamApiKey).toBe('sk-borrowed');
    expect(body.auth.providerBaseUrl).toBe(providerRow.baseUrl);
    expect(mockedClearBorrow).not.toHaveBeenCalled();
  });

  it('treats a null expiry as open-ended (active until manual restore)', async () => {
    mockedValidate.mockResolvedValue(
      makeDedicatedKey({ key: 'sk-borrowed', providerId: 4, expiresAt: null }) as never,
    );

    const { status, body } = await run();

    expect(status).toBe(200);
    expect(body.auth.providerId).toBe(4);
    expect(body.auth.upstreamApiKey).toBe('sk-borrowed');
    expect(mockedClearBorrow).not.toHaveBeenCalled();
  });

  it('flags borrowViaProvider for a manual-specification borrow (borrow_mode=provider)', async () => {
    mockedValidate.mockResolvedValue(
      makeDedicatedKey({ key: 'sk-borrowed', providerId: 4, expiresAt: null, mode: 'provider' }) as never,
    );

    const { status, body } = await run();

    expect(status).toBe(200);
    expect(body.auth.borrowViaProvider).toBe(true);
    expect(body.auth.borrowProviderName).toBe(providerRow.name);
    // 透传字段照设（dedicatedProxy 凭 borrowViaProvider 放行，不看它们）
    expect(body.auth.upstreamApiKey).toBe('sk-borrowed');
  });

  it('does NOT flag borrowViaProvider for a from-key borrow (borrow_mode=passthrough)', async () => {
    mockedValidate.mockResolvedValue(
      makeDedicatedKey({ key: 'sk-borrowed', providerId: 4, expiresAt: null, mode: 'passthrough' }) as never,
    );

    const { status, body } = await run();

    expect(status).toBe(200);
    expect(body.auth.borrowViaProvider).toBeUndefined();
  });

  it('lazily restores an expired borrow and falls back to the original credential', async () => {
    mockedValidate.mockResolvedValue(
      makeDedicatedKey({
        key: 'sk-borrowed',
        providerId: 4,
        expiresAt: new Date(Date.now() - 1000),
      }) as never,
    );

    const { status, body } = await run();

    expect(status).toBe(200);
    expect(mockedClearBorrow).toHaveBeenCalledWith(7);
    expect(body.auth.providerId).toBe(2);
    expect(body.auth.upstreamApiKey).toBe('sk-original');
  });

  it('still falls back to the original credential when the lazy restore write fails', async () => {
    mockedValidate.mockResolvedValue(
      makeDedicatedKey({
        key: 'sk-borrowed',
        providerId: 4,
        expiresAt: new Date(Date.now() - 1000),
      }) as never,
    );
    mockedClearBorrow.mockRejectedValue(new Error('db down'));

    const { status, body } = await run();

    expect(status).toBe(200);
    expect(body.auth.providerId).toBe(2);
    expect(body.auth.upstreamApiKey).toBe('sk-original');
  });

  it('keeps the original credential untouched when no borrow fields exist', async () => {
    mockedValidate.mockResolvedValue(makeDedicatedKey() as never);

    const { status, body } = await run();

    expect(status).toBe(200);
    expect(mockedClearBorrow).not.toHaveBeenCalled();
    expect(body.auth.providerId).toBe(2);
    expect(body.auth.upstreamApiKey).toBe('sk-original');
  });

  it('keeps serving the ORIGINAL credential before a scheduled start time and does NOT clear the borrow', async () => {
    // 提前预约的借调：开始时间在未来、到期未过 → 不生效也不惰性清除，
    // 跨过开始时间后的下一次请求自动切到借用。
    mockedValidate.mockResolvedValue(
      makeDedicatedKey({
        key: 'sk-borrowed',
        providerId: 4,
        expiresAt: new Date(Date.now() + 86_400_000),
        startAt: new Date(Date.now() + 3600_000),
      }) as never,
    );

    const { status, body } = await run();

    expect(status).toBe(200);
    expect(mockedClearBorrow).not.toHaveBeenCalled();
    expect(body.auth.providerId).toBe(2);
    expect(body.auth.upstreamApiKey).toBe('sk-original');
  });

  it('fails auth when the effective (borrowed) provider no longer exists', async () => {
    mockedValidate.mockResolvedValue(
      makeDedicatedKey({
        key: 'sk-borrowed',
        providerId: 4,
        expiresAt: new Date(Date.now() + 3600_000),
      }) as never,
    );
    providerRows = [];

    const { status } = await run();
    expect(status).toBe(401);
  });
});
