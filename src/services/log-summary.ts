import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import type { Context } from 'hono';
import { getDb } from '../db/index.js';
import { apiKeys, requestLogs, requestDetails } from '../db/schema.js';
import { getRequestDetail } from '../db/repositories/logs.js';
import { getStringSetting, SETTING_KEYS } from '../db/repositories/settings.js';
import { getProviderConfig, createProvider } from './model-router.js';
import { createApiKey } from './api-key.js';
import { trackUsage } from '../middleware/usage-track.js';
import { getClientIp } from '../middleware/request-log.js';
import type { UsageData } from '../middleware/usage-track.js';
import type { AuthContext } from '../middleware/auth.js';
import type { InternalRequest, InternalMessage } from '../types/internal.js';
import type { ProviderAdapter } from '../providers/base.js';
import { Errors } from '../utils/errors.js';
import { estimateTokens } from '../utils/token-estimate.js';
import { getRedis } from '../redis/index.js';
import { getConfig } from '../config/index.js';
import { getLogger } from '../utils/logger.js';

export interface LogSummaryMeta {
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  sharded: boolean;
  shardCount: number;
  generatedAt: string;
}

export interface LogSummaryResult {
  summary: string;
  meta: LogSummaryMeta;
}

const SUMMARY_FEATURE_ID = 'log-analysis';

// 1M-window model: above this estimated prompt size we stop trying to fit the
// whole request body in one call and shard it (map-reduce). Leaves headroom for
// the system prompt + the summary output. estimateTokens uses CHARS_PER_TOKEN=2
// (mixed zh/en/code), so this is ~1.2M chars.
const SHARD_THRESHOLD_TOKENS = 600_000;
// Each map shard targets ~half the threshold in chars so a shard + its system
// prompt + output stay well under the model window.
const SHARD_CHARS = Math.floor(SHARD_THRESHOLD_TOKENS * 2 * 0.5);
// Cache TTL aligned with the default request_details retention (30 days). The
// summary loses meaning once the source row is purged anyway.
const CACHE_TTL_SEC = 30 * 24 * 60 * 60;

// The built-in default summary template (system prompt). Exported so the admin
// settings DTO can surface it as `analysisPromptTemplateDefault` (read-only
// reference + "恢复默认"), and used as the fallback when the admin has not saved
// a custom template (or saved a blank/whitespace-only one). Content is the
// original hard-coded prompt — kept stable as the system default.
export const DEFAULT_SUMMARY_PROMPT = `你是一名 LLM API 请求日志分析助手。下面会给你一条来自开发工具（如 Claude Code、Codex 等）的 LLM API 请求体（JSON）。请用简洁的中文生成小结，包含：
1. 一句话意图：这条请求想做什么；
2. 任务类型：从【编码、调试、问答、重构、文档、测试、数据处理、其他】中选出最贴切的一个或多个；
3. 关键上下文：使用的工具/函数（tools）、对话轮次、system 角色设定、是否涉及具体代码或文件；
4. 值得注意的点：例如上下文超长、内容重复、疑似异常输入等；如无则省略。
直接输出小结，不要复述请求原文，不要使用 Markdown 标题。`;

const SHARD_SYSTEM_PROMPT = `你是一名 LLM API 请求日志分析助手。下面给你的是一份很长的请求日志被切分后的一个片段（原始 JSON，可能在边界处被截断）。请用简洁的中文列出该片段涉及的话题、出现的工具/函数调用、关键的用户指令或代码内容。不要推测片段之外的内容，直接输出要点。`;

function prefixed(key: string): string {
  return `${getConfig().redis.keyPrefix}${key}`;
}

// ── Cache (fail-open, mirrors quota-cache.ts) ────────────────────────────────

export async function getCachedSummary(requestId: string): Promise<LogSummaryResult | null> {
  try {
    const raw = await getRedis().get(prefixed(`logsummary:${requestId}`));
    if (!raw) return null;
    return JSON.parse(raw) as LogSummaryResult;
  } catch {
    return null;
  }
}

async function setCachedSummary(requestId: string, data: LogSummaryResult): Promise<void> {
  try {
    await getRedis().set(
      prefixed(`logsummary:${requestId}`),
      JSON.stringify(data),
      'EX',
      CACHE_TTL_SEC,
    );
  } catch {
    // fail-open: a write miss just means the next request regenerates.
  }
}

// ── Admin-key lookup (bill analysis cost to an existing admin key) ───────────
//
// ensureAdminKeyId() is idempotent: a present active admin key is reused, and
// if none exists one is created on the spot (mode=admin, name='日志分析记账密钥').
// This frees production from running `pnpm db:seed` manually — saving the log-
// analysis model in 系统设置 calls ensureAdminKeyId, and the summary endpoint
// re-ensures as a fallback. The plaintext is discarded immediately (billing
// uses only the id) and never logged. The module cache stores HITS only, so a
// key created after the process started is picked up on the next call instead
// of being shadowed by a stale null.

let cachedAdminKeyId: number | undefined; // undefined = miss not cached / not yet found

