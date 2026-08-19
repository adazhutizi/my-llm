import { Context, Next } from 'hono';
import { sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { requestLogs, requestDetails } from '../db/schema.js';
import { getLogger } from '../utils/logger.js';
import { rawHeaderPairs } from '../utils/headers.js';
import type { AuthContext } from './auth.js';
import type { UsageData } from './usage-track.js';

// ─── Exported helper for streaming handlers ─────────────────────────────────
//
// Streaming responses return via streamSSE() which resolves before the stream
// callback finishes, so the middleware post-response phase can't see `usage`.
// Stream handlers call this directly instead.

export interface ResponseLogData {
  responseBody?: unknown;
  responseHeaders?: Record<string, string>;
  streamChunks?: string;
  streamChunkCount?: number;
}

// ─── Client IP resolution ────────────────────────────────────────────────────
//
// Priority: X-Forwarded-For (first IP — handles multi-hop proxy chains) →
// X-Real-IP → direct socket remoteAddress.
//
// NB: This must be a real if/else chain, NOT a single `||` + ternary
// expression. The previous inline version was parsed (due to JS operator
// precedence: `&&` > `||` > `?:`) as
//   (xff || xRealIp || (incoming && ...)) ? remoteAddress : null
// which is true whenever `c.env.incoming` exists — and @hono/node-server
// populates it on every request. That made XFF/X-Real-IP dead code and logged
// the reverse proxy's IP for every request in production.

export function getClientIp(c: Context): string | null {
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const xRealIp = c.req.header('x-real-ip');
  if (xRealIp) return xRealIp;
  // Fallback: raw Node.js IncomingMessage socket
  // (@hono/node-server stores the IncomingMessage in c.env.incoming)
  const incoming = (c.env as Record<string, unknown> | undefined)?.incoming;
  if (incoming && typeof incoming === 'object' && 'socket' in incoming) {
    return (incoming as { socket: { remoteAddress?: string } }).socket.remoteAddress ?? null;
  }
  return null;
}

// ─── Request header capture (preserve original case) ─────────────────────────
//
// c.req.raw.headers 是 WHATWG Headers,entries() 吐出的 name 一律小写规范化
// (HTTP header 名大小写不敏感)。详细日志若要还原客户端发来的原始大小写
// (审计/展示),须改读 Node IncomingMessage.rawHeaders——@hono/node-server 把
// IncomingMessage 挂在 c.env.incoming,其 rawHeaders 是 [name,value,...] 成对
// 数组,保留原始字节大小写。无 incoming.rawHeaders(非 node-server,如单测
// app.request 不注入 c.env.incoming)时回退到小写化的 WHATWG Headers,行为同旧版。
export function captureRawRequestHeaders(c: Context): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const [name, value] of rawHeaderPairs(c)) {
    // 同名 header append(对齐 WHATWG Headers 的 ", " 合并语义)
    obj[name] = name in obj ? `${obj[name]}, ${value}` : value;
  }
  return obj;
}

