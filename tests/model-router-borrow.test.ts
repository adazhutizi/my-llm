import { describe, it, expect, vi, beforeEach } from 'vitest';

// resolveModel 查 virtual_models、getProviderConfig 查 providers——同一 select
// 链 mock，用队列按调用顺序出队行（每项为一次 limit() 的返回值）。
const queryQueue: Record<string, unknown>[][] = [];
vi.mock('../src/db/index.js', () => ({
  getDb: vi.fn(() => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => (queryQueue.length > 0 ? queryQueue.shift()! : [])),
        })),
      })),
    })),
  })),
}));

import {
  resolveModelWithBorrow,
  borrowOverrideFromAuth,
} from '../src/services/model-router.js';
import type { AuthContext } from '../src/middleware/auth.js';

beforeEach(() => {
  queryQueue.length = 0;
});

describe('borrowOverrideFromAuth', () => {
  it('returns undefined without borrow flags', () => {
    expect(borrowOverrideFromAuth(undefined)).toBeUndefined();
    expect(borrowOverrideFromAuth({ mode: 'user', keyId: 1 } as AuthContext)).toBeUndefined();
  });

  it('returns undefined for a passthrough-mode dedicated borrow', () => {
    const auth = {
      mode: 'dedicated',
      keyId: 7,
      upstreamApiKey: 'sk-borrowed',
      providerName: 'BoundProvider',
    } as AuthContext; // 无 borrowViaProvider = 透传借调或无借调
    expect(borrowOverrideFromAuth(auth)).toBeUndefined();
  });

  it('extracts providerName + apiKey when the provider-pipeline borrow is active', () => {
    const auth = {
      mode: 'dedicated',
      keyId: 7,
      upstreamApiKey: 'sk-borrowed',
      borrowViaProvider: true,
      borrowProviderName: 'BorrowedP',
    } as AuthContext;
    expect(borrowOverrideFromAuth(auth)).toEqual({ providerName: 'BorrowedP', apiKey: 'sk-borrowed' });
  });

  it('returns undefined when pieces are missing (defensive)', () => {
    const auth = { mode: 'dedicated', keyId: 7, borrowViaProvider: true } as AuthContext;
    expect(borrowOverrideFromAuth(auth)).toBeUndefined();
  });
});

describe('resolveModelWithBorrow', () => {
  it('rejects a model that does not belong to the borrowed provider', async () => {
    // virtual_models 查不到 → 前缀兜底 'gpt-' → openai；借调限定 other-provider
    queryQueue.push([]); // virtual_models miss
    await expect(
      resolveModelWithBorrow('gpt-4o', { providerName: 'other-provider', apiKey: 'sk-x' }),
    ).rejects.toThrow(/借调/);
  });

  it('resolves and OVERRIDES the credential when the model belongs to the borrowed provider', async () => {
    queryQueue.push([
      { id: 1, modelId: 'gpt-4o', displayName: 'GPT', provider: 'borrowed-p', realModel: 'gpt-4o-real', fallbacks: null, isActive: 1, createdAt: new Date() },
    ]);
    queryQueue.push([
      { id: 9, name: 'borrowed-p', apiType: 'openai', baseUrl: 'https://api.example.com/v1', apiKeyEnc: 'sk-provider-default', config: null, isActive: 1, createdAt: new Date() },
    ]);

    const { resolved, providerCfg } = await resolveModelWithBorrow('gpt-4o', {
      providerName: 'borrowed-p',
      apiKey: 'sk-borrowed',
    });

    expect(resolved.provider).toBe('borrowed-p');
    expect(resolved.realModel).toBe('gpt-4o-real');
    // 借来凭证覆盖 provider 默认 key
    expect(providerCfg.apiKey).toBe('sk-borrowed');
    expect(providerCfg.apiType).toBe('openai');
  });

  it('keeps the provider default credential when no borrow is active', async () => {
    queryQueue.push([
      { id: 1, modelId: 'gpt-4o', displayName: 'GPT', provider: 'openai', realModel: 'gpt-4o', fallbacks: null, isActive: 1, createdAt: new Date() },
    ]);
    queryQueue.push([
      { id: 2, name: 'openai', apiType: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnc: 'sk-default', config: null, isActive: 1, createdAt: new Date() },
    ]);

    const { resolved, providerCfg } = await resolveModelWithBorrow('gpt-4o', undefined);

    expect(resolved.provider).toBe('openai');
    expect(providerCfg.apiKey).toBe('sk-default');
  });
});