async function findActiveAdminKeyId(): Promise<number | null> {
  const db = getDb();
  const [row] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.mode, 'admin'), eq(apiKeys.status, 'active')))
    .limit(1);
  return row?.id ?? null;
}

export async function ensureAdminKeyId(): Promise<number> {
  if (cachedAdminKeyId !== undefined) return cachedAdminKeyId;
  const existing = await findActiveAdminKeyId();
  if (existing != null) {
    cachedAdminKeyId = existing;
    return existing;
  }
  const created = await createApiKey({ mode: 'admin', name: '日志分析记账密钥' });
  cachedAdminKeyId = created.record.id;
  getLogger().info({ keyId: created.record.id }, 'log-analysis: auto-created admin billing key');
  return created.record.id;
}

// ── Provider call (non-streaming) ────────────────────────────────────────────

interface SubCallUsage {
  promptTokens: number;
  completionTokens: number;
  cacheRead: number;
  cacheCreation: number;
}

async function callSummary(
  provider: ProviderAdapter,
  realModel: string,
  systemPrompt: string,
  userText: string,
): Promise<{ text: string; usage: SubCallUsage }> {
  const messages: InternalMessage[] = [
    { role: 'system', content: [{ type: 'text', text: systemPrompt }] },
    { role: 'user', content: [{ type: 'text', text: userText }] },
  ];
  const internalReq: InternalRequest = {
    model: realModel,
    messages,
    parameters: { temperature: 0.3, stream: false },
  };
  const upstreamReq = provider.transformRequest(internalReq);
  const upstreamRes = await provider.send(upstreamReq);
  if (upstreamRes.status >= 400) {
    throw Errors.providerError(
      `分析模型上游错误 (${upstreamRes.status}): ${JSON.stringify(upstreamRes.body).slice(0, 500)}`,
    );
  }
  const internalRes = provider.transformResponse(upstreamRes);
  const text = internalRes.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('')
    .trim();
  return {
    text,
    usage: {
      promptTokens: internalRes.usage.promptTokens,
      completionTokens: internalRes.usage.completionTokens,
      cacheRead: internalRes.usage.cacheRead ?? 0,
      cacheCreation: internalRes.usage.cacheCreation ?? 0,
    },
  };
}

function shardString(s: string, maxChars: number): string[] {
  if (s.length <= maxChars) return [s];
  const shards: string[] = [];
  for (let i = 0; i < s.length; i += maxChars) {
    shards.push(s.slice(i, i + maxChars));
  }
  return shards;
}

// ── Bookkeeping ──────────────────────────────────────────────────────────────
//
// Bill the analysis call to the admin key with feature_id=log-analysis so the
// feature-usage page can isolate analysis cost from real dedicated traffic.
// trackUsage is reused for usage_records. request_logs/request_details are
// written by hand (not via persistRequestLog) so we can NULL request_headers —
// the call is triggered by an admin JWT, and persisting the raw Authorization
// header would leak that JWT into request_details.

async function accountAnalysisCall(
  c: Context,
  args: {
    model: string;
    provider: string;
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    targetRequestId: string;
    sharded: boolean;
    shardCount: number;
    summary: string;
    startTime: number;
  },
): Promise<void> {
  const adminKeyId = await ensureAdminKeyId();

  const usage: UsageData = {
    model: args.model,
    provider: args.provider,
    promptTokens: args.promptTokens,
    completionTokens: args.completionTokens,
    cacheReadTokens: args.cacheReadTokens,
    cacheCreationTokens: args.cacheCreationTokens,
    isError: false,
  };

  // trackUsage reads c.get('auth'); install a synthetic admin-key context for it.
  const syntheticAuth: AuthContext = {
    mode: 'admin',
    keyId: adminKeyId,
    authMethod: 'api_key',
    featureId: SUMMARY_FEATURE_ID,
  };
  c.set('auth', syntheticAuth);

  const analysisRequestId = uuidv4();
  const latencyMs = Date.now() - args.startTime;

  try {
    await trackUsage(c, usage);

    const db = getDb();
    await db.insert(requestLogs).values({
      requestId: analysisRequestId,
      apiKeyId: adminKeyId,
      appId: null,
      userId: null,
      appUserId: null,
      featureId: SUMMARY_FEATURE_ID,
      model: args.model,
      provider: args.provider,
      statusCode: 200,
      latencyMs,
      promptTokens: args.promptTokens,
      completionTokens: args.completionTokens,
      cacheReadTokens: args.cacheReadTokens,
      cacheCreationTokens: args.cacheCreationTokens,
      isStream: false,
      errorMessage: null,
    });
    await db.insert(requestDetails).values({
      requestId: analysisRequestId,
      apiKeyId: adminKeyId,
      requestMethod: c.req.method,
      requestPath: c.req.path,
      // NULL on purpose: c.req.raw.headers carries the admin JWT (Authorization),
      // which must not be persisted. The analysis target is captured in requestBody.
      requestHeaders: null,
      requestBody: {
        type: 'log-analysis',
        targetRequestId: args.targetRequestId,
        sharded: args.sharded,
        shardCount: args.shardCount,
      },
      responseStatus: 200,
      responseHeaders: null,
      responseBody: { summary: args.summary },
      streamChunks: null,
      streamChunkCount: null,
      clientIp: getClientIp(c),
      userAgent: c.req.header('user-agent') || null,
      latencyMs,
    });
  } catch (err) {
    // Bookkeeping failure must not fail the user-facing summary.
    getLogger().error({ err }, 'log-analysis: failed to account call');
  }
}

