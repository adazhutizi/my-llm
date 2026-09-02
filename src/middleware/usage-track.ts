import { Context, Next } from 'hono';
import { sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { usageRecords } from '../db/schema.js';
import { getLogger } from '../utils/logger.js';
import type { AuthContext } from './auth.js';
import {
  buildQuotaChecks,
  checkQuota,
  setTargetStatus,
} from '../services/quota.js';
import { incrementQuotaCache } from '../services/quota-cache.js';

export interface UsageData {
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  // Anthropic prompt-cache breakdown (optional: OpenAI/embeddings/images paths
  // don't set them → trackUsage treats undefined as 0). promptTokens is the
  // non-cached input; cache* hold the cache hit/write tokens.
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  isError: boolean;
}

/**
 * Persist usage data into the hourly-aggregated usage_records table.
 * Exported so streaming handlers can call it directly when the
 * middleware post-response phase has already resolved.
 */
export async function trackUsage(
  c: Context,
  usage: UsageData
): Promise<void> {
  const auth = c.get('auth') as AuthContext | undefined;
  if (!auth) return;

  const db = getDb();

  const hourStart = new Date();
  hourStart.setMinutes(0, 0, 0);

  // totalTokens folds in cache so SUM(total_tokens) — what the quota check reads
  // — reflects real consumption. For OpenAI cacheRead/cacheCreation are 0 and
  // promptTokens already includes cached, so this stays correct there too.
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheCreationTokens = usage.cacheCreationTokens ?? 0;

  await db
    .insert(usageRecords)
    .values({
      recordTime: hourStart,
      apiKeyId: auth.keyId,
      appId: auth.appId ?? null,
      userId: auth.userId ?? null,
      model: usage.model,
      provider: usage.provider,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cacheReadTokens,
      cacheCreationTokens,
      totalTokens: usage.promptTokens + usage.completionTokens + cacheReadTokens + cacheCreationTokens,
      requestCount: 1,
      errorCount: usage.isError ? 1 : 0,
    })
    .onDuplicateKeyUpdate({
      set: {
        promptTokens: sql`prompt_tokens + VALUES(prompt_tokens)`,
        completionTokens: sql`completion_tokens + VALUES(completion_tokens)`,
        cacheReadTokens: sql`cache_read_tokens + VALUES(cache_read_tokens)`,
        cacheCreationTokens: sql`cache_creation_tokens + VALUES(cache_creation_tokens)`,
        totalTokens: sql`total_tokens + VALUES(total_tokens)`,
        requestCount: sql`request_count + 1`,
        errorCount: sql`error_count + VALUES(error_count)`,
      },
    });
}

async function checkAndDisableIfQuotaExceeded(auth: AuthContext): Promise<void> {
  // sumTokensUsed() (called inside checkQuota) already reflects THIS request:
  // trackUsage() ran above and was awaited, so the persisted usage includes the
  // current request's tokens. checkQuota does NOT add them again — that would
  // double-count and disable targets early.
  //
  // Checks run in parallel (each target's checkQuota is an independent
  // config read + up to two aggregate queries — serial await tripled the
  // post-response latency for 3-target keys), but the disable decision walks
  // the results in order so the priority (app → user → api_key) matches the
  // previous serial loop: still "disable only the first exceeded target".
  const checks = buildQuotaChecks(auth);
  const results = await Promise.all(
    checks.map(async (check) => ({ check, ...(await checkQuota(check)) })),
  );

  for (const { check, over, reason } of results) {
    if (over) {
      await setTargetStatus(check.type, check.id, 'quota_exceeded');
      getLogger().warn({ check, reason }, 'Quota exceeded, target disabled');
      break; // Only disable the first (highest-priority) exceeded target
    }
  }
}

export async function usageTrackMiddleware(c: Context, next: Next) {
  await next();

  const usage = c.get('usage') as UsageData | undefined;
  if (!usage) return;

  const auth = c.get('auth') as AuthContext | undefined;
  if (!auth) return;

  try {
    await trackUsage(c, usage);

    // Optimistically update cache with actual usage (includes cache tokens so the
    // fast quota pre-check matches the DB-backed disable decision).
    const totalTokens =
      usage.promptTokens +
      usage.completionTokens +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheCreationTokens ?? 0);
    await incrementQuotaCache(`quota:api_key:${auth.keyId}`, totalTokens);
    if (auth.userId != null) {
      await incrementQuotaCache(`quota:user:${auth.userId}`, totalTokens);
    }
    if (auth.appId != null) {
      await incrementQuotaCache(`quota:app:${auth.appId}`, totalTokens);
    }
    // Per-key model bucket (virtual model id, same vocabulary as body.model —
    // see trackUsage). Incremented unconditionally: the Lua script is a no-op
    // on absent keys, so this costs nothing unless the precheck seeded the
    // bucket (i.e. this key has a per-model limit on this model).
    await incrementQuotaCache(
      `quota:api_key:${auth.keyId}:model:${usage.model}`,
      totalTokens,
    );

    // Check and auto-disable if any target exceeded quota
    await checkAndDisableIfQuotaExceeded(auth);
  } catch (err) {
    getLogger().error({ err }, 'Failed to track usage');
  }
}
