import { Context } from 'hono';
import { stream } from 'hono/streaming';
import { trackUsage, type UsageData } from '../middleware/usage-track.js';
import { persistRequestLog } from '../middleware/request-log.js';
import { getLogger } from '../utils/logger.js';
import { UPSTREAM_TIMEOUT_MS } from '../providers/base.js';
import {
  estimateTokens,
  estimateTokensFromUnknownBody,
  isTokenGeneratingPath,
} from '../utils/token-estimate.js';
import {
  extractUsage,
  mergeStreamUsage,
  type ExtractedUsage,
} from './usage-extract.js';
import { parseSSEDataLines } from '../utils/sse-parse.js';
import { rawHeaderPairs, buildUpstreamHeaders, detectCredentialName } from '../utils/headers.js';
import { logUpstreamError } from '../utils/upstream-error.js';

// ─────────────────────────────────────────────────────────────────────────────
// 同族透传旁路。
//
// 当客户端协议族与上游 provider 协议族一致时(OpenAI 系客户端 CC/Responses +
// OpenAI 系上游;或 Anthropic 客户端 + Anthropic 上游),不经 Internal
// Request/Response 中转,原样转发客户端请求(仅换虚拟 model 名 → 上游真实
// model、按上游族重写凭证、剥代理 fingerprint 头),原样返回上游响应(含流式
// SSE 裸字节)。
//
// 意义:消除同族内的无意义协议转换(原先 CC 客户端 + OpenAI 上游被
// CC→Internal→Responses→CC 双重改写),并修复 Internal 中转丢失的字段(CC 的
// n/seed/logprobs/response_format、Responses 的 previous_response_id/store、
// Anthropic 的 content block 级 cache_control 等)。跨族(openai↔anthropic)仍
// 走各路由的 Internal 管线,不经此函数。
//
// 与 dedicated-proxy.ts(ded_sk_ 一对一透传)同源,区别:
// - URL 按 clientProtocol 拼(baseUrl + 标准端点),非 dedicated 的 origin + 客户端
//   原始 path(普通密钥客户端发的是网关 path /openai/v1/...,不能直接用)。
// - 凭证来自 providers.api_key_enc(共享 provider 凭证),非 api_keys.upstream_api_key_enc。
// - body 替换虚拟 model → realModel(dedicated 透传客户端原值,因 dedicated 客户端
//   直接发真实 model)。
// usage 拆 cache / SSE 裸字节转发 / 日志四字段 / 流式不 c.set('usage') 等不变量
// 与 dedicated、三路由流式 handler 完全对齐(见 CLAUDE.md「请求日志」)。
// ─────────────────────────────────────────────────────────────────────────────

export type ClientProtocol = 'cc' | 'responses' | 'anthropic';

export interface PassthroughProviderCfg {
  baseUrl: string;
  apiKey: string;
  apiType: 'openai' | 'anthropic';
  estimateFallback: boolean;
  timeout?: number;
}

export interface PassthroughOptions {
  providerCfg: PassthroughProviderCfg;
  /** 上游真实 model 名(虚拟 model 已被 resolveModel 解析)。 */
  realModel: string;
  /** 客户端协议(决定上游端点 path):cc→/chat/completions、responses→/responses、anthropic→/v1/messages。 */
  clientProtocol: ClientProtocol;
  /** 客户端原始请求体(路由已 c.req.json() 解析);用于换 model 名 + fallback 估算 + 日志。 */
  requestBody: Record<string, unknown>;
  providerName: string;
}

// 代理链 fingerprint / hop-by-hop / 客户端凭证与 host 一律剥离(与 dedicated 一致):
// 反向代理注入的 X-Forwarded-*/CF-*/True-Client-IP 等会被上游风控识别为「转发请求」
// (直连客户端从不发这些);hop-by-hop 头不得跨代理边界;客户端凭证与 host 在下方按
// 上游族重写,避免虚拟 key 泄漏或双凭证冲突。
const STRIP_HEADERS = new Set([
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port',
  'x-real-ip', 'via', 'forwarded',
  'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'true-client-ip',
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  // body 被 passthrough 重 stringify(虚拟 model → 上游真实 model),长度变化,
  // 必须剥离让 fetch 按新 body 重算 content-length——否则透传客户端原 content-length
  // 与新 body 字节数不符,上游按旧长度等数据永远收不齐 → 不返响应头 → 客户端挂死。
  'content-length',
  'authorization', 'x-api-key', 'host',
]);