// ── Public entry point ───────────────────────────────────────────────────────

export async function generateLogSummary(
  c: Context,
  requestId: string,
  force = false,
): Promise<LogSummaryResult> {
  // 1. Return cached summary unless a fresh generation is requested.
  if (!force) {
    const cached = await getCachedSummary(requestId);
    if (cached) return cached;
  }

  // 2. Load the target request detail; only rows with a full request_body can
  //    be summarised (archived shells have it nulled — the UI routes those to
  //    the complete record instead).
  const detail = await getRequestDetail(requestId);
  if (!detail) {
    throw Errors.invalidRequest('日志不存在');
  }
  if (detail.requestBody == null) {
    throw Errors.invalidRequest('该日志无完整请求体（可能已被归并），请在完整记录上生成小结');
  }

  // 3. Resolve the configured analysis model (provider name + real model name).
  const providerName = await getStringSetting(SETTING_KEYS.logAnalysisProvider, '');
  const realModel = await getStringSetting(SETTING_KEYS.logAnalysisModel, '');
  if (!providerName || !realModel) {
    throw Errors.invalidRequest('未配置日志分析模型，请先在系统设置中选择服务商与模型');
  }

  // Resolve the summary template (system prompt). Falls back to the built-in
  // DEFAULT_SUMMARY_PROMPT when unset/blank/whitespace-only, so the feature
  // always has a sane prompt — a custom template overrides only when non-empty.
  const tpl =
    (await getStringSetting(SETTING_KEYS.logAnalysisPromptTemplate, DEFAULT_SUMMARY_PROMPT)).trim() ||
    DEFAULT_SUMMARY_PROMPT;

  // 3b. Ensure an admin key exists to bill the analysis to, auto-creating one
  // if missing — done before spending tokens so a billing anchor always exists
  // without a manual `pnpm db:seed` step.
  await ensureAdminKeyId();

  const providerCfg = await getProviderConfig(providerName);
  const provider = createProvider(providerName, providerCfg, providerCfg.apiType);

  // 4. Build the payload + decide whole vs sharded (map-reduce).
  const bodyStr = JSON.stringify(detail.requestBody);
  const wholeTokens = estimateTokens(bodyStr.length + tpl.length);
  const startTime = Date.now();

  let summary: string;
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  let shardCount = 1;

  if (wholeTokens <= SHARD_THRESHOLD_TOKENS) {
    const r = await callSummary(provider, realModel, tpl, bodyStr);
    summary = r.text;
    promptTokens += r.usage.promptTokens;
    completionTokens += r.usage.completionTokens;
    cacheRead += r.usage.cacheRead;
    cacheCreation += r.usage.cacheCreation;
  } else {
    const shards = shardString(bodyStr, SHARD_CHARS);
    shardCount = shards.length;
    const subSummaries: string[] = [];
    for (let i = 0; i < shards.length; i++) {
      const userText =
        `以下是一段很长的 LLM 请求日志的第 ${i + 1}/${shards.length} 片（原始 JSON 片段，可能在边界处被截断）：\n\n` +
        shards[i];
      const r = await callSummary(provider, realModel, SHARD_SYSTEM_PROMPT, userText);
      subSummaries.push(r.text || `（片段 ${i + 1} 无可识别内容）`);
      promptTokens += r.usage.promptTokens;
      completionTokens += r.usage.completionTokens;
      cacheRead += r.usage.cacheRead;
      cacheCreation += r.usage.cacheCreation;
    }
    const mergeText =
      `以下是同一份请求日志各片段的要点摘录（共 ${shards.length} 片）：\n\n` +
      subSummaries.map((s, i) => `【片段 ${i + 1}】\n${s}`).join('\n\n');
    const r = await callSummary(provider, realModel, tpl, mergeText);
    summary = r.text;
    promptTokens += r.usage.promptTokens;
    completionTokens += r.usage.completionTokens;
    cacheRead += r.usage.cacheRead;
    cacheCreation += r.usage.cacheCreation;
  }

  if (!summary) {
    throw Errors.providerError('分析模型未返回有效小结');
  }

  const sharded = shardCount > 1;

  // 5. Bill the call to the admin key (feature_id=log-analysis).
  await accountAnalysisCall(c, {
    model: realModel,
    provider: providerName,
    promptTokens,
    completionTokens,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    targetRequestId: requestId,
    sharded,
    shardCount,
    summary,
    startTime,
  });

  const result: LogSummaryResult = {
    summary,
    meta: {
      model: realModel,
      provider: providerName,
      promptTokens,
      completionTokens,
      sharded,
      shardCount,
      generatedAt: new Date().toISOString(),
    },
  };

  // 6. Cache (fail-open).
  await setCachedSummary(requestId, result);

  return result;
}
