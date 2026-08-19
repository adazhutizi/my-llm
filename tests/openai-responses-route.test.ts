import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock the model router and provider
vi.mock('../src/services/model-router.js', () => ({
  resolveModel: vi.fn(),
  getProviderConfig: vi.fn(),
  createProvider: vi.fn(),
}));

import { GatewayError, GatewayErrorCode } from '../src/utils/errors.js';
import { responses } from '../src/routes/openai/responses.js';
import { resolveModel, getProviderConfig, createProvider } from '../src/services/model-router.js';

const mockedResolveModel = vi.mocked(resolveModel);
const mockedGetProviderConfig = vi.mocked(getProviderConfig);
const mockedCreateProvider = vi.mocked(createProvider);

describe('POST /openai/v1/responses', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/', responses);

    // Default mocks
    mockedResolveModel.mockResolvedValue({
      provider: 'openai',
      realModel: 'gpt-4',
      fallbacks: null,
    });
    // 故意把上游 apiType 设成与 Responses 客户端不同的族('anthropic'),使路由走
    // 跨族 Internal 管线。同族('openai')会走 passthrough 透传不经 createProvider,
    // 测不到 Internal 断言——同族透传由 passthrough.test.ts 覆盖。此处测路由消费
    // Internal 协议的逻辑,与上游真实 provider 类无关(provider 被 mock)。
    mockedGetProviderConfig.mockResolvedValue({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      apiType: 'anthropic',
      estimateFallback: true,
    });
  });

  it('should return 400 for invalid JSON', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe('Invalid JSON body');
  });

  it('should return 400 when model is missing', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Hello' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe('model is required');
  });

  it('should handle string input', async () => {
    const mockProvider = {
      transformRequest: vi.fn().mockReturnValue({ url: 'http://test', method: 'POST', headers: {}, body: {} }),
      send: vi.fn().mockResolvedValue({
        status: 200,
        headers: {},
        body: {
          id: 'resp_123',
          model: 'gpt-4',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'Hello!' }],
            },
          ],
          usage: { input_tokens: 5, output_tokens: 3 },
        },
      }),
      transformResponse: vi.fn().mockReturnValue({
        id: 'resp_123',
        model: 'gpt-4',
        content: [{ type: 'text', text: 'Hello!' }],
        stopReason: 'end_turn',
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      }),
    };
    mockedCreateProvider.mockReturnValue(mockProvider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        input: 'Hi there',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('response');
    expect(body.model).toBe('gpt-4');
    expect(body.output).toHaveLength(1);
    expect(body.output[0].type).toBe('message');
    expect(body.output[0].content[0].type).toBe('output_text');
    expect(body.output[0].content[0].text).toBe('Hello!');
    expect(body.usage.input_tokens).toBe(5);
    expect(body.usage.output_tokens).toBe(3);
    expect(body.usage.total_tokens).toBe(8);
  });

  it('should handle array input with messages', async () => {
    const mockProvider = {
      transformRequest: vi.fn().mockReturnValue({ url: 'http://test', method: 'POST', headers: {}, body: {} }),
      send: vi.fn().mockResolvedValue({
        status: 200,
        headers: {},
        body: {
          id: 'resp_456',
          model: 'gpt-4',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'Response' }] }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
      transformResponse: vi.fn().mockReturnValue({
        id: 'resp_456',
        model: 'gpt-4',
        content: [{ type: 'text', text: 'Response' }],
        stopReason: 'end_turn',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }),
    };
    mockedCreateProvider.mockReturnValue(mockProvider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        input: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Hello' },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('completed');
  });

  it('should normalize input_text content parts to text (cross-family → Anthropic)', async () => {
    // OpenAI Responses SDK 默认发结构化 input,content part 类型是 input_text
    // (assistant 历史是 output_text),而非 text。跨族转 Anthropic 时若不归一化,
    // Anthropic 不认识 input_text block → 忽略消息 → 返回空 content。
    const mockProvider = {
      transformRequest: vi.fn().mockReturnValue({ url: 'http://test', method: 'POST', headers: {}, body: {} }),
      send: vi.fn().mockResolvedValue({
        status: 200,
        headers: {},
        body: {
          id: 'resp_norm',
          model: 'gpt-4',
          output: [{ type: 'message', content: [{ type: 'output_text', text: '你好!' }] }],
          usage: { input_tokens: 5, output_tokens: 3 },
        },
      }),
      transformResponse: vi.fn().mockReturnValue({
        id: 'resp_norm',
        model: 'gpt-4',
        content: [{ type: 'text', text: '你好!' }],
        stopReason: 'end_turn',
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      }),
    };
    mockedCreateProvider.mockReturnValue(mockProvider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        input: [
          { role: 'user', content: [{ type: 'input_text', text: '你好' }] },
        ],
      }),
    });

    expect(res.status).toBe(200);
    // 关键断言:internalReq.messages 的 content 已归一化为 {type:'text'},
    // 不再带 input_text(否则 Anthropic 上游会忽略 → 空 content)。
    expect(mockProvider.transformRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: [{ type: 'text', text: '你好' }],
          }),
        ]),
      }),
    );
  });

  it('should handle function_call_output in input', async () => {
    const mockProvider = {
      transformRequest: vi.fn().mockReturnValue({ url: 'http://test', method: 'POST', headers: {}, body: {} }),
      send: vi.fn().mockResolvedValue({
        status: 200,
        headers: {},
        body: {
          id: 'resp_789',
          model: 'gpt-4',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'Based on the weather data...' }] }],
          usage: { input_tokens: 20, output_tokens: 10 },
        },
      }),
      transformResponse: vi.fn().mockReturnValue({
        id: 'resp_789',
        model: 'gpt-4',
        content: [{ type: 'text', text: 'Based on the weather data...' }],
        stopReason: 'end_turn',
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      }),
    };
    mockedCreateProvider.mockReturnValue(mockProvider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        input: [
          { role: 'user', content: 'What is the weather?' },
          { type: 'function_call', call_id: 'call_123', name: 'get_weather', arguments: '{"city":"NYC"}' },
          { type: 'function_call_output', call_id: 'call_123', output: 'Sunny, 72F' },
        ],
      }),
    });

    expect(res.status).toBe(200);
  });

  it('should convert tool_use in response to function_call output', async () => {
    const mockProvider = {
      transformRequest: vi.fn().mockReturnValue({ url: 'http://test', method: 'POST', headers: {}, body: {} }),
      send: vi.fn().mockResolvedValue({
        status: 200,
        headers: {},
        body: {
          id: 'resp_tool',
          model: 'gpt-4',
          output: [{
            type: 'function_call',
            call_id: 'call_abc',
            name: 'get_weather',
            arguments: '{"city":"NYC"}',
          }],
          usage: { input_tokens: 15, output_tokens: 8 },
        },
      }),
      transformResponse: vi.fn().mockReturnValue({
        id: 'resp_tool',
        model: 'gpt-4',
        content: [{
          type: 'tool_use',
          id: 'call_abc',
          name: 'get_weather',
          input: { city: 'NYC' },
        }],
        stopReason: 'tool_use',
        usage: { promptTokens: 15, completionTokens: 8, totalTokens: 23 },
      }),
    };
    mockedCreateProvider.mockReturnValue(mockProvider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        input: 'What is the weather in NYC?',
        tools: [{
          type: 'function',
          name: 'get_weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        }],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.output).toHaveLength(1);
    expect(body.output[0].type).toBe('function_call');
    expect(body.output[0].name).toBe('get_weather');
    expect(body.output[0].call_id).toBe('call_abc');
    expect(JSON.parse(body.output[0].arguments)).toEqual({ city: 'NYC' });
  });

  it('should set status to incomplete when stopReason is max_tokens', async () => {
    const mockProvider = {
      transformRequest: vi.fn().mockReturnValue({ url: 'http://test', method: 'POST', headers: {}, body: {} }),
      send: vi.fn().mockResolvedValue({
        status: 200,
        headers: {},
        body: {
          id: 'resp_inc',
          model: 'gpt-4',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }],
          usage: { input_tokens: 5, output_tokens: 100 },
        },
      }),
      transformResponse: vi.fn().mockReturnValue({
        id: 'resp_inc',
        model: 'gpt-4',
        content: [{ type: 'text', text: 'partial' }],
        stopReason: 'max_tokens',
        usage: { promptTokens: 5, completionTokens: 100, totalTokens: 105 },
      }),
    };
    mockedCreateProvider.mockReturnValue(mockProvider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        input: 'Write a very long story',
        max_output_tokens: 100,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('incomplete');
  });

  it('should handle upstream errors', async () => {
    const mockProvider = {
      transformRequest: vi.fn().mockReturnValue({ url: 'http://test', method: 'POST', headers: {}, body: {} }),
      send: vi.fn().mockResolvedValue({
        status: 429,
        headers: {},
        body: { error: { message: 'Rate limit exceeded' } },
      }),
    };
    mockedCreateProvider.mockReturnValue(mockProvider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        input: 'Hello',
      }),
    });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it('normalizes Responses input_image parts to internal image blocks (cross-family → Anthropic)', async () => {
    // Responses input_image part(http URL 或 data:base64)须归一化为 Internal
    // image block,否则跨族 Anthropic 上游不认 input_image → 图片被忽略。
    const mockProvider = {
      transformRequest: vi.fn().mockReturnValue({ url: 'http://test', method: 'POST', headers: {}, body: {} }),
      send: vi.fn().mockResolvedValue({
        status: 200,
        headers: {},
        body: { id: 'r', model: 'gpt-4', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 3, output_tokens: 1 } },
      }),
      transformResponse: vi.fn().mockReturnValue({
        id: 'r',
        model: 'gpt-4',
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
      }),
    };
    mockedCreateProvider.mockReturnValue(mockProvider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: 'describe' },
            { type: 'input_image', image_url: 'https://example.com/cat.png' },
            { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/4AAQ' },
          ],
        }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockProvider.transformRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            role: 'user',
            content: [
              { type: 'text', text: 'describe' },
              { type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } },
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4AAQ' } },
            ],
          }),
        ],
      }),
    );
  });

  it('should pass max_output_tokens and temperature parameters', async () => {
    const mockProvider = {
      transformRequest: vi.fn().mockReturnValue({ url: 'http://test', method: 'POST', headers: {}, body: {} }),
      send: vi.fn().mockResolvedValue({
        status: 200,
        headers: {},
        body: {
          id: 'resp_params',
          model: 'gpt-4',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      }),
      transformResponse: vi.fn().mockReturnValue({
        id: 'resp_params',
        model: 'gpt-4',
        content: [{ type: 'text', text: 'OK' }],
        stopReason: 'end_turn',
        usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
      }),
    };
    mockedCreateProvider.mockReturnValue(mockProvider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        input: 'Hello',
        max_output_tokens: 100,
        temperature: 0.7,
        top_p: 0.9,
      }),
    });

    expect(res.status).toBe(200);

    // Check that transformRequest was called with the right parameters
    expect(mockProvider.transformRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        parameters: expect.objectContaining({
          maxTokens: 100,
          temperature: 0.7,
          topP: 0.9,
        }),
      })
    );
  });

  it('should NOT estimate tokens when provider estimateFallback is disabled', async () => {
    // Override default mock: opt out of chars→tokens fallback estimation.
    // apiType 仍为 'anthropic'(跨族 Internal)以测 Internal 路径的 fallback 开关。
    mockedGetProviderConfig.mockResolvedValue({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      apiType: 'anthropic',
      estimateFallback: false,
    });
    const mockProvider = {
      transformRequest: vi.fn().mockReturnValue({ url: 'http://test', method: 'POST', headers: {}, body: {} }),
      send: vi.fn().mockResolvedValue({
        status: 200,
        headers: {},
        body: {
          id: 'resp_nousage',
          model: 'gpt-4',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hi' }] }],
        },
      }),
      transformResponse: vi.fn().mockReturnValue({
        id: 'resp_nousage',
        model: 'gpt-4',
        content: [{ type: 'text', text: 'Hi' }],
        stopReason: 'end_turn',
        // Upstream omitted usage → all zero
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }),
    };
    mockedCreateProvider.mockReturnValue(mockProvider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', input: 'Hello world this is a prompt' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // Fallback disabled → no estimation → stays at 0 (billed by real usage only)
    expect(body.usage.input_tokens).toBe(0);
    expect(body.usage.output_tokens).toBe(0);
    expect(body.usage.total_tokens).toBe(0);
  });

  it('should estimate tokens when estimateFallback is enabled and upstream omits usage', async () => {
    // Default beforeEach mock has estimateFallback: true
    const mockProvider = {
      transformRequest: vi.fn().mockReturnValue({ url: 'http://test', method: 'POST', headers: {}, body: {} }),
      send: vi.fn().mockResolvedValue({
        status: 200,
        headers: {},
        body: {
          id: 'resp_est',
          model: 'gpt-4',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hi there' }] }],
        },
      }),
      transformResponse: vi.fn().mockReturnValue({
        id: 'resp_est',
        model: 'gpt-4',
        content: [{ type: 'text', text: 'Hi there' }],
        stopReason: 'end_turn',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }),
    };
    mockedCreateProvider.mockReturnValue(mockProvider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', input: 'Hello world this is a prompt' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // Fallback enabled → prompt estimated from messages, completion from content
    expect(body.usage.input_tokens).toBeGreaterThan(0);
    expect(body.usage.output_tokens).toBeGreaterThan(0);
    expect(body.usage.total_tokens).toBe(body.usage.input_tokens + body.usage.output_tokens);
  });

  it('should emit the full Responses streaming event chain for stream:true', async () => {
    // Upstream-style raw chunks; transformStreamChunk below mirrors
    // OpenAIProvider (text delta → content, response.completed → usage).
    const mockProvider = {
      transformRequest: vi.fn().mockReturnValue({ url: 'http://test', method: 'POST', headers: {}, body: {} }),
      openStream: async () => {
        async function* gen() {
          yield { data: { type: 'response.output_text.delta', delta: 'Hello' } };
          yield { data: { type: 'response.output_text.delta', delta: ' world' } };
          yield { data: { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 3 } } } };
        }
        return gen();
      },
      transformStreamChunk: (chunk: any) => {
        const d = chunk.data;
        if (d.type === 'response.output_text.delta' && d.delta) {
          return { type: 'content', content: { type: 'text', text: d.delta } };
        }
        if (d.type === 'response.completed') {
          const u = d.response?.usage;
          if (u) {
            return {
              type: 'usage',
              stopReason: 'end_turn',
              usage: { promptTokens: u.input_tokens ?? 0, completionTokens: u.output_tokens ?? 0, cacheRead: 0, totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) },
            };
          }
          return { type: 'stop', stopReason: 'end_turn' };
        }
        return null;
      },
    };
    mockedCreateProvider.mockReturnValue(mockProvider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', input: 'Hi', stream: true }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();

    // Parse SSE into ordered {event, data} frames (event: + data: per frame)
    const events: Array<{ event: string; data: any }> = [];
    let curEvent: string | undefined;
    let curData = '';
    for (const line of text.split('\n')) {
      if (line.startsWith('event: ')) curEvent = line.slice(7).trim();
      else if (line.startsWith('data: ')) curData += line.slice(6);
      else if (line === '' && curEvent) {
        events.push({ event: curEvent, data: JSON.parse(curData) });
        curEvent = undefined;
        curData = '';
      }
    }

    // Full lifecycle chain present and ordered — the core of the fix.
    expect(events.map((e) => e.event)).toEqual([
      'response.created',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);

    // Deltas carry item/part indices so strict clients can attach them.
    const deltas = events.filter((e) => e.event === 'response.output_text.delta');
    expect(deltas).toHaveLength(2);
    expect(deltas[0].data).toMatchObject({ item_id: expect.any(String), output_index: 0, content_index: 0, delta: 'Hello' });
    expect(deltas[1].data.delta).toBe(' world');

    // output_text.done carries the fully-accumulated text (was missing before).
    expect(events.find((e) => e.event === 'response.output_text.done')!.data.text).toBe('Hello world');

    // output_item.done carries the final message item.
    const itemDone = events.find((e) => e.event === 'response.output_item.done')!;
    expect(itemDone.data.item.type).toBe('message');
    expect(itemDone.data.item.content[0].text).toBe('Hello world');

    // response.completed.response.output is NON-empty (was [] before the fix)
    // — strict clients read this as the authoritative final result.
    const completed = events.find((e) => e.event === 'response.completed')!;
    expect(completed.data.response.output).toHaveLength(1);
    expect(completed.data.response.output[0].content[0].text).toBe('Hello world');
    expect(completed.data.response.status).toBe('completed');
    expect(completed.data.response.usage).toMatchObject({ input_tokens: 5, output_tokens: 3, total_tokens: 8 });
  });

  it('should mark the streamed response.status incomplete on max_tokens', async () => {
    const mockProvider = {
      transformRequest: vi.fn().mockReturnValue({ url: 'http://test', method: 'POST', headers: {}, body: {} }),
      openStream: async () => {
        async function* gen() {
          yield { data: { type: 'response.output_text.delta', delta: 'partial' } };
          yield { data: { type: 'response.completed', response: { status: 'incomplete', usage: { input_tokens: 5, output_tokens: 100 } } } };
        }
        return gen();
      },
      transformStreamChunk: (chunk: any) => {
        const d = chunk.data;
        if (d.type === 'response.output_text.delta' && d.delta) {
          return { type: 'content', content: { type: 'text', text: d.delta } };
        }
        if (d.type === 'response.completed') {
          return { type: 'usage', stopReason: 'max_tokens', usage: { promptTokens: 5, completionTokens: 100, cacheRead: 0, totalTokens: 105 } };
        }
        return null;
      },
    };
    mockedCreateProvider.mockReturnValue(mockProvider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', input: 'Hi', stream: true }),
    });

    const text = await res.text();
    const completedLine = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
    const completed = completedLine.find((c: any) => c.type === 'response.completed');
    // finalStatus now derives from stopReason (was hardcoded 'completed' before)
    expect(completed.response.status).toBe('incomplete');
    expect(completed.response.output[0].content[0].text).toBe('partial');
  });

  it('should synthesize a function_call item lifecycle for stream:true tool calls', async () => {
    // output_item.done for a function_call → tool_call chunk; response.completed
    // carries usage + stopReason='tool_use'. The route must synthesize the
    // function_call item's added→done lifecycle and include it in
    // response.completed.response.output (was [] when only a tool_call arrived
    // and output was keyed off the message itemAdded flag).
    const mockProvider = {
      transformRequest: vi.fn().mockReturnValue({ url: 'http://test', method: 'POST', headers: {}, body: {} }),
      openStream: async () => {
        async function* gen() {
          yield { data: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"NYC"}' } } };
          yield { data: { type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"NYC"}' }], usage: { input_tokens: 8, output_tokens: 2 } } } };
        }
        return gen();
      },
      transformStreamChunk: (chunk: any) => {
        const d = chunk.data;
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
          const u = d.response?.usage;
          const output = d.response?.output || [];
          const stopReason = output.some((i: any) => i.type === 'function_call') ? 'tool_use' : 'end_turn';
          if (u) {
            return { type: 'usage', stopReason, usage: { promptTokens: u.input_tokens ?? 0, completionTokens: u.output_tokens ?? 0, cacheRead: 0, totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) } };
          }
          return { type: 'stop', stopReason };
        }
        return null;
      },
    };
    mockedCreateProvider.mockReturnValue(mockProvider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        input: 'weather in NYC?',
        tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();

    // Parse SSE into ordered {event, data} frames (event: + data: per frame)
    const events: Array<{ event: string; data: any }> = [];
    let curEvent: string | undefined;
    let curData = '';
    for (const line of text.split('\n')) {
      if (line.startsWith('event: ')) curEvent = line.slice(7).trim();
      else if (line.startsWith('data: ')) curData += line.slice(6);
      else if (line === '' && curEvent) {
        events.push({ event: curEvent, data: JSON.parse(curData) });
        curEvent = undefined;
        curData = '';
      }
    }

    // function_call lifecycle: added (in_progress, empty args) → done (completed, full args)
    const fcAdded = events.filter((e) => e.event === 'response.output_item.added' && e.data.item?.type === 'function_call');
    const fcDone = events.filter((e) => e.event === 'response.output_item.done' && e.data.item?.type === 'function_call');
    expect(fcAdded).toHaveLength(1);
    expect(fcDone).toHaveLength(1);
    expect(fcAdded[0].data.item).toMatchObject({ type: 'function_call', name: 'get_weather', call_id: 'call_1', arguments: '', status: 'in_progress' });
    expect(fcDone[0].data.item).toMatchObject({ type: 'function_call', name: 'get_weather', call_id: 'call_1', status: 'completed' });
    expect(JSON.parse(fcDone[0].data.item.arguments)).toEqual({ city: 'NYC' });

    // function_call_arguments.done sits between added and done, carrying the full
    // arguments string. The official Responses streaming event chain requires it,
    // and the OpenAI Python SDK (issue #2723) relies on it to finalize arguments —
    // without it the SDK sees arguments=None and the multi-turn tool loop stops
    // ("outputs the first tool call then halts").
    const fcArgsDone = events.filter((e) => e.event === 'response.function_call_arguments.done');
    expect(fcArgsDone).toHaveLength(1);
    expect(fcArgsDone[0].data.arguments).toBe('{"city":"NYC"}');

    // ordering: added → function_call_arguments.done → output_item.done
    const addedIdx = events.findIndex((e) => e.event === 'response.output_item.added' && e.data.item?.type === 'function_call');
    const argsDoneIdx = events.findIndex((e) => e.event === 'response.function_call_arguments.done');
    const doneIdx = events.findIndex((e) => e.event === 'response.output_item.done' && e.data.item?.type === 'function_call');
    expect(addedIdx).toBeLessThan(argsDoneIdx);
    expect(argsDoneIdx).toBeLessThan(doneIdx);

    // response.completed.response.output carries the function_call item.
    const completed = events.find((e) => e.event === 'response.completed')!;
    expect(completed.data.response.output).toHaveLength(1);
    expect(completed.data.response.output[0]).toMatchObject({ type: 'function_call', name: 'get_weather', call_id: 'call_1' });
    expect(JSON.parse(completed.data.response.output[0].arguments)).toEqual({ city: 'NYC' });
  });

  it('should order message + function_call items by output_index in response.completed (mixed stream)', async () => {
    // Text arrives first (message item → output_index 0), then a function_call
    // (output_index 1). response.completed.response.output must list them in
    // output_index order — message before function_call — even though the
    // message item is finalized AFTER the function_call chunk is processed.
    const mockProvider = {
      transformRequest: vi.fn().mockReturnValue({ url: 'http://test', method: 'POST', headers: {}, body: {} }),
      openStream: async () => {
        async function* gen() {
          yield { data: { type: 'response.output_text.delta', delta: 'Let me check.' } };
          yield { data: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"NYC"}' } } };
          yield { data: { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Let me check.' }] }, { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"NYC"}' }], usage: { input_tokens: 12, output_tokens: 6 } } } };
        }
        return gen();
      },
      transformStreamChunk: (chunk: any) => {
        const d = chunk.data;
        if (d.type === 'response.output_text.delta' && d.delta) {
          return { type: 'content', content: { type: 'text', text: d.delta } };
        }
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
          const u = d.response?.usage;
          const output = d.response?.output || [];
          const stopReason = output.some((i: any) => i.type === 'function_call') ? 'tool_use' : 'end_turn';
          return { type: 'usage', stopReason, usage: { promptTokens: u.input_tokens ?? 0, completionTokens: u.output_tokens ?? 0, cacheRead: 0, totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) } };
        }
        return null;
      },
    };
    mockedCreateProvider.mockReturnValue(mockProvider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', input: 'weather in NYC?', stream: true }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const frames = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
    const completed = frames.find((f: any) => f.type === 'response.completed');

    // output ordered by output_index: message (0) then function_call (1).
    expect(completed.response.output).toHaveLength(2);
    expect(completed.response.output[0].type).toBe('message');
    expect(completed.response.output[0].content[0].text).toBe('Let me check.');
    expect(completed.response.output[1].type).toBe('function_call');
    expect(JSON.parse(completed.response.output[1].arguments)).toEqual({ city: 'NYC' });
  });

  it('extracts completion_tokens from the terminal stop chunk for Anthropic upstream (stream)', async () => {
    // AnthropicProvider maps message_delta → {type:'stop', stopReason, usage} where
    // usage.completionTokens is the FINAL output_tokens (promptTokens is deliberately
    // 0 so it doesn't overwrite message_start's input value). The route's stop branch
    // MUST read completionTokens — otherwise Responses + Anthropic streaming records
    // completion_tokens=0 (regression: the stop branch previously only read stopReason).
    const mockProvider = {
      transformRequest: vi.fn().mockReturnValue({ url: 'http://test', method: 'POST', headers: {}, body: {} }),
      openStream: async () => {
        async function* gen() {
          // message_start: input-side usage (completionTokens=0 at stream start)
          yield { data: { type: 'message_start', message: { usage: { input_tokens: 8, output_tokens: 0 } } } };
          // tool_use block complete → tool_call chunk
          yield { data: { type: 'content_block_stop' } };
          // message_delta: terminal, carries the final output_tokens
          yield { data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } };
        }
        return gen();
      },
      transformStreamChunk: (chunk: any) => {
        const d = chunk.data;
        if (d.type === 'message_start') {
          return { type: 'usage', usage: { promptTokens: 8, completionTokens: 0, cacheRead: 0, totalTokens: 8 } };
        }
        if (d.type === 'content_block_stop') {
          return { type: 'tool_call', toolCall: { id: 'call_1', name: 'get_weather', input: { city: 'NYC' } } };
        }
        if (d.type === 'message_delta') {
          return { type: 'stop', stopReason: 'tool_use', usage: { promptTokens: 0, completionTokens: 5, totalTokens: 5 } };
        }
        return null;
      },
    };
    mockedCreateProvider.mockReturnValue(mockProvider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-3',
        input: 'weather in NYC?',
        tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const completed = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).find((f: any) => f.type === 'response.completed');

    // completion_tokens comes from the stop chunk's usage (5), NOT 0.
    expect(completed.response.usage.output_tokens).toBe(5);
    // input_tokens preserved from message_start (8), not overwritten by stop's promptTokens=0.
    expect(completed.response.usage.input_tokens).toBe(8);
    expect(completed.response.usage.total_tokens).toBe(13);
    // stopReason tool_use → status completed (not incomplete).
    expect(completed.response.status).toBe('completed');
  });

  it('returns HTTP 429 (not a 200 stream) when the upstream rejects at the response-head stage', async () => {
    // Regression (非一对一 key 上游 429 下游无响应): 路由先 await openStream(),
    // 上游 429 在响应头阶段(~100ms)即抛错,路由不开 SSE 流,直接返 HTTP 429 +
    // JSON 错误(c.set usage isError=true 让 requestLog 中间件落日志)。原先先开
    // 200 流再 fetch,429 时 200 头已发无法回退,error chunk 缺终态 → SDK 丢弃内容
    // 返回 null → 下游"无响应"。
    const mockProvider = {
      transformRequest: vi.fn().mockReturnValue({ url: 'http://test', method: 'POST', headers: {}, body: {} }),
      openStream: vi.fn().mockRejectedValue(
        new GatewayError(GatewayErrorCode.PROVIDER_ERROR, '上游流式请求失败 (429 Too Many Requests): rate limited', 429),
      ),
      transformStreamChunk: vi.fn(),
    };
    mockedCreateProvider.mockReturnValue(mockProvider as any);

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', input: 'Hi', stream: true }),
    });

    // HTTP 429 — NOT a 200 text/event-stream that can't be taken back.
    expect(res.status).toBe(429);
    // Body is a JSON error envelope (parseable), not an SSE stream.
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(JSON.stringify(body)).not.toContain('[DONE]');
  });
});