export async function persistRequestLog(
  c: Context,
  usage: UsageData,
  requestBody: unknown,
  startTime: number,
  isStream: boolean,
  responseLog?: ResponseLogData,
): Promise<void> {
  const latencyMs = Date.now() - startTime;
  const auth = c.get('auth') as AuthContext | undefined;
  const requestId = c.get('requestId') as string | undefined;

  if (!auth || !requestId) return;

  const db = getDb();

  // Upsert on request_id: a client/proxy may reuse the same X-Request-ID across
  // requests (retries, connection-level caching). On conflict the later
  // request's content overwrites the earlier row instead of inserting a
  // duplicate (request_logs.request_id and request_details.request_id are both
  // UNIQUE). created_at is intentionally NOT in the update set — keep the
  // first-seen time so the row stays put in time-ordered views. The uuid
  // fallback path never collides, so its upsert is always an insert. Mirrors
  // usage-track.ts onDuplicateKeyUpdate.
  // Summary row
  await db.insert(requestLogs).values({
    requestId,
    apiKeyId: auth.keyId,
    appId: auth.appId ?? null,
    userId: auth.userId ?? null,
    appUserId: auth.appExternalUid ?? null,
    featureId: auth.featureId ?? null,
    model: usage?.model ?? null,
    provider: usage?.provider ?? null,
    statusCode: c.res.status,
    latencyMs,
    promptTokens: usage?.promptTokens ?? null,
    completionTokens: usage?.completionTokens ?? null,
    cacheReadTokens: usage?.cacheReadTokens ?? null,
    cacheCreationTokens: usage?.cacheCreationTokens ?? null,
    isStream,
    errorMessage: null,
  }).onDuplicateKeyUpdate({
    set: {
      apiKeyId: sql`VALUES(api_key_id)`,
      appId: sql`VALUES(app_id)`,
      userId: sql`VALUES(user_id)`,
      appUserId: sql`VALUES(app_user_id)`,
      featureId: sql`VALUES(feature_id)`,
      model: sql`VALUES(model)`,
      provider: sql`VALUES(provider)`,
      statusCode: sql`VALUES(status_code)`,
      latencyMs: sql`VALUES(latency_ms)`,
      promptTokens: sql`VALUES(prompt_tokens)`,
      completionTokens: sql`VALUES(completion_tokens)`,
      cacheReadTokens: sql`VALUES(cache_read_tokens)`,
      cacheCreationTokens: sql`VALUES(cache_creation_tokens)`,
      isStream: sql`VALUES(is_stream)`,
      errorMessage: sql`VALUES(error_message)`,
    },
  });

  // Full-content row
  await db.insert(requestDetails).values({
    requestId,
    apiKeyId: auth.keyId,
    requestMethod: c.req.method,
    requestPath: c.req.path,
    requestHeaders: captureRawRequestHeaders(c),
    requestBody: requestBody as Record<string, unknown> | null,
    responseStatus: c.res.status,
    responseHeaders: responseLog?.responseHeaders ?? null,
    responseBody: responseLog?.responseBody ?? null,
    streamChunks: responseLog?.streamChunks ?? null,
    streamChunkCount: responseLog?.streamChunkCount ?? null,
    latencyMs,
    clientIp: getClientIp(c),
    userAgent: c.req.header('user-agent') || null,
  }).onDuplicateKeyUpdate({
    set: {
      apiKeyId: sql`VALUES(api_key_id)`,
      requestMethod: sql`VALUES(request_method)`,
      requestPath: sql`VALUES(request_path)`,
      requestHeaders: sql`VALUES(request_headers)`,
      requestBody: sql`VALUES(request_body)`,
      responseStatus: sql`VALUES(response_status)`,
      responseHeaders: sql`VALUES(response_headers)`,
      responseBody: sql`VALUES(response_body)`,
      streamChunks: sql`VALUES(stream_chunks)`,
      streamChunkCount: sql`VALUES(stream_chunk_count)`,
      latencyMs: sql`VALUES(latency_ms)`,
      clientIp: sql`VALUES(client_ip)`,
      userAgent: sql`VALUES(user_agent)`,
      // Reset archive markers: the new content is complete and must be
      // re-evaluated for merging — a stale archived_at from the prior row would
      // otherwise hide the freshly written big fields in the logs UI.
      archivedAt: sql`NULL`,
      mergedInto: sql`NULL`,
    },
  });
}

// ─── Middleware ───────────────────────────────────────────────────────────────

export async function requestLogMiddleware(c: Context, next: Next) {
  // ── Pre-response: capture request body ─────────────────────────────────
  let requestBody: unknown = null;
  try {
    requestBody = await c.req.json();
  } catch {
    // Body isn't JSON or doesn't exist – that's fine
  }

  const startTime = Date.now();

  await next();

  // ── Post-response: persist log & detail rows ───────────────────────────
  try {
    const auth = c.get('auth') as AuthContext | undefined;
    const requestId = c.get('requestId') as string | undefined;

    // Skip logging for unauthenticated routes (e.g. /health)
    // and admin panel requests (JWT auth or /admin/* paths) — only log LLM API calls
    if (!auth || !requestId) return;
    if (auth.authMethod === 'jwt') return;
    if (c.req.path.startsWith('/admin')) return;

    const usage = c.get('usage') as UsageData | undefined;

    // Skip requests that didn't reach an LLM handler (no usage set):
    // GET /models, 404s, validation errors, etc.
    //
    // This single check ALSO covers streaming requests. Every stream handler
    // (chat-completions / responses / messages / the dedicated-proxy SSE
    // branch) deliberately leaves usage UNSET when streamSSE/stream resolves —
    // the callback that sets usage and persists the log runs only AFTER this
    // middleware's post-response phase (see dedicated-proxy.ts "Deliberately
    // do NOT c.set('usage') here"). So a streaming request has usage ===
    // undefined here and is skipped, with the stream callback doing the
    // persist itself.
    //
    // Do NOT reintroduce a `requestBody.stream` skip here. dedicated-proxy
    // branches on the UPSTREAM response content-type, not on the client's
    // stream field: when a client sends stream:true but the upstream returns
    // a non-SSE error (429 / 5xx / connection-failure JSON), dedicated-proxy
    // takes its non-streaming branch, sets usage (isError=true), and relies on
    // THIS middleware to persist the log — a requestBody.stream check would
    // skip it and silently drop the row (the "dedicated + Responses API 429
    // not logged" regression).
    if (!usage) return;

    // Capture response body & headers for non-streaming requests
    let responseBody: unknown = null;
    let responseHeaders: Record<string, string> | null = null;
    try {
      const contentType = c.res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const cloned = c.res.clone();
        responseBody = await cloned.json();
      }
      responseHeaders = Object.fromEntries(c.res.headers.entries());
    } catch {
      // Response body capture is best-effort
    }

    await persistRequestLog(c, usage, requestBody, startTime, false, {
      responseBody,
      responseHeaders: responseHeaders ?? undefined,
    });
  } catch (err) {
    getLogger().error({ err }, 'Failed to log request');
  }
}