/** 按客户端协议拼上游端点 URL。baseUrl 约定与各 Provider 一致:
 *  OpenAI 系 baseUrl 含 `/v1`(拼 `/responses`、`/chat/completions`),Anthropic
 *  baseUrl 不含 `/v1`(拼 `/v1/messages`)——这是既有约定,透传沿用。 */
function passthroughUrl(baseUrl: string, protocol: ClientProtocol): string {
  const base = baseUrl.replace(/\/+$/, '');
  switch (protocol) {
    case 'cc':
      return `${base}/chat/completions`;
    case 'responses':
      return `${base}/responses`;
    case 'anthropic':
      return `${base}/v1/messages`;
  }
}

export async function passthroughUpstream(
  c: Context,
  opts: PassthroughOptions,
): Promise<Response> {
  const { providerCfg, realModel, clientProtocol, requestBody, providerName } = opts;
  const logger = getLogger();
  const startTime = Date.now();

  // 同族:调用方已判定 clientFamily === upstreamFamily,故上游族 = apiType。
  const upstreamFamily = providerCfg.apiType;
  const virtualModel = (requestBody.model as string) ?? realModel;

  // 透传仅用于三路由,路径恒为生成类;保留 isTokenGeneratingPath 防御性白名单。
  const allowFallback =
    isTokenGeneratingPath(c.req.path) && providerCfg.estimateFallback === true;

  const upstreamUrl = passthroughUrl(providerCfg.baseUrl, clientProtocol);

  // body:客户端原始 body,仅替换 model(保留 n/seed/tools/cache_control/
  // previous_response_id 等全部字段)。浅拷贝后改值——不污染 requestBody(日志仍
  // 要原始虚拟 model),且保留原字段顺序(仅在原 model 位置换值)。
  const upstreamBody: Record<string, unknown> = { ...requestBody };
  upstreamBody.model = realModel;
  const bodyText = JSON.stringify(upstreamBody);

  // headers:剥 STRIP_HEADERS 集合,保留客户端原始大小写(读 IncomingMessage.rawHeaders)。
  // content-type 因 body 重 stringify 必为 application/json(保留客户端原样名换值,没发
  // 则补);凭证保留客户端原样名,值按上游族(openai→Bearer / anthropic→bare)。改写只
  // 换值不改 key——与日志存储口径一致。anthropic-version 保留客户端原值(同族 Anthropic
  // 客户端必带);客户端未带则不补——与 dedicated 一致,不由网关决定协议版本。
  const pairs = rawHeaderPairs(c);
  const credName = detectCredentialName(pairs);
  const credValue =
    upstreamFamily === 'anthropic' ? providerCfg.apiKey : `Bearer ${providerCfg.apiKey}`;
  const hasContentType = pairs.some(([n]) => n.toLowerCase() === 'content-type');
  const rewrites: Record<string, string> = {};
  if (hasContentType) rewrites['content-type'] = 'application/json';
  if (credName) rewrites[credName.toLowerCase()] = credValue;
  const headers = buildUpstreamHeaders(pairs, STRIP_HEADERS, rewrites);
  // 兜底:客户端未发(理论不发生——authMiddleware 要求凭证,SDK 都发 content-type)
  if (!hasContentType) headers['Content-Type'] = 'application/json';
  if (!credName) {
    headers[upstreamFamily === 'anthropic' ? 'x-api-key' : 'Authorization'] = credValue;
  }

  const fetchOpts: RequestInit = {
    method: c.req.method,
    headers,
    body: bodyText,
    // timeout 由 provider 配置覆盖,默认与 dedicated/Provider 管线共享的 1h 兜底
    // (长流式由上游自返超时;k8s 需配 terminationGracePeriodSeconds: 3700)。
    signal: AbortSignal.timeout(providerCfg.timeout ?? UPSTREAM_TIMEOUT_MS),
    keepalive: false, // 避免 undici 复用已被上游关闭的 keep-alive 连接
  };

  logger.info({ upstreamUrl, protocol: clientProtocol }, 'Passthrough forwarding (same-family)');

  // fetch + 连接错误重试一次(与 dedicated 一致:stale keep-alive socket)
  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl, fetchOpts);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const connError = errMsg.includes('other side closed') || errMsg.includes('fetch failed');
    const failUsage = (): UsageData => ({
      model: virtualModel,
      provider: providerName,
      promptTokens: 0,
      completionTokens: 0,
      isError: true,
    });
    if (connError) {
      logger.warn({ upstreamUrl, errMsg }, 'Passthrough connection error, retrying...');
      try {
        upstreamRes = await fetch(upstreamUrl, fetchOpts);
      } catch (retryErr) {
        logger.error({ err: retryErr, upstreamUrl }, 'Passthrough retry failed');
        c.set('usage', failUsage());
        return c.json(
          { error: { message: 'Upstream request failed', type: 'api_connection_error' } },
          502,
        );
      }
    } else {
      logger.error({ err, upstreamUrl }, 'Passthrough upstream request failed');
      c.set('usage', failUsage());
      return c.json(
        { error: { message: 'Upstream request failed', type: 'api_connection_error' } },
        502,
      );
    }
  }

  const contentType = upstreamRes.headers.get('content-type') || '';

  // usage 基线:model 用虚拟 modelId(与三路由一致:配额/统计按客户端虚拟 model),
  // 非 upstream 返回的 model。
  const baseUsage: UsageData = {
    model: virtualModel,
    provider: providerName,
    promptTokens: 0,
    completionTokens: 0,
    isError: upstreamRes.status >= 400,
  };

  // ── 流式 SSE:裸字节转发 + finally 提 usage / 记账 ──────────────────────
  // 刻意不在此 c.set('usage'):stream() resolve 在 usageTrackMiddleware post 阶段
  // 之后,现在设占位会让中间件把 total_tokens=0 写进 usage_records,而 request_logs
  // (finally 里写真实 token)正确——正是「今日配额显示 0」的 bug。留 usage=undefined
  // 让中间件跳过,finally 自记。与 dedicated/chat-completions 流式一致。
  // 非 2xx(如 429)即使 content-type 是 text/event-stream 也走非流式分支返回真实
  // status——某些上游(OpenAI 兼容端点)对 stream 请求的限流/错误也用 SSE 包装
  // (content-type: text/event-stream + 错误 body);若进 stream() 会先发 200 头再裸
  // 字节转发错误 SSE,客户端 SDK 收到 200+SSE 开始解析却只读到错误 → 卡住(与 Internal
  // 跨族「先开流再判 429」同类坑,见「Provider 适配器」)。先看 ok 再看 content-type。
  if (upstreamRes.ok && contentType.includes('text/event-stream')) {
    // 透传上游 content-type 原值(含 `text/event-stream;charset=UTF-8` 等 charset 变体):
    // stream() 裸调 c.newResponse 不带任何头,不设则客户端收到无 content-type 的 200 流,
    // 严格按 MIME 判定 SSE 的消费方(浏览器 EventSource、部分 SDK/中间代理)会拒绝。
    // 刻意只透传这一个头,其余上游头不透传:content-encoding 已被 fetch 自动解压
    // (透传则客户端对明文再解压)、content-length 与转发字节不保证一致、上游
    // x-request-id 会与网关回显的 X-Request-ID 双 id 混淆。
    c.header('Content-Type', contentType);

    const responseHeaders: Record<string, string> = {};
    for (const [k, v] of upstreamRes.headers.entries()) responseHeaders[k] = v;

    const chunks: string[] = [];
    let chunkCount = 0;
    const streamUsage: UsageData = { ...baseUsage };
    let extracted: ExtractedUsage = {
      promptTokens: 0,
      completionTokens: 0,
      cacheRead: 0,
      cacheCreation: 0,
    };
    // 累积 assistant 文本(三种上游 SSE 内容形态都合并,与 dedicated 一致)与上游
    // 返回的 model(用于日志 responseBody,真实 model)。
    let mergedContent = '';
    let mergedModel = realModel;

    return stream(c, async (s) => {
      if (!upstreamRes.body) return;
      const reader = upstreamRes.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(new TextDecoder().decode(value));
          chunkCount++;
          await s.write(value);
        }
      } finally {
        reader.releaseLock();

        const fullText = chunks.join('');
        try {
          // 行解析用 parseSSEDataLines(与 BaseProvider 一致:兼容无空格 `data:`、
          // 逐行容错)——原先 `startsWith('data: ')` 严格匹配会漏掉无空格上游
          // (如部分兼容服务商)的终态 usage 行,且单行畸形 JSON 中断整个循环。
          for (const item of parseSSEDataLines(fullText)) {
            const json = item as Record<string, any>;
            // OpenAI CC: choices[0].delta.content
            if (json.choices?.[0]?.delta?.content) {
              mergedContent += json.choices[0].delta.content;
            }
            // Anthropic: delta.text
            if (json.delta?.text) {
              mergedContent += json.delta.text;
            }
            // OpenAI Responses: response.output_text.delta 的 delta 是裸字符串
            if (typeof json.delta === 'string') {
              mergedContent += json.delta;
            }
            if (json.model) mergedModel = json.model;
            // usage 四种上游位置:CC 顶层 usage;Responses 在 response.usage;
            // Anthropic message_delta 顶层 usage;Anthropic message_start 在 message.usage
            const u = json.usage ?? json.response?.usage ?? json.message?.usage;
            if (u && typeof u === 'object') {
              extracted = mergeStreamUsage(extracted, extractUsage(u as Record<string, unknown>));
            }
          }
          streamUsage.promptTokens = extracted.promptTokens;
          streamUsage.completionTokens = extracted.completionTokens;
          streamUsage.cacheReadTokens = extracted.cacheRead;
          streamUsage.cacheCreationTokens = extracted.cacheCreation;

          // fallback:上游未返 usage(或部分缺失)时估算,避免记 0。仅生成类 + opt-in。
          if (allowFallback && streamUsage.promptTokens === 0) {
            streamUsage.promptTokens = estimateTokensFromUnknownBody(requestBody);
          }
          if (allowFallback && streamUsage.completionTokens === 0) {
            streamUsage.completionTokens = estimateTokens(mergedContent.length);
          }
        } catch {
          // best effort:usage 提取失败不阻断流
        }

        // 合成 responseBody(对齐 dedicated 的 mergedResponseBody),四字段齐:
        // responseHeaders + responseBody + streamChunks(后 64KB) + streamChunkCount。
        const usageForLog: Record<string, number> = {
          prompt_tokens: extracted.promptTokens + extracted.cacheRead,
          completion_tokens: extracted.completionTokens,
          total_tokens: extracted.promptTokens + extracted.cacheRead + extracted.completionTokens,
        };
        if (extracted.cacheRead > 0) usageForLog.cached_tokens = extracted.cacheRead;
        const mergedResponseBody: Record<string, unknown> = {
          model: mergedModel,
          content: mergedContent,
          stream_chunk_count: chunkCount,
          usage: usageForLog,
        };

        try {
          await trackUsage(c, streamUsage);
          await persistRequestLog(c, streamUsage, requestBody, startTime, true, {
            responseHeaders,
            responseBody: mergedResponseBody,
            streamChunks: fullText.slice(-65535),
            streamChunkCount: chunkCount,
          });
        } catch (err) {
          logger.error({ err }, 'Failed to track/log passthrough streaming request');
        }
      }
    });
  }

  // ── 非流式:原样返回上游 body + 提 usage ────────────────────────────────
  const bodyBuffer = await upstreamRes.arrayBuffer();

  // 上游非 2xx(429/401/5xx)打控制台日志(与 dedicated-proxy 共用 logUpstreamError,
  // 级别策略统一:此前只落 DB 日志、控制台静默)。
  if (!upstreamRes.ok) {
    logUpstreamError('Passthrough', upstreamRes.status, {
      requestId: c.get('requestId'),
      provider: providerName,
      model: virtualModel,
      upstreamUrl,
      body: new TextDecoder().decode(bodyBuffer.slice(0, 500)),
    });
  }

  if (contentType.includes('application/json') && upstreamRes.ok) {
    try {
      const bodyJson = JSON.parse(new TextDecoder().decode(bodyBuffer)) as Record<string, unknown>;
      const usage = bodyJson.usage as Record<string, unknown> | undefined;
      if (usage) {
        const ex = extractUsage(usage);
        baseUsage.promptTokens = ex.promptTokens;
        baseUsage.completionTokens = ex.completionTokens;
        baseUsage.cacheReadTokens = ex.cacheRead;
        baseUsage.cacheCreationTokens = ex.cacheCreation;
      }
      // fallback:completion 从响应体估算(同 dedicated);prompt 在下方统一兜底。
      if (allowFallback && baseUsage.completionTokens === 0) {
        baseUsage.completionTokens = estimateTokensFromUnknownBody(bodyJson);
      }
    } catch {
      // best effort
    }
  }
  if (allowFallback && baseUsage.promptTokens === 0) {
    baseUsage.promptTokens = estimateTokensFromUnknownBody(requestBody);
  }
  c.set('usage', baseUsage);

  // 原样返回上游响应(剥 hop-by-hop / content-encoding,避免重复解压)。
  const responseHeaders = new Headers();
  for (const [k, v] of upstreamRes.headers.entries()) {
    const lower = k.toLowerCase();
    if (lower === 'transfer-encoding' || lower === 'content-encoding') continue;
    responseHeaders.set(k, v);
  }
  return new Response(bodyBuffer, { status: upstreamRes.status, headers: responseHeaders });
}
