import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { UpstreamStreamChunk } from '../src/providers/base.js';
import { GatewayError, GatewayErrorCode } from '../src/utils/errors.js';

// Mock the model router and provider (same pattern as the openai route tests).
vi.mock('../src/services/model-router.js', () => ({
  resolveModel: vi.fn(),
  getProviderConfig: vi.fn(),
  createProvider: vi.fn(),
}));

// 路由 ≥400 分支与流式 openStream catch 现会经 getLogger/logUpstreamError 打
// 控制台日志;getLogger 未初始化会抛错,mock 成 no-op(惯例见 passthrough.test.ts)。
vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  }),
}));

import { messages } from '../src/routes/anthropic/messages.js';
import { resolveModel, getProviderConfig, createProvider } from '../src/services/model-router.js';

const mockedResolveModel = vi.mocked(resolveModel);
const mockedGetProviderConfig = vi.mocked(getProviderConfig);
const mockedCreateProvider = vi.mocked(createProvider);

/** Parse an SSE response body into a list of JSON payloads (skips event lines). */
function parseSSE(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split('\n')) {
    const payload = line.startsWith('data: ') ? line.slice(6) : line.startsWith('data:') ? line.slice(5) : null;
    if (payload === null) continue;
    if (payload === '[DONE]') continue;
    try {
      out.push(JSON.parse(payload));
    } catch {
      // skip malformed/empty lines
    }
  }
  return out;
}

/** Build a mock provider whose stream() yields the given raw upstream chunks. */
function makeProvider(
  transform: (chunk: UpstreamStreamChunk) => any,
  rawChunks: UpstreamStreamChunk[],
) {
  return {
    transformRequest: vi.fn().mockReturnValue({ url: 'http://test', method: 'POST', headers: {}, body: {} }),
    openStream: vi.fn(async () => {
      async function* gen() {
        for (const c of rawChunks) yield c;
      }
      return gen();
    }),
    transformStreamChunk: vi.fn((chunk: UpstreamStreamChunk) => transform(chunk)),
  };
}

