import { describe, it, expect, vi } from 'vitest';

// parseModelPolicy's fail-open path logs a warning — createLogger needs
// loadConfig() which tests never run.
vi.mock('../src/utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  })),
}));

import {
  ModelPolicySchema,
  parseModelPolicy,
  isModelAllowed,
  getModelLimit,
  type ModelPolicy,
} from '../src/services/model-policy.js';

// ── parseModelPolicy ────────────────────────────────────────────────────────

describe('parseModelPolicy', () => {
  it('returns null for absent / non-object permissions', () => {
    expect(parseModelPolicy(null)).toBeNull();
    expect(parseModelPolicy(undefined)).toBeNull();
    expect(parseModelPolicy('nope')).toBeNull();
    expect(parseModelPolicy(42)).toBeNull();
  });

  it('returns null when modelPolicy key is absent or null', () => {
    expect(parseModelPolicy({})).toBeNull();
    expect(parseModelPolicy({ other: true })).toBeNull();
    expect(parseModelPolicy({ modelPolicy: null })).toBeNull();
  });

  it('parses a full allow policy with limits', () => {
    const policy = parseModelPolicy({
      modelPolicy: {
        mode: 'allow',
        models: ['gpt-4o', 'claude-sonnet-4'],
        limits: { 'gpt-4o': { dailyTokens: 1_000_000, monthlyTokens: null } },
      },
    });
    expect(policy).toEqual({
      mode: 'allow',
      models: ['gpt-4o', 'claude-sonnet-4'],
      limits: { 'gpt-4o': { dailyTokens: 1_000_000, monthlyTokens: null } },
    });
  });

  it('parses policy without limits', () => {
    const policy = parseModelPolicy({ modelPolicy: { mode: 'block', models: ['dall-e-3'] } });
    expect(policy).toEqual({ mode: 'block', models: ['dall-e-3'] });
    expect(policy?.limits).toBeUndefined();
  });

  it('keeps mode "all" (explicit unrestricted)', () => {
    const policy = parseModelPolicy({ modelPolicy: { mode: 'all', models: [] } });
    expect(policy?.mode).toBe('all');
  });

  // fail-open: malformed data must degrade to unrestricted, never lock a key
  // out of the gateway
  it('returns null for malformed payloads (fail-open)', () => {
    expect(parseModelPolicy({ modelPolicy: { mode: 'whitelist', models: [] } })).toBeNull();
    expect(parseModelPolicy({ modelPolicy: { mode: 'allow', models: 'gpt-4o' } })).toBeNull();
    expect(parseModelPolicy({ modelPolicy: { mode: 'allow', models: [''] } })).toBeNull();
    expect(parseModelPolicy({ modelPolicy: { mode: 'allow', models: [], limits: { m: { dailyTokens: '1000' } } } })).toBeNull();
    expect(parseModelPolicy({ modelPolicy: { mode: 'allow', models: [], limits: { m: { dailyTokens: -5 } } } })).toBeNull();
    expect(parseModelPolicy({ modelPolicy: 'allow' })).toBeNull();
  });
});

// ── ModelPolicySchema (used by the admin write path) ────────────────────────

describe('ModelPolicySchema', () => {
  it('accepts valid payloads', () => {
    expect(
      ModelPolicySchema.safeParse({ mode: 'allow', models: ['a'], limits: { a: { dailyTokens: 10 } } }).success
    ).toBe(true);
    expect(
      ModelPolicySchema.safeParse({ mode: 'all', models: [] }).success
    ).toBe(true);
  });

  it('rejects invalid payloads', () => {
    expect(ModelPolicySchema.safeParse({ mode: 'nope', models: [] }).success).toBe(false);
    expect(ModelPolicySchema.safeParse({ mode: 'allow' }).success).toBe(false);
    expect(ModelPolicySchema.safeParse({ mode: 'allow', models: [123] }).success).toBe(false);
  });
});

// ── isModelAllowed ──────────────────────────────────────────────────────────

describe('isModelAllowed', () => {
  it('allows everything with null policy', () => {
    expect(isModelAllowed(null, 'anything')).toBe(true);
  });

  it('allows everything in mode all', () => {
    const policy: ModelPolicy = { mode: 'all', models: [] };
    expect(isModelAllowed(policy, 'gpt-4o')).toBe(true);
  });

  it('allowlist: listed model passes, unlisted rejected', () => {
    const policy: ModelPolicy = { mode: 'allow', models: ['gpt-4o', 'qwen-max'] };
    expect(isModelAllowed(policy, 'gpt-4o')).toBe(true);
    expect(isModelAllowed(policy, 'claude-sonnet-4')).toBe(false);
  });

  it('blocklist: listed model rejected, unlisted passes', () => {
    const policy: ModelPolicy = { mode: 'block', models: ['gpt-4o'] };
    expect(isModelAllowed(policy, 'gpt-4o')).toBe(false);
    expect(isModelAllowed(policy, 'claude-sonnet-4')).toBe(true);
  });
});

// ── getModelLimit ───────────────────────────────────────────────────────────

describe('getModelLimit', () => {
  it('returns null for null policy or missing limits', () => {
    expect(getModelLimit(null, 'gpt-4o')).toBeNull();
    expect(getModelLimit({ mode: 'allow', models: ['gpt-4o'] }, 'gpt-4o')).toBeNull();
  });

  it('returns the configured limit for a listed model', () => {
    const policy: ModelPolicy = {
      mode: 'allow',
      models: ['gpt-4o', 'claude-sonnet-4'],
      limits: { 'gpt-4o': { dailyTokens: 1000, monthlyTokens: 30_000 } },
    };
    expect(getModelLimit(policy, 'gpt-4o')).toEqual({ dailyTokens: 1000, monthlyTokens: 30_000 });
    // no limits entry → unlimited
    expect(getModelLimit(policy, 'claude-sonnet-4')).toBeNull();
  });

  it('treats an all-null limit object as a real (but unlimited) limit', () => {
    const policy: ModelPolicy = {
      mode: 'allow',
      models: ['gpt-4o'],
      limits: { 'gpt-4o': { dailyTokens: null, monthlyTokens: null } },
    };
    expect(getModelLimit(policy, 'gpt-4o')).toEqual({ dailyTokens: null, monthlyTokens: null });
  });
});
