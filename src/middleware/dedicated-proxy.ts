import { Context, Next } from 'hono';
import { stream } from 'hono/streaming';
import type { AuthContext } from './auth.js';
import { trackUsage, type UsageData } from './usage-track.js';
import { persistRequestLog } from './request-log.js';
import { getLogger } from '../utils/logger.js';
import { UPSTREAM_TIMEOUT_MS } from '../providers/base.js';
import { estimateTokens, estimateTokensFromUnknownBody, isTokenGeneratingPath } from '../utils/token-estimate.js';
import { extractUsage, mergeStreamUsage, type ExtractedUsage } from '../services/usage-extract.js';
import { parseSSEDataLines } from '../utils/sse-parse.js';
import { rawHeaderPairs, buildUpstreamHeaders, detectCredentialName } from '../utils/headers.js';

/**
 * Dedicated (one-to-one) transparent proxy middleware.
 *
 * Intercepts requests authenticated with `ded_sk_` keys and transparently
 * forwards them to the bound upstream provider. Only the domain and API key
 * are replaced — path, headers, body, query params are preserved as-is.
 *
 * For non-dedicated keys, this middleware is a no-op (calls next()).
 */
export async function dedicatedProxyMiddleware(c: Context, next: Next) {
  const auth = c.get('auth') as AuthContext;

  // Only intercept dedicated keys
  if (auth.mode !== 'dedicated') {
    return next();
  }

  if (!auth.providerBaseUrl) {
    return c.json({ error: { message: 'Dedicated key has no bound provider', type: 'invalid_request_error' } }, 400);
  }

  const logger = getLogger();
  const startTime = Date.now();
  const providerName = auth.providerName ?? 'dedicated';

  // Best-effort: extract model name from request body for logging
  let requestModel = 'dedicated';
  let requestBodyParsed: unknown = null;
  try {
    const bodyText = await c.req.text();
    const parsed = JSON.parse(bodyText);
    requestModel = parsed.model ?? 'dedicated';
    requestBodyParsed = parsed;
  } catch {
    // Non-JSON body or missing model — keep 'dedicated'
  }

  // 1. Transparent proxy — forward original path as-is
  const path = c.req.path;
  // Token fallback estimation only applies to generation endpoints (chat
  // completions / messages / responses). Non-generation paths (count_tokens,
  // embeddings, images, models, ...) must NOT be estimated — see
  // isTokenGeneratingPath. Dedicated keys reach this middleware for ANY path
  // (including the catch-all /*), so we gate the fallback per-path here.
  // Additionally gated by a per-provider opt-in (config.estimateFallback),
  // off by default — providers that omit usage are logged with 0 tokens
  // instead of a chars→tokens estimate.
  const allowFallback = isTokenGeneratingPath(path) && auth.providerEstimateFallback === true;
  const query = c.req.url.includes('?') ? c.req.url.slice(c.req.url.indexOf('?')) : '';
  // dedicated 只取服务商地址的 origin(scheme+host+port)——baseUrl 里的路径后缀不管
  // 是什么(/v1、/api/v1、/任意/前缀)一律剥掉,只留域名(含端口)。这样同一个服务商
  // (baseUrl 带路径后缀)既能走 Provider 管线(适配器在完整 baseUrl 后拼 /responses
  // 等),也能走 dedicated 透传(客户端发完整路径,不与后缀叠成双段)。origin 永不带
  // 尾斜杠,也顺带消除「baseUrl 带尾 / + path 开头 / → //」。非法 URL 回退原值,交由
  // 下游 fetch 连接错误暴露(而非在此抛 JS 异常 → 500)。
  let upstreamOrigin = auth.providerBaseUrl;
  try {
    upstreamOrigin = new URL(auth.providerBaseUrl).origin;
  } catch {
    // provider.baseUrl 非法 URL —— 保留原值
  }
  const upstreamUrl = `${upstreamOrigin}${path}${query}`;

  // 2. Copy request headers, stripping proxy-fingerprint / hop-by-hop headers
  //    so the forwarded request looks like a direct client call:
  //    - Proxy-chain headers (X-Forwarded-*, Via, CF-*, X-Real-IP, ...) are
  //      injected by the reverse proxy in front of the gateway. Direct clients
  //      never send them, so upstream risk control treats them as a tell that
  //      the request was forwarded. This is the main reason a dedicated proxy
  //      trip upstream risk control while a direct call does not.
  //    - Hop-by-hop headers (RFC 7230) must not cross a proxy boundary.
  //    - Client credentials (authorization / x-api-key) and host are stripped
  //      here and rewritten below with the upstream key, so the ded_sk_*
  //      virtual key never leaks and two conflicting auth headers are never
  //      sent together.
  //    Gateway-own identity headers (X-App-User-Id / X-Feature-Id) are NOT
  //    stripped — dedicated (one-to-one) mode never consumes them, so a real
  //    client does not send them here anyway.
  const STRIP = new Set([
    // proxy-chain fingerprint
    'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port',
    'x-real-ip', 'via', 'forwarded',
    'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'true-client-ip',
    // hop-by-hop (RFC 7230)
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade',
    // credentials & host (rewritten below)
    'authorization', 'x-api-key', 'host',
  ]);

  // 发往上游的 header:保留客户端原始大小写(读 IncomingMessage.rawHeaders,非
  // WHATWG Headers 的小写规范化)。STRIP 剥离代理 fingerprint/hop-by-hop/凭证/host;
  // 凭证保留客户端原样 key 名(Authorization 优先,无则 x-api-key),只换值不改 key——
  // 与 request_details 日志存储的大小写口径一致。
  const pairs = rawHeaderPairs(c);
  const credName = detectCredentialName(pairs);
  const credRewrites: Record<string, string> = {};
  if (credName) {
    const bare = credName.toLowerCase() === 'x-api-key';
    credRewrites[credName.toLowerCase()] = bare
      ? (auth.upstreamApiKey ?? '')
      : `Bearer ${auth.upstreamApiKey ?? ''}`;
  }
  const headers = buildUpstreamHeaders(pairs, STRIP, credRewrites);
  if (!credName) {
    // 兜底:客户端未发凭证(理论不发生——authMiddleware 要求凭证),沿用约定大写。
    headers['Authorization'] = `Bearer ${auth.upstreamApiKey ?? ''}`;
  }

  // anthropic-version 不由网关补全——dedicated 是一对一透传，应完全以客户端为准
  // （客户端没传就让上游用其默认或报错，网关不替它决定版本，避免硬编码值过时）。

  // 3. Build upstream request
  // Use keepalive: false to avoid stale connection reuse issues
  // (Node.js undici may reuse a keep-alive connection that the upstream has closed)
  const fetchOpts: RequestInit = {
    method: c.req.method,
    headers,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    keepalive: false,
  };

  // Attach body for non-GET/HEAD requests
  // Use c.req.text() which reuses Hono's cached body parse
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    fetchOpts.body = await c.req.text();
  }

  logger.info({ upstreamUrl, method: c.req.method }, 'Dedicated proxy forwarding');

  // 4. Forward request to upstream (with retry on connection errors)
  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl, fetchOpts);
  } catch (err) {
    // Retry once on connection errors (stale keep-alive sockets)
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('other side closed') || errMsg.includes('fetch failed')) {
      logger.warn({ upstreamUrl, errMsg }, 'Dedicated proxy connection error, retrying...');
      try {
        upstreamRes = await fetch(upstreamUrl, fetchOpts);
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        logger.error({ err: retryErr, upstreamUrl, retryMsg }, 'Dedicated proxy retry also failed');
        const usage: UsageData = {
          model: requestModel,
          provider: providerName,
          promptTokens: 0,
          completionTokens: 0,
          isError: true,
        };
        c.set('usage', usage);
        return c.json({ error: { message: 'Upstream request failed', type: 'api_connection_error' } }, 502);
      }
    } else {
      logger.error({ err, upstreamUrl, errMsg }, 'Dedicated proxy upstream request failed');
      const usage: UsageData = {
        model: requestModel,
        provider: providerName,
        promptTokens: 0,
        completionTokens: 0,
        isError: true,
      };
      c.set('usage', usage);
      return c.json({ error: { message: 'Upstream request failed', type: 'api_connection_error' } }, 502);
    }
  }

  const contentType = upstreamRes.headers.get('content-type') || '';

  // 5. Try to extract usage from non-streaming JSON response
  let usageData: UsageData = {
    model: requestModel,
    provider: providerName,
    promptTokens: 0,
    completionTokens: 0,
    isError: upstreamRes.status >= 400,
  };

  // 6. Return response
  // 非 2xx(如 429)即使 content-type 是 text/event-stream 也走非流式分支返回真实
  // status——某些上游(OpenAI 兼容端点)对 stream 请求的限流/错误也用 SSE 包装
  // (content-type: text/event-stream + 错误 body);若进 stream() 会先发 200 头再裸
  // 字节转发错误 SSE,客户端 SDK 收到 200+SSE 开始解析却只读到错误 → 卡住(与 Internal
  // 跨族「先开流再判 429」同类坑,见「Provider 适配器」)。先看 ok 再看 content-type。
  if (upstreamRes.ok && contentType.includes('text/event-stream')) {
    // SSE streaming — pipe ReadableStream through, collecting chunks for logging.
    // Deliberately do NOT c.set('usage') here: usageTrackMiddleware resumes the
    // moment we return the streaming Response, BEFORE this stream callback runs.
    // Setting the zero-token placeholder now would make usageTrackMiddleware
    // persist total_tokens=0 to usage_records — while request_logs (written in
    // the finally block below with the real tokens extracted from chunks) would
    // be correct. That divergence is exactly the "today's quota shows 0 despite
    // real requests" bug. We leave usage unset so the middleware skips, and
    // persist usage_records ourselves in the finally block. Mirrors how
    // chat-completions.ts handles streaming.

    // Capture response headers for logging
    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      responseHeaders[key] = value;
    }

    const chunks: string[] = [];
    let chunkCount = 0;
    let streamUsage = { ...usageData };

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

        // Extract usage and merge content from stream chunks (best-effort)
        const fullText = chunks.join('');
        let mergedContent = '';
        let mergedModel = requestModel;
        let extracted: ExtractedUsage = {
          promptTokens: 0, completionTokens: 0, cacheRead: 0, cacheCreation: 0,
        };
        try {
          // 行解析用 parseSSEDataLines(与 BaseProvider 一致:兼容无空格 `data:`、
          // 逐行容错)——原先 `startsWith('data: ')` 严格匹配漏掉无空格上游的终态
          // usage 行,且单行畸形 JSON 中断整个循环。
          for (const item of parseSSEDataLines(fullText)) {
            const json = item as Record<string, any>;
            // Merge content deltas (OpenAI-compatible: choices[0].delta.content)
            if (json.choices?.[0]?.delta?.content) {
              mergedContent += json.choices[0].delta.content;
            }
            // Anthropic format: delta.text (delta is an object)
            if (json.delta?.text) {
              mergedContent += json.delta.text;
            }
            // OpenAI Responses format: "response.output_text.delta" events carry
            // delta as a bare string (not { text }), so merge it too.
            if (typeof json.delta === 'string') {
              mergedContent += json.delta;
            }
            if (json.model) mergedModel = json.model;
            // Extract usage from any chunk that carries it. Four upstream shapes
            // meet here (dedicated keys bind arbitrary providers):
            //  - OpenAI Chat Completions: top-level `usage`
            //  - OpenAI Responses: `response.usage` on the terminal
            //    "response.completed" event (Responses streams have NO top-level
            //    `usage`). Without this branch, dedicated Responses traffic was
            //    logged with zero tokens.
            //  - Anthropic message_delta: top-level `usage` (output-side only).
            //  - Anthropic message_start: `message.usage` (input + cache). Without
            //    this branch the input-side cache breakdown was dropped and only
            //    output was logged.
            // The two-convention cache split + streaming accumulation (non-zero
            // overwrite, so message_delta's output merges onto message_start's
            // input) live in the shared usage-extract util (mirrors openai.ts
            // splitOpenAIUsage; see usage-extract.ts).
            const u = json.usage ?? json.response?.usage ?? json.message?.usage;
            if (u && typeof u === 'object') {
              extracted = mergeStreamUsage(extracted, extractUsage(u as Record<string, unknown>));
            }
          }
          streamUsage.promptTokens = extracted.promptTokens;
          streamUsage.completionTokens = extracted.completionTokens;
          streamUsage.cacheReadTokens = extracted.cacheRead;
          streamUsage.cacheCreationTokens = extracted.cacheCreation;
          if (mergedModel !== requestModel) streamUsage.model = mergedModel;

          // Fallback: upstream didn't emit a usage chunk (or only partial) —
          // estimate from the request body / accumulated content so the request
          // isn't logged with zero tokens. Mirrors the /openai/* routes' fallback.
          // Gated by allowFallback: non-generation paths (count_tokens / images /
          // embeddings / models / ...) never get estimated — see
          // isTokenGeneratingPath. SSE only reaches here for generation endpoints
          // in practice, but the guard is defensive.
          if (allowFallback && streamUsage.promptTokens === 0) {
            streamUsage.promptTokens = estimateTokensFromUnknownBody(requestBodyParsed);
          }
          if (allowFallback && streamUsage.completionTokens === 0) {
            streamUsage.completionTokens = estimateTokens(mergedContent.length);
          }
        } catch {
          // Best effort
        }

        // Build a synthetic response body that merges all stream chunks. usage
        // is rebuilt from the extracted (cache-split) figures, matching the
        // passthrough proxy and the /openai/* routes' streaming responseBody.
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

        // Persist usage_records & request_logs after the stream completes,
        // using the real token counts extracted above. usageTrackMiddleware
        // already ran (before the stream callback) and skipped because usage
        // was left unset — so we must persist usage_records ourselves here,
        // exactly like chat-completions.ts does for streaming.
        try {
          await trackUsage(c, streamUsage);
          await persistRequestLog(c, streamUsage, requestBodyParsed, startTime, true, {
            responseHeaders,
            responseBody: mergedResponseBody,
            streamChunks: fullText.slice(-65535), // Keep last 64KB to avoid oversized logs
            streamChunkCount: chunkCount,
          });
        } catch (err) {
          logger.error({ err }, 'Failed to track/log dedicated proxy streaming request');
        }
      }
    });
  }

  // Non-streaming: try to extract token usage from response body
  const bodyBuffer = await upstreamRes.arrayBuffer();

  if (contentType.includes('application/json') && upstreamRes.ok) {
    try {
      const bodyJson = JSON.parse(new TextDecoder().decode(bodyBuffer)) as Record<string, unknown>;
      const usage = bodyJson.usage as Record<string, unknown> | undefined;
      if (usage) {
        // Same two-convention split as the streaming path (shared util). Dedicated
        // is a transparent proxy — the client still sees upstream's raw body with
        // its own cache fields; this only fixes gateway-side bookkeeping.
        const ex = extractUsage(usage);
        usageData.promptTokens = ex.promptTokens;
        usageData.completionTokens = ex.completionTokens;
        usageData.cacheReadTokens = ex.cacheRead;
        usageData.cacheCreationTokens = ex.cacheCreation;
      }
      // Update model from response if present (e.g. actual model used by upstream)
      if (bodyJson.model && typeof bodyJson.model === 'string') {
        usageData.model = bodyJson.model;
      }
      // Fallback: upstream didn't report usage (or only partial) — estimate
      // completion from the response body so the request isn't logged with
      // zero tokens. Mirrors the /openai/* routes' fallback. Gated by
      // allowFallback (see isTokenGeneratingPath).
      if (allowFallback && usageData.completionTokens === 0) {
        usageData.completionTokens = estimateTokensFromUnknownBody(bodyJson);
      }
    } catch {
      // Best effort usage extraction
    }
  }

  // Prompt fallback uses the request body (format-agnostic) and runs regardless
  // of response content-type — dedicated request bodies vary (Chat Completions
  // messages / Responses input / Anthropic messages / bare string). Gated by
  // allowFallback: this is the exact spot where count_tokens (and images / models
  // / ...) used to get their request body estimated into fake prompt tokens —
  // non-generation paths now keep promptTokens=0 instead.
  if (allowFallback && usageData.promptTokens === 0) {
    usageData.promptTokens = estimateTokensFromUnknownBody(requestBodyParsed);
  }

  c.set('usage', usageData);

  // Build response headers (skip hop-by-hop headers)
  const responseHeaders = new Headers();
  for (const [key, value] of upstreamRes.headers.entries()) {
    const lower = key.toLowerCase();
    if (lower === 'transfer-encoding' || lower === 'content-encoding') continue;
    responseHeaders.set(key, value);
  }

  return new Response(bodyBuffer, {
    status: upstreamRes.status,
    headers: responseHeaders,
  });
}
