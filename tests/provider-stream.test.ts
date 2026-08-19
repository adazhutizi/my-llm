import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAIProvider } from '../src/providers/openai.js';
import type { UpstreamRequest } from '../src/providers/base.js';
import { GatewayError } from '../src/utils/errors.js';

// BaseProvider.stream() now captures upstream response headers and exposes
// them via `streamResponseHeaders` so streaming route handlers can log them
// (parity with the dedicated transparent proxy). Verifies the capture itself
// — the route handlers only thread the value through to persistRequestLog.

const config = { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test-key' };
const req: UpstreamRequest = { url: 'https://api.openai.com/v1/responses', method: 'POST', headers: {}, body: {} };

function sseBody(chunks: string[]): string {
  return chunks.map((c) => `data: ${c}\n\n`).join('') + 'data: [DONE]\n\n';
}

function mockStream(headers: Record<string, string>, chunks: string[]) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    status: 200,
    ok: true,
    headers: new Headers(headers),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseBody(chunks)));
        controller.close();
      },
    }),
  }));
}

function mockErrorStream(status: number, statusText: string, body: string) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    status,
    ok: false,
    statusText,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => body,
  }));
}

describe('BaseProvider.stream response-header capture', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('exposes upstream response headers after the stream runs', async () => {
    mockStream({ 'content-type': 'text/event-stream', 'x-request-id': 'req-abc' }, [
      JSON.stringify({ type: 'response.output_text.delta', delta: 'Hi' }),
    ]);

    const provider = new OpenAIProvider(config);
    expect(provider.streamResponseHeaders).toBeNull();

    const out: unknown[] = [];
    for await (const chunk of provider.stream(req)) out.push(chunk);

    expect(provider.streamResponseHeaders).toMatchObject({
      'content-type': 'text/event-stream',
      'x-request-id': 'req-abc',
    });
    expect(out).toHaveLength(1);
  });

  it('still yields the parsed data chunks', async () => {
    mockStream({ 'content-type': 'text/event-stream' }, [
      JSON.stringify({ type: 'response.output_text.delta', delta: 'Hello' }),
      JSON.stringify({ type: 'response.output_text.delta', delta: ' world' }),
    ]);

    const provider = new OpenAIProvider(config);
    const deltas: string[] = [];
    for await (const chunk of provider.stream(req)) {
      const d = (chunk as { data: { delta?: string } }).data;
      if (d.delta) deltas.push(d.delta);
    }

    expect(deltas).toEqual(['Hello', ' world']);
    expect(provider.streamResponseHeaders).toMatchObject({ 'content-type': 'text/event-stream' });
  });

  it('throws on a non-2xx upstream response, surfacing status + body', async () => {
    // Regression: a 4xx/5xx response carries a JSON body, not SSE `data:` lines,
    // so the old stream() silently yielded nothing and every caller saw an empty
    // stream with no cause (analysis agent: "分析模型流式响应为空"). It must read
    // the body and throw a GatewayError carrying the real status + message.
    mockErrorStream(
      400,
      'Bad Request',
      JSON.stringify({ error: { message: 'model does not support reasoning', type: 'invalid_request_error' } }),
    );

    const provider = new OpenAIProvider(config);
    let err: unknown;
    try {
      for await (const _ of provider.stream(req)) {
        /* drain — expect none */
      }
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(GatewayError);
    expect((err as Error).message).toMatch(/400/);
    expect((err as Error).message).toMatch(/model does not support reasoning/);
    // Headers were still captured (error responses carry useful headers too).
    expect(provider.streamResponseHeaders).toMatchObject({ 'content-type': 'application/json' });
    // Carries the real upstream status so routes return it verbatim (not a blanket 502).
    expect((err as GatewayError).statusCode).toBe(400);
  });

  it('openStream() rejects at the response-head stage, 4xx verbatim and 5xx→502', async () => {
    // Internal routes await openStream() BEFORE opening their own SSE stream, so a
    // non-2xx upstream must reject here (not yield an empty stream) carrying the
    // real status: 429 stays 429, 5xx maps to 502. This is the lever that lets the
    // routes return a proper HTTP error instead of a 200 stream they can't take
    // back (the "非一对一key，上游429，下游无响应" bug).
    const provider = new OpenAIProvider(config);

    // 429 → 429 (4xx verbatim, not remapped).
    mockErrorStream(429, 'Too Many Requests', JSON.stringify({ error: { message: 'rate limited' } }));
    let err429: unknown;
    try {
      await provider.openStream(req);
    } catch (e) {
      err429 = e;
    }
    expect(err429).toBeInstanceOf(GatewayError);
    expect((err429 as GatewayError).statusCode).toBe(429);
    // Headers captured even on rejection (error responses carry useful headers).
    expect(provider.streamResponseHeaders).toMatchObject({ 'content-type': 'application/json' });

    // 500 → 502 (5xx maps to Bad Gateway, matching the non-streaming route branch).
    mockErrorStream(500, 'Internal Server Error', '<html>upstream crashed</html>');
    let err500: unknown;
    try {
      await provider.openStream(req);
    } catch (e) {
      err500 = e;
    }
    expect((err500 as GatewayError).statusCode).toBe(502);
  });
});
