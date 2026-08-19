import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { UpstreamStreamChunk } from '../src/providers/base.js';
import { GatewayError, GatewayErrorCode } from '../src/utils/errors.js';

// Mock the model router and provider (same pattern as openai-responses-route.test.ts)
vi.mock('../src/services/model-router.js', () => ({
  resolveModel: vi.fn(),
  getProviderConfig: vi.fn(),
  createProvider: vi.fn(),
}));

import { chatCompletions } from '../src/routes/openai/chat-completions.js';
import { resolveModel, getProviderConfig, createProvider } from '../src/services/model-router.js';

const mockedResolveModel = vi.mocked(resolveModel);
const mockedGetProviderConfig = vi.mocked(getProviderConfig);
const mockedCreateProvider = vi.mocked(createProvider);

/** Parse an SSE response body into a list of JSON payloads (skips [DONE]). */
function parseSSE(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split('\n')) {
    const payload = line.startsWith('data: ') ? line.slice(6) : line.startsWith('data:') ? line.slice(5) : null;
    if (payload === null) continue;
    if (payload === '[DONE]') continue;
    out.push(JSON.parse(payload));
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

describe('POST /openai/v1/chat/completions (streaming)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/', chatCompletions);

    mockedResolveModel.mockResolvedValue({ provider: 'openai', realModel: 'gpt-4', fallbacks: null });
    // 故意把上游 apiType 设成与 CC 客户端不同的族('anthropic'),使路由走跨族
    // Internal 管线(createProvider → transformStreamChunk)。同族('openai')会走
    // passthrough 透传不经 createProvider,测不到 Internal 断言——同族透传由
    // passthrough.test.ts 覆盖。此处测路由消费 InternalStreamChunk 的逻辑,与上游
    // 真实 provider 类无关(provider 被 mock)。
    mockedGetProviderConfig.mockResolvedValue({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      apiType: 'anthropic',
      estimateFallback: false,
    });
  });

  it('emits a finish_reason chunk on the terminal usage path (OpenAI response.completed)', async () => {
    // Regression: OpenAI's response.completed is terminal AND carries usage, so
    // OpenAIProvider returns {type:'usage', stopReason}. The route MUST emit a
    // finish_reason chunk from the usage branch — previously it only emitted
    // finish_reason on {type:'stop'}, which never fired here, so the stream
    // ended with no finish_reason and SDKs returned null content.
    const provider = makeProvider(
      (chunk) => {
        const d = chunk.data as any;
        if (d.type === 'response.output_text.delta') {
          return { type: 'content', content: { type: 'text', text: d.delta } };
        }
        if (d.type === 'response.completed') {
          return {
            type: 'usage',
            stopReason: 'end_turn',
            usage: { promptTokens: 5, completionTokens: 3, cacheRead: 0, totalTokens: 8 },
          };
        }
        return null;
      },
      [
        { data: { type: 'response.output_text.delta', delta: 'Hello' } },
        { data: { type: 'response.output_text.delta', delta: ' world' } },
        { data: { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 3 } } } },
      ],
    );
    mockedCreateProvider.mockReturnValue(provider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }], stream: true }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);

    const chunks = parseSSE(text);

    // content deltas forwarded
    const deltas = chunks
      .filter((c) => c.choices?.[0]?.delta?.content)
      .map((c) => c.choices[0].delta.content);
    expect(deltas).toEqual(['Hello', ' world']);

    // EXACTLY ONE chunk carries finish_reason, and it is 'stop'
    const finishReasons = chunks
      .map((c) => c.choices?.[0]?.finish_reason)
      .filter((r) => r !== undefined && r !== null);
    expect(finishReasons).toEqual(['stop']);

    // usage chunk emitted (empty choices)
    const usageChunk = chunks.find((c) => c.usage);
    expect(usageChunk).toBeDefined();
    expect(usageChunk.usage.total_tokens).toBe(8);
    expect(usageChunk.choices).toEqual([]);
  });

  it('emits finish_reason on the stop path (no usage)', async () => {
    // When the terminal event has no usage, OpenAIProvider returns {type:'stop'}.
    // finish_reason must still be emitted from the stop branch.
    const provider = makeProvider(
      (chunk) => {
        const d = chunk.data as any;
        if (d.type === 'response.output_text.delta') {
          return { type: 'content', content: { type: 'text', text: d.delta } };
        }
        if (d.type === 'response.completed') {
          return { type: 'stop', stopReason: 'end_turn' };
        }
        return null;
      },
      [
        { data: { type: 'response.output_text.delta', delta: 'Hi' } },
        { data: { type: 'response.completed', response: { status: 'completed', output: [] } } },
      ],
    );
    mockedCreateProvider.mockReturnValue(provider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }], stream: true }),
    });

    const chunks = parseSSE(await res.text());
    const finishReasons = chunks
      .map((c) => c.choices?.[0]?.finish_reason)
      .filter((r) => r !== undefined && r !== null);
    expect(finishReasons).toEqual(['stop']);
  });

  it('does NOT emit finish_reason from a non-terminal usage chunk (Anthropic message_start shape)', async () => {
    // When chat-completions proxies an Anthropic upstream, message_start yields
    // a usage chunk with NO stopReason (input-side usage at stream start). The
    // route must not emit finish_reason there — only from the later terminal
    // stop chunk (message_delta). Guards against double/early finish_reason.
    const provider = makeProvider(
      (chunk) => {
        const d = chunk.data as any;
        if (d.type === 'message_start') {
          return { type: 'usage', usage: { promptTokens: 10, completionTokens: 0, cacheRead: 0, totalTokens: 10 } };
        }
        if (d.type === 'content_block_delta') {
          return { type: 'content', content: { type: 'text', text: d.delta.text } };
        }
        if (d.type === 'message_delta') {
          return { type: 'stop', stopReason: 'end_turn', usage: { promptTokens: 0, completionTokens: 2, totalTokens: 2 } };
        }
        return null;
      },
      [
        { data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } } },
        { data: { type: 'content_block_delta', delta: { text: 'Hi' } } },
        { data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } } },
      ],
    );
    mockedCreateProvider.mockReturnValue(provider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }], stream: true }),
    });

    const chunks = parseSSE(await res.text());
    const finishReasons = chunks
      .map((c) => c.choices?.[0]?.finish_reason)
      .filter((r) => r !== undefined && r !== null);
    // Exactly one, from the terminal stop — not from message_start usage.
    expect(finishReasons).toEqual(['stop']);
  });

  it('forwards a function_call as a streaming tool_calls delta before finish_reason', async () => {
    // response.output_item.done for a function_call is surfaced as a tool_call
    // chunk by OpenAIProvider.transformStreamChunk; response.completed carries
    // usage + stopReason='tool_use'. The route must emit a tool_calls delta
    // (full arguments in one chunk — no incremental streaming) BEFORE the
    // finish_reason='tool_calls' chunk.
    const provider = makeProvider(
      (chunk) => {
        const d = chunk.data as any;
        if (d.type === 'response.output_item.done') {
          const item = d.item;
          if (item?.type === 'function_call') {
            let input: any = {};
            try { input = JSON.parse(item.arguments || '{}'); } catch { input = {}; }
            return { type: 'tool_call', toolCall: { id: item.call_id, name: item.name, input } };
          }
          return null;
        }
        if (d.type === 'response.completed') {
          return {
            type: 'usage',
            stopReason: 'tool_use',
            usage: { promptTokens: 10, completionTokens: 4, cacheRead: 0, totalTokens: 14 },
          };
        }
        return null;
      },
      [
        { data: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"NYC"}' } } },
        { data: { type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"NYC"}' }], usage: { input_tokens: 10, output_tokens: 4 } } } },
      ],
    );
    mockedCreateProvider.mockReturnValue(provider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'weather in NYC?' }],
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const chunks = parseSSE(await res.text());

    // Exactly one tool_calls delta carrying the complete function call.
    const toolCallChunks = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls);
    expect(toolCallChunks).toHaveLength(1);
    expect(toolCallChunks[0].choices[0].delta.tool_calls[0]).toEqual({
      index: 0,
      id: 'call_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
    });

    // Exactly one finish_reason, and it's 'tool_calls'.
    const finishReasons = chunks
      .map((c) => c.choices?.[0]?.finish_reason)
      .filter((r) => r !== undefined && r !== null);
    expect(finishReasons).toEqual(['tool_calls']);

    // The tool_calls delta must precede the finish_reason chunk.
    const toolCallIdx = chunks.findIndex((c) => c.choices?.[0]?.delta?.tool_calls);
    const finishIdx = chunks.findIndex((c) => c.choices?.[0]?.finish_reason === 'tool_calls');
    expect(toolCallIdx).toBeGreaterThanOrEqual(0);
    expect(finishIdx).toBeGreaterThan(toolCallIdx);
  });

  it('returns a complete chat.completion for non-streaming requests', async () => {
    const provider = {
      transformRequest: vi.fn().mockReturnValue({ url: 'http://test', method: 'POST', headers: {}, body: {} }),
      send: vi.fn().mockResolvedValue({
        status: 200,
        headers: {},
        body: { id: 'resp_1', model: 'gpt-4', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello!' }] }], usage: { input_tokens: 5, output_tokens: 3 } },
      }),
      transformResponse: vi.fn().mockReturnValue({
        id: 'resp_1',
        model: 'gpt-4',
        content: [{ type: 'text', text: 'Hello!' }],
        stopReason: 'end_turn',
        usage: { promptTokens: 5, completionTokens: 3, cacheRead: 0, totalTokens: 8 },
      }),
    };
    mockedCreateProvider.mockReturnValue(provider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.content).toBe('Hello!');
    expect(body.choices[0].finish_reason).toBe('stop');
  });

  it('normalizes CC tool_calls / tool results to internal tool_use / tool_result blocks (cross-family → Anthropic)', async () => {
    // CC 协议:assistant 工具调用是顶层 tool_calls、工具结果是 {role:'tool',
    // tool_call_id, content}。Internal/Anthropic 要 tool_use 在 content block
    // 中、tool_result 带 tool_use_id。跨族 CC→Anthropic 若不归一化,assistant
    // 的 tool_calls 被丢、tool 的 tool_call_id 被丢 → 多轮 agent 链断裂。
    const provider = {
      transformRequest: vi.fn().mockReturnValue({ url: 'http://test', method: 'POST', headers: {}, body: {} }),
      send: vi.fn().mockResolvedValue({
        status: 200,
        headers: {},
        body: { id: 'resp_2', model: 'gpt-4', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }], usage: { input_tokens: 10, output_tokens: 2 } },
      }),
      transformResponse: vi.fn().mockReturnValue({
        id: 'resp_2',
        model: 'gpt-4',
        content: [{ type: 'text', text: 'OK' }],
        stopReason: 'end_turn',
        usage: { promptTokens: 10, completionTokens: 2, cacheRead: 0, totalTokens: 12 },
      }),
    };
    mockedCreateProvider.mockReturnValue(provider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [
          { role: 'user', content: 'weather in NYC?' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: 'Sunny, 72F' },
        ],
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
      }),
    });

    expect(res.status).toBe(200);
    // 关键断言:CC 顶层 tool_calls / tool_call_id 已归一化为 internal 的
    // tool_use / tool_result content blocks(不再丢失)。
    expect(provider.transformRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'weather in NYC?' }] }),
          expect.objectContaining({
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'NYC' } }],
          }),
          expect.objectContaining({
            role: 'tool',
            content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Sunny, 72F' }],
          }),
        ],
      }),
    );
  });

  it('normalizes CC image_url content parts to internal image blocks (cross-family → Anthropic)', async () => {
    // CC image_url part(http URL 或 data:base64)须归一化为 Internal image
    // block,否则跨族 Anthropic 上游不认 image_url part → 图片被忽略。data: 拆
    // base64,http URL 保留为 url 形态(不下载)。
    const provider = {
      transformRequest: vi.fn().mockReturnValue({ url: 'http://test', method: 'POST', headers: {}, body: {} }),
      send: vi.fn().mockResolvedValue({
        status: 200,
        headers: {},
        body: { id: 'r', model: 'gpt-4', output: [{ type: 'message', content: [{ type: 'output_text', text: 'a cat' }] }], usage: { input_tokens: 5, output_tokens: 2 } },
      }),
      transformResponse: vi.fn().mockReturnValue({
        id: 'r',
        model: 'gpt-4',
        content: [{ type: 'text', text: 'a cat' }],
        stopReason: 'end_turn',
        usage: { promptTokens: 5, completionTokens: 2, cacheRead: 0, totalTokens: 7 },
      }),
    };
    mockedCreateProvider.mockReturnValue(provider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
          ],
        }],
      }),
    });

    expect(res.status).toBe(200);
    expect(provider.transformRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            role: 'user',
            content: [
              { type: 'text', text: 'what is this?' },
              { type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
            ],
          }),
        ],
      }),
    );
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
      body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }], stream: true }),
    });

    // HTTP 429 — NOT a 200 text/event-stream that can't be taken back.
    expect(res.status).toBe(429);
    // Body is a JSON error envelope (parseable), not an SSE stream.
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(JSON.stringify(body)).not.toContain('[DONE]');
  });
});
