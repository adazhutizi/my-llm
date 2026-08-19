import { eq, and } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { virtualModels, providers } from '../db/schema.js';
import { Errors } from '../utils/errors.js';
import type { ProviderConfig, ProviderAdapter } from '../providers/base.js';
import { OpenAIProvider } from '../providers/openai.js';
import { AnthropicProvider } from '../providers/anthropic.js';

const PREFIX_MAP: Record<string, string> = {
  'gpt-': 'openai',
  'o1-': 'openai',
  'o3-': 'openai',
  'claude-': 'anthropic',
  'qwen-': 'dashscope',
  'text-embedding-': 'openai',
  'dall-e-': 'openai',
};

export interface ResolvedModel {
  provider: string;
  realModel: string;
  fallbacks: string[] | null;
}

export async function resolveModel(modelId: string): Promise<ResolvedModel> {
  const db = getDb();

  // Try virtual_models table first
  const [vm] = await db
    .select()
    .from(virtualModels)
    .where(eq(virtualModels.modelId, modelId))
    .limit(1);

  if (vm && vm.isActive) {
    return {
      provider: vm.provider,
      realModel: vm.realModel,
      fallbacks: (vm.fallbacks as string[]) || null,
    };
  }

  // Prefix-based fallback
  for (const [prefix, provider] of Object.entries(PREFIX_MAP)) {
    if (modelId.startsWith(prefix)) {
      return { provider, realModel: modelId, fallbacks: null };
    }
  }

  throw Errors.modelNotFound(modelId);
}

export async function getProviderConfig(
  providerName: string
): Promise<ProviderConfig & { apiType: 'openai' | 'anthropic'; estimateFallback: boolean }> {
  const db = getDb();

  const [provider] = await db
    .select()
    .from(providers)
    .where(
      and(eq(providers.name, providerName), eq(providers.isActive, true))
    )
    .limit(1);

  if (!provider) {
    throw Errors.providerError(
      `Provider not found or inactive: ${providerName}`
    );
  }

  const extra = (provider.config as Record<string, unknown>) || {};

  return {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKeyEnc || '',
    timeout: (extra.timeout as number) ?? undefined,
    maxRetries: (extra.maxRetries as number) ?? undefined,
    apiType: provider.apiType,
    // Token fallback (chars→tokens when upstream omits usage) is off by
    // default; admins opt in per provider via config.estimateFallback.
    estimateFallback: extra.estimateFallback === true,
  };
}

export function createProvider(
  name: string,
  config: ProviderConfig,
  apiType?: 'openai' | 'anthropic'
): ProviderAdapter {
  // Prefer apiType if provided (from DB config)
  const type = apiType ?? inferApiType(name);

  switch (type) {
    case 'openai':
      return new OpenAIProvider(config);
    case 'anthropic':
      return new AnthropicProvider(config);
    default:
      throw Errors.providerError(`Unknown apiType: ${type}`);
  }
}

function inferApiType(name: string): 'openai' | 'anthropic' {
  // Fallback for legacy name-based routing
  if (name.toLowerCase().includes('anthropic')) return 'anthropic';
  return 'openai';
}