describe('POST /anthropic/v1/messages (streaming)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/', messages);

    mockedResolveModel.mockResolvedValue({
      provider: 'anthropic',
      realModel: 'claude-sonnet-4-test',
      fallbacks: null,
    });
    // 故意把上游 apiType 设成与 Anthropic 客户端不同的族('openai'),使路由走跨族
    // Internal 管线(createProvider → transformStreamChunk)。同族('anthropic')会走
    // passthrough 透传不经 createProvider,测不到 Internal 断言——同族透传由
    // passthrough.test.ts 覆盖。此处测路由消费 InternalStreamChunk 的逻辑,与上游
    // 真实 provider 类无关(provider 被 mock)。
    mockedGetProviderConfig.mockResolvedValue({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-test',
      apiType: 'openai',
      estimateFallback: false,
    });
  });

  it('streams a text response with a lazily-opened text block', async () => {
    // Regression: a pure-text stream must still open exactly one text block
    // (lazily on the first delta, not hardcoded up front), stream text_deltas
    // into it, and close it at stop.
    const provider = makeProvider(
      (chunk) => {
        const d = chunk.data as any;
        if (d.type === 'message_start') {
          return { type: 'usage', usage: { promptTokens: 10, completionTokens: 0, cacheRead: 0, cacheCreation: 0, totalTokens: 10 } };
        }
        if (d.type === 'content_block_delta' && d.delta?.text) {
          return { type: 'content', content: { type: 'text', text: d.delta.text } };
        }
        if (d.type === 'message_delta') {
          return { type: 'stop', stopReason: 'end_turn', usage: { promptTokens: 0, completionTokens: 5, totalTokens: 5 } };
        }
        return null;
      },
      [
        { data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } } },
        { data: { type: 'content_block_delta', delta: { text: 'Hello' } } },
        { data: { type: 'content_block_delta', delta: { text: ' world' } } },
        { data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } },
      ],
    );
    mockedCreateProvider.mockReturnValue(provider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-test', messages: [{ role: 'user', content: 'Hi' }], stream: true }),
    });

    expect(res.status).toBe(200);
    const events = parseSSE(await res.text());
    const types = events.map((e) => e.type);

    expect(types).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    // Text block opened at index 0, deltas target index 0.
    const blockStart = events.find((e) => e.type === 'content_block_start');
    expect(blockStart.index).toBe(0);
    expect(blockStart.content_block).toEqual({ type: 'text', text: '' });
    const deltas = events.filter((e) => e.type === 'content_block_delta');
    expect(deltas.every((d) => d.index === 0)).toBe(true);
  });

  it('synthesizes a tool_use content block lifecycle for a streaming tool_call', async () => {
    // Pure tool_use stream: the provider surfaces a complete tool_call chunk
    // (as AnthropicProvider does at content_block_stop). The route must
    // synthesize content_block_start(tool_use) → input_json_delta(complete) →
    // content_block_stop, with NO text block, and stop_reason='tool_use'.
    const provider = makeProvider(
      (chunk) => {
        const d = chunk.data as any;
        if (d.type === 'message_start') {
          return { type: 'usage', usage: { promptTokens: 12, completionTokens: 0, cacheRead: 0, cacheCreation: 0, totalTokens: 12 } };
        }
        // Mock mirrors AnthropicProvider: accumulates internally and emits the
        // complete tool_call at content_block_stop (input_json_delta is null).
        if (d.type === 'content_block_stop') {
          return { type: 'tool_call', toolCall: { id: 'toolu_1', name: 'get_weather', input: { city: 'NYC' } } };
        }
        if (d.type === 'message_delta') {
          return { type: 'stop', stopReason: 'tool_use', usage: { promptTokens: 0, completionTokens: 8, totalTokens: 8 } };
        }
        return null;
      },
      [
        { data: { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } } },
        { data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} } } },
        { data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":"NYC"}' } } },
        { data: { type: 'content_block_stop', index: 0 } },
        { data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } } },
      ],
    );
    mockedCreateProvider.mockReturnValue(provider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-test',
        messages: [{ role: 'user', content: 'weather in NYC?' }],
        tools: [{ name: 'get_weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const events = parseSSE(await res.text());
    const types = events.map((e) => e.type);

    // No text block — message_start → tool_use block lifecycle → message_delta → message_stop
    expect(types).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    const blockStart = events.find((e) => e.type === 'content_block_start');
    expect(blockStart.content_block).toEqual({ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} });

    // input_json_delta carries the complete JSON in a single shot (no incremental streaming).
    const jsonDelta = events.find((e) => e.type === 'content_block_delta');
    expect(jsonDelta.delta).toEqual({ type: 'input_json_delta', partial_json: '{"city":"NYC"}' });

    const msgDelta = events.find((e) => e.type === 'message_delta');
    expect(msgDelta.delta.stop_reason).toBe('tool_use');
  });

  it('closes the text block before opening a tool_use block (mixed stream)', async () => {
    // Text followed by a tool_call: the route must assign distinct indices
    // (text=0, tool_use=1) and close the text block (content_block_stop @0)
    // BEFORE opening the tool_use block (@1).
    const provider = makeProvider(
      (chunk) => {
        const d = chunk.data as any;
        if (d.type === 'message_start') {
          return { type: 'usage', usage: { promptTokens: 10, completionTokens: 0, cacheRead: 0, cacheCreation: 0, totalTokens: 10 } };
        }
        if (d.type === 'content_block_delta' && d.delta?.text) {
          return { type: 'content', content: { type: 'text', text: d.delta.text } };
        }
        if (d.type === 'content_block_stop') {
          return { type: 'tool_call', toolCall: { id: 'toolu_1', name: 'get_weather', input: { city: 'NYC' } } };
        }
        if (d.type === 'message_delta') {
          return { type: 'stop', stopReason: 'tool_use', usage: { promptTokens: 0, completionTokens: 12, totalTokens: 12 } };
        }
        return null;
      },
      [
        { data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } } },
        { data: { type: 'content_block_delta', delta: { text: 'Let me check.' } } },
        { data: { type: 'content_block_stop' } },
        { data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } } },
      ],
    );
    mockedCreateProvider.mockReturnValue(provider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-test',
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
        stream: true,
      }),
    });

    const events = parseSSE(await res.text());

    // Two content blocks: text (index 0) then tool_use (index 1).
    const blockStarts = events.filter((e) => e.type === 'content_block_start');
    expect(blockStarts).toHaveLength(2);
    expect(blockStarts[0]).toMatchObject({ index: 0, content_block: { type: 'text' } });
    expect(blockStarts[1]).toMatchObject({ index: 1, content_block: { type: 'tool_use', id: 'toolu_1' } });

    // The text block_stop (index 0) must precede the tool_use block_start (index 1).
    const stop0Idx = events.findIndex((e) => e.type === 'content_block_stop' && e.index === 0);
    const toolStartIdx = events.findIndex((e) => e.type === 'content_block_start' && e.index === 1);
    expect(stop0Idx).toBeGreaterThanOrEqual(0);
    expect(toolStartIdx).toBeGreaterThan(stop0Idx);
  });

  it('returns HTTP 429 (not a 200 stream) when the upstream rejects at the response-head stage', async () => {
    // Regression (非一对一 key 上游 429 下游无响应): 路由先 await openStream(),
    // 上游 429 在响应头阶段(~100ms)即抛错,路由不开 SSE 流,直接返 HTTP 429 +
    // JSON 错误(c.set usage isError=true 让 requestLog 中间件落日志)。原先先开
    // 200 流再 fetch,429 时 200 头已发无法回退,catch 写的 error chunk 缺
    // finish_reason → SDK 丢弃内容返回 null → 下游"无响应"。
    const provider = {
      transformRequest: vi.fn().mockReturnValue({ url: 'http://test', method: 'POST', headers: {}, body: {} }),
      openStream: vi.fn().mockRejectedValue(
        new GatewayError(GatewayErrorCode.PROVIDER_ERROR, '上游流式请求失败 (429 Too Many Requests): rate limited', 429),
      ),
      transformStreamChunk: vi.fn(),
    };
    mockedCreateProvider.mockReturnValue(provider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-test', messages: [{ role: 'user', content: 'Hi' }], stream: true }),
    });

    // HTTP 429 — NOT a 200 text/event-stream that can't be taken back.
    expect(res.status).toBe(429);
    // Body is an Anthropic JSON error envelope (parseable), not an SSE stream.
    const body = await res.json();
    expect(body.type).toBe('error');
    expect(body.error).toBeDefined();
    expect(JSON.stringify(body)).not.toContain('[DONE]');
  });

  it('marks usage isError=true on non-streaming upstream errors so the log row is persisted', async () => {
    // Regression (上游 401 时日志表无记录): 非流式分支上游 ≥400 直接 return,
    // 若不 c.set('usage'),requestLogMiddleware 按 usage===undefined 判为
    // 「流式/未到达 handler」跳过落库 → /logs 看不到这条 401。此处以 post 阶段
    // 读 c.get('usage') 的中间件模拟 requestLogMiddleware 的读取口径。
    const mockProvider = {
      transformRequest: vi.fn().mockReturnValue({ url: 'http://test', method: 'POST', headers: {}, body: {} }),
      send: vi.fn().mockResolvedValue({
        status: 401,
        headers: {},
        body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
      }),
    };
    mockedCreateProvider.mockReturnValue(mockProvider as any);

    const appWithUsageCapture = new Hono();
    let capturedUsage: any = 'unset';
    appWithUsageCapture.use(async (c, next) => {
      await next();
      capturedUsage = c.get('usage');
    });
    appWithUsageCapture.route('/', messages);

    const res = await appWithUsageCapture.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-test', max_tokens: 64, messages: [{ role: 'user', content: 'Hi' }] }),
    });

    expect(res.status).toBe(401);
    // usage 被设置(非 undefined)且标记 isError → requestLog 中间件会落库。
    expect(capturedUsage).toBeDefined();
    expect(capturedUsage.isError).toBe(true);
    expect(capturedUsage.model).toBe('claude-test');
    expect(capturedUsage.provider).toBe('anthropic');
    expect(capturedUsage.promptTokens).toBe(0);
    expect(capturedUsage.completionTokens).toBe(0);
  });
});
