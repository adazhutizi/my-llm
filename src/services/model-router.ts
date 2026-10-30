import { eq, and } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { virtualModels, providers } from '../db/schema.js';
import { Errors } from '../utils/errors.js';
import type { ProviderConfig, ProviderAdapter } from '../providers/base.js';
import { OpenAIProvider } from '../providers/openai.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import type { AuthContext } from '../middleware/auth.js';

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

// ── 借调限定 + 凭证覆盖（dedicated key 手动借调走 Provider 管线）──────────────
// 手动指定服务商的借调（borrow_mode='provider'）让该 ded key 的请求改走普通
// 密钥的调用逻辑：模型路由只允许命中借调服务商名下的虚拟模型，且上游凭证用
// 借来的 key（覆盖 provider 默认 key）。从密钥借调（'passthrough'）不经此处
// ——dedicatedProxy 原样透传，协议兼容由管理员负责。

/** 从 auth 上下文提取借调覆盖信息（非 provider 模式借调返回 undefined）。 */
export function borrowOverrideFromAuth(
  auth: AuthContext | undefined,
): { providerName: string; apiKey: string } | undefined {
  if (!auth?.borrowViaProvider || !auth.borrowProviderName || !auth.upstreamApiKey) return undefined;
  return { providerName: auth.borrowProviderName, apiKey: auth.upstreamApiKey };
}

export interface ResolvedWithProvider {
  resolved: ResolvedModel;
  providerCfg: ProviderConfig & { apiType: 'openai' | 'anthropic'; estimateFallback: boolean };
}

/**
 * resolveModel + getProviderConfig 的借调感知包装（三路由 + embeddings/images
 * 共用注入点）：借调生效时校验模型归属借调服务商，并覆盖上游凭证。
 */
export async function resolveModelWithBorrow(
  modelId: string,
  borrow: { providerName: string; apiKey: string } | undefined,
): Promise<ResolvedWithProvider> {
  const resolved = await resolveModel(modelId);
  if (borrow && resolved.provider !== borrow.providerName) {
    throw Errors.invalidRequest(
      `当前密钥处于借调状态（服务商 ${borrow.providerName}），仅支持该服务商的模型；` +
        `“${modelId}”归属 ${resolved.provider}`,
    );
  }
  const providerCfg = await getProviderConfig(resolved.provider);
  if (borrow) providerCfg.apiKey = borrow.apiKey;
  return { resolved, providerCfg };
}
