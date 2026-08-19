import type {
  InternalRequest,
  InternalResponse,
  InternalStreamChunk,
} from '../types/internal.js';
import { GatewayError, GatewayErrorCode, type GatewayStatusCode } from '../utils/errors.js';

/**
 * Hard safety-net timeout for a single upstream request/stream: 1 hour.
 * Intentionally high — the upstream provider returns its own timeout/error well
 * before this; the gateway must not be the one that truncates a legitimately
 * long streaming generation. Acts as a unified default across the dedicated
 * transparent proxy and the Provider pipeline.
 */
export const UPSTREAM_TIMEOUT_MS = 60 * 60 * 1000;

export interface UpstreamRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body: unknown;
}

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface UpstreamStreamChunk {
  data: unknown;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  timeout?: number;
  maxRetries?: number;
}

export interface ProviderAdapter {
  name: string;

  transformRequest(request: InternalRequest): UpstreamRequest;
  transformResponse(response: UpstreamResponse): InternalResponse;
  transformStreamChunk(chunk: UpstreamStreamChunk): InternalStreamChunk | null;

  send(request: UpstreamRequest): Promise<UpstreamResponse>;
  /**
   * Fetch the upstream and return its SSE body iterator ONLY on a 2xx response.
   * A non-2xx response is read and thrown (carrying the real status) BEFORE the
   * caller opens a stream — used by Internal routes to decide streaming-vs-error
   * at the response-HEAD stage, mirroring dedicated/passthrough.
   */
  openStream(request: UpstreamRequest): Promise<AsyncIterable<UpstreamStreamChunk>>;
  stream(request: UpstreamRequest): AsyncIterable<UpstreamStreamChunk>;
  // Upstream response headers captured at the start of stream() — exposed so
  // streaming route handlers can log them, matching the dedicated transparent
  // proxy (which records upstream headers verbatim). null before stream()
  // runs, or when the upstream fetch threw before any response arrived.
  streamResponseHeaders?: Record<string, string> | null;
}

export abstract class BaseProvider implements ProviderAdapter {
  abstract name: string;
  streamResponseHeaders: Record<string, string> | null = null;

  constructor(protected config: ProviderConfig) {}

  abstract transformRequest(request: InternalRequest): UpstreamRequest;
  abstract transformResponse(response: UpstreamResponse): InternalResponse;
  abstract transformStreamChunk(chunk: UpstreamStreamChunk): InternalStreamChunk | null;

  async send(request: UpstreamRequest): Promise<UpstreamResponse> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(this.config.timeout || UPSTREAM_TIMEOUT_MS),
    });

    // 先读文本再 JSON.parse 容错:上游 4xx/5xx 错误体可能不是合法 JSON
    // (空 body / HTML 错误页 / 纯文本),原 response.json() 会抛 SyntaxError
    // 绕过路由的 status>=400 检查导致返 500。失败时回退原始文本,路由仍能按
    // 真实 status 返回。
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    };
  }

  /**
   * Fetch the upstream and return its SSE body iterator ONLY on a 2xx response.
   * A non-2xx response is read and thrown here — at the response-HEAD stage,
   * BEFORE the caller opens an SSE stream — carrying the real status so the
   * route returns a proper HTTP error (429→429, 5xx→502) instead of starting a
   * 200 stream it can't take back. This mirrors how dedicated-proxy.ts /
   * passthrough.ts decide streaming-vs-error from the upstream response before
   * flushing any SSE head.
   *
   * Historical note (preserved from the old stream()): surfacing non-2xx here —
   * rather than silently yielding an empty stream — fixed the analysis agent
   * throwing "分析模型流式响应为空" with no clue why (reasoning param rejected
   * 400, /responses endpoint unsupported 404, rate-limited 429, upstream 5xx).
   */
  async openStream(request: UpstreamRequest): Promise<AsyncIterable<UpstreamStreamChunk>> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: {
        ...request.headers,
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(this.config.timeout || UPSTREAM_TIMEOUT_MS),
    });

    // Capture upstream response headers for the request log (parity with the
    // dedicated transparent proxy). Assigned before the !ok check below throws,
    // so a caller reading this after openStream() rejects still sees the error
    // response's headers; stays null if fetch threw above (no upstream response).
    this.streamResponseHeaders = Object.fromEntries(response.headers.entries());

    if (!response.ok) {
      let bodyText = '';
      try {
        bodyText = await response.text();
      } catch {
        /* body unreadable / already consumed — best-effort */
      }
      throw new GatewayError(
        GatewayErrorCode.PROVIDER_ERROR,
        `上游流式请求失败 (${response.status}${response.statusText ? ' ' + response.statusText : ''}): ${bodyText.slice(0, 500)}`,
        // Carry the real upstream status, aligned with the non-streaming route
        // branches (`status >= 500 ? 502 : status`), so the route returns it
        // verbatim instead of a blanket 502.
        (response.status >= 500 ? 502 : response.status) as GatewayStatusCode,
      );
    }

    if (!response.body) {
      throw new Error('No response body for streaming');
    }

    return this.iterateSseBody(response.body);
  }

  /**
   * Parse an upstream SSE body into UpstreamStreamChunk items. Shared by
   * openStream() and stream(). Line parsing mirrors parseSSEDataLines
   * semantics: lenient `data:` prefix (with or without trailing space), per-
   * line try/catch so one malformed line doesn't abort the rest, `[DONE]`
   * terminates the stream.
   */
  private async *iterateSseBody(body: ReadableStream<Uint8Array>): AsyncIterable<UpstreamStreamChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data:')) {
            const data = line.startsWith('data: ') ? line.substring(6) : line.substring(5);
            if (data === '[DONE]') return;

            try {
              yield { data: JSON.parse(data) };
            } catch {
              // Skip malformed JSON
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Kept for gateway-model.ts (for-await provider.stream()) and legacy callers.
   * Implemented via openStream() so the status-check + header-capture behaviour
   * is identical; a non-2xx upstream response still throws here and surfaces to
   * gateway-model → analysis.ts (which emits an SSE error and ignores status).
   */
  async *stream(request: UpstreamRequest): AsyncIterable<UpstreamStreamChunk> {
    const iter = await this.openStream(request);
    for await (const chunk of iter) {
      yield chunk;
    }
  }
}
