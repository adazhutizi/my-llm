import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { passthroughUpstream, type PassthroughOptions } from '../src/services/passthrough.js';

// passthrough 在流式 finally 里直接调 trackUsage / persistRequestLog(不经中间件)。
// 非流式则只 c.set('usage') 由后续中间件消费——此处用后置中间件捕获该值来断言。
vi.mock('../src/middleware/usage-track.js', () => ({ trackUsage: vi.fn() }));
vi.mock('../src/middleware/request-log.js', () => ({ persistRequestLog: vi.fn() }));
// getLogger 需先 createLogger() 初始化全局单例(触发 pino + getConfig 副作用);mock
// 成 no-op 让本文件独立,不依赖其他测试文件是否已先初始化 logger。
vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  }),
}));

import { trackUsage } from '../src/middleware/usage-track.js';
import { persistRequestLog } from '../src/middleware/request-log.js';

const mockedTrackUsage = vi.mocked(trackUsage);
const mockedPersistRequestLog = vi.mocked(persistRequestLog);

const fetchMock = vi.fn();
let capturedUsage: any;

/** 装一个最小 Hono app:后置中间件捕获 c.set('usage'),POST 处理交 passthrough。 */
function buildApp(opts: PassthroughOptions, path = '/v1/chat/completions') {
  const app = new Hono();
  app.use(path, async (c, next) => {
    await next();
    capturedUsage = (c as any).get('usage');
  });
  app.post(path, async (c) => passthroughUpstream(c, opts));
  return app;
}

describe('passthroughUpstream (同族透传旁路)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedUsage = undefined;
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('CC + OpenAI 上游:URL=/chat/completions、body 仅换 model、Authorization 重写、usage 减法拆 cache、响应原样', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          model: 'gpt-4o',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 30 } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const app = buildApp({
      providerCfg: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-real', apiType: 'openai', estimateFallback: false },
      realModel: 'gpt-4o-2024-08-06',
      clientProtocol: 'cc',
      // n / seed / logprobs 是 Internal 中转会丢的字段——透传必须原样保留
      requestBody: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], n: 2, seed: 42, logprobs: true },
      providerName: 'openai',
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ded_sk_xxx' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], n: 2, seed: 42, logprobs: true }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');

    const sentBody = JSON.parse(opts.body as string);
    expect(sentBody.model).toBe('gpt-4o-2024-08-06'); // 虚拟 → 真实
    expect(sentBody.n).toBe(2); // 保留
    expect(sentBody.seed).toBe(42); // 保留
    expect(sentBody.logprobs).toBe(true); // 保留(Internal 中转丢失项)

    // 凭证:重写为上游 key,客户端虚拟凭证剥离。app.request 不注入 c.env.incoming →
    // rawHeaderPairs 回退到 WHATWG Headers.entries()(小写),故 key 为小写 authorization;
    // 生产(node-server)下保留客户端原始大小写(见 tests/headers.test.ts)。
    expect(opts.headers.authorization).toBe('Bearer sk-real');
    expect(opts.headers.Authorization).toBeUndefined();

    // 响应原样返回(客户端可见原始 gross usage)
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.usage.prompt_tokens).toBe(100);
    expect(body.choices[0].message.content).toBe('Hi');

    // 非流式经 c.set('usage'):拆 cache(prompt=100-30=70, cacheRead=30)
    expect(capturedUsage.promptTokens).toBe(70);
    expect(capturedUsage.completionTokens).toBe(50);
    expect(capturedUsage.cacheReadTokens).toBe(30);
    expect(capturedUsage.model).toBe('gpt-4o'); // 虚拟 model(配额口径,非上游 model)
    expect(capturedUsage.provider).toBe('openai');
  });

  it('Anthropic + Anthropic 上游:URL=/v1/messages、x-api-key 凭证、anthropic-version 保留、usage 直取 cache', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'msg_1',
          model: 'claude-3',
          content: [{ type: 'text', text: 'Hi' }],
          usage: { input_tokens: 70, output_tokens: 50, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const app = buildApp(
      {
        providerCfg: { baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-real', apiType: 'anthropic', estimateFallback: false },
        realModel: 'claude-3-5-sonnet-20241022',
        clientProtocol: 'anthropic',
        requestBody: { model: 'claude-3', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 },
        providerName: 'anthropic',
      },
      '/v1/messages',
    );

    await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'ded_sk_xxx', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-3', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }),
    });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(opts.headers['x-api-key']).toBe('sk-ant-real');
    expect(opts.headers.Authorization).toBeUndefined(); // anthropic 族不发 Authorization
    expect(opts.headers['anthropic-version']).toBe('2023-06-01'); // 客户端原值保留

    // usage 直取(Anthropic 形态:input 已非缓存,cache 独立)
    expect(capturedUsage.promptTokens).toBe(70);
    expect(capturedUsage.cacheReadTokens).toBe(30);
    expect(capturedUsage.cacheCreationTokens).toBe(5);
    expect(capturedUsage.completionTokens).toBe(50);
  });

  it('剥离代理 fingerprint 头(X-Forwarded-*/CF-*/True-Client-IP/Via/hop-by-hop)', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const app = buildApp({
      providerCfg: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-real', apiType: 'openai', estimateFallback: false },
      realModel: 'gpt-4o',
      clientProtocol: 'cc',
      requestBody: { model: 'gpt-4o', messages: [] },
      providerName: 'openai',
    });
    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '1.2.3.4',
        'CF-Ray': 'abc',
        'True-Client-IP': '5.6.7.8',
        Via: '1.1 proxy',
        Connection: 'keep-alive',
        Authorization: 'Bearer ded_sk_xxx',
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    });
    const opts = fetchMock.mock.calls[0][1];
    expect(opts.headers['X-Forwarded-For']).toBeUndefined();
    expect(opts.headers['CF-Ray']).toBeUndefined();
    expect(opts.headers['True-Client-IP']).toBeUndefined();
    expect(opts.headers.Via).toBeUndefined();
    expect(opts.headers.Connection).toBeUndefined();
    // 客户端凭证被剥后按上游族重写(不是保留客户端原值)。app.request 回退小写
    // (生产保留客户端原始大小写,见 tests/headers.test.ts)。
    expect(opts.headers.authorization).toBe('Bearer sk-real');
  });

  it('流式 CC:字节原样转发(含 [DONE])、finally 提 usage 拆 cache、日志四字段齐', async () => {
    const sseBody = [
      'data: {"id":"1","choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n',
      'data: {"id":"1","choices":[{"index":0,"delta":{"content":" world"}}]}\n\n',
      'data: {"id":"1","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"prompt_tokens_details":{"cached_tokens":30}}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    fetchMock.mockResolvedValue(new Response(sseBody, { status: 200, headers: { 'content-type': 'text/event-stream' } }));

    const app = buildApp({
      providerCfg: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-real', apiType: 'openai', estimateFallback: false },
      realModel: 'gpt-4o',
      clientProtocol: 'cc',
      requestBody: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: true },
      providerName: 'openai',
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });

    expect(res.status).toBe(200);
    // 流式响应透传上游 content-type(stream() 默认不带任何头,不设则客户端收到
    // 无 content-type 的 200 流,EventSource 等严格消费方会拒绝)
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text();
    // 字节原样转发(含 [DONE])
    expect(text).toContain('Hello');
    expect(text).toContain(' world');
    expect(text.trim().endsWith('[DONE]')).toBe(true);

    // 流式刻意不 c.set('usage')(否则中间件会先记 0 占位 → 配额 bug)
    expect(capturedUsage).toBeUndefined();

    // finally 提 usage 拆 cache(prompt=70, cacheRead=30)
    expect(mockedTrackUsage).toHaveBeenCalledTimes(1);
    const trackedUsage = mockedTrackUsage.mock.calls[0][1];
    expect(trackedUsage.promptTokens).toBe(70);
    expect(trackedUsage.cacheReadTokens).toBe(30);
    expect(trackedUsage.completionTokens).toBe(50);

    // 日志四字段齐:responseHeaders + responseBody + streamChunks + streamChunkCount
    expect(mockedPersistRequestLog).toHaveBeenCalledTimes(1);
    const logOpts = mockedPersistRequestLog.mock.calls[0][5] as any;
    expect(logOpts.responseHeaders).toBeDefined();
    expect(logOpts.responseBody).toBeDefined();
    expect(logOpts.responseBody.content).toBe('Hello world'); // 累积文本
    expect(logOpts.responseBody.usage.prompt_tokens).toBe(100); // 日志用 gross(70+30)
    expect(logOpts.streamChunks).toBeDefined();
    expect(typeof logOpts.streamChunkCount).toBe('number');
  });

  it('流式 Responses:从 response.completed 的 response.usage 提取(非顶层 usage)', async () => {
    // 关键坑:OpenAI Responses 流式的 usage 在 response.completed.response.usage,
    // 不在顶层。漏取则 Responses 透传记账全 0。
    const sseBody = [
      'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":200,"output_tokens":80,"input_tokens_details":{"cached_tokens":60}}}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    fetchMock.mockResolvedValue(new Response(sseBody, { status: 200, headers: { 'content-type': 'text/event-stream' } }));

    const app = buildApp(
      {
        providerCfg: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-real', apiType: 'openai', estimateFallback: false },
        realModel: 'gpt-4o',
        clientProtocol: 'responses',
        requestBody: { model: 'gpt-4o', input: 'hi', stream: true },
        providerName: 'openai',
      },
      '/v1/responses',
    );

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', input: 'hi', stream: true }),
    });
    await res.text(); // 消费 body 驱动 stream cb 的 finally(trackUsage 在 finally 里)

    // input=200, cached=60 → prompt=140, cacheRead=60
    const trackedUsage = mockedTrackUsage.mock.calls[0][1];
    expect(trackedUsage.promptTokens).toBe(140);
    expect(trackedUsage.cacheReadTokens).toBe(60);
    expect(trackedUsage.completionTokens).toBe(80);
  });

  it('流式 Anthropic:message_start(message.usage)+ message_delta(顶层 usage)分布式累积', async () => {
    // Anthropic 流式 usage 跨两个事件:message_start 带 input + cache(在 message.usage),
    // message_delta 仅带 output(顶层 usage)。两个都须提取并合并(input+output)。
    const sseBody = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":70,"cache_read_input_tokens":30,"cache_creation_input_tokens":5}}}\n\n',
      'data: {"type":"content_block_delta","delta":{"text":"Hi"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    fetchMock.mockResolvedValue(new Response(sseBody, { status: 200, headers: { 'content-type': 'text/event-stream' } }));

    const app = buildApp(
      {
        providerCfg: { baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-real', apiType: 'anthropic', estimateFallback: false },
        realModel: 'claude-3',
        clientProtocol: 'anthropic',
        requestBody: { model: 'claude-3', messages: [{ role: 'user', content: 'hi' }], stream: true },
        providerName: 'anthropic',
      },
      '/v1/messages',
    );

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-3', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    await res.text(); // 消费 body 驱动 stream cb 的 finally(trackUsage 在 finally 里)

    const trackedUsage = mockedTrackUsage.mock.calls[0][1];
    expect(trackedUsage.promptTokens).toBe(70); // 来自 message_start
    expect(trackedUsage.cacheReadTokens).toBe(30); // 来自 message_start
    expect(trackedUsage.cacheCreationTokens).toBe(5); // 来自 message_start
    expect(trackedUsage.completionTokens).toBe(50); // 来自 message_delta
  });

  it('连接错误(fetch failed)重试一次后成功', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const app = buildApp({
      providerCfg: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-real', apiType: 'openai', estimateFallback: false },
      realModel: 'gpt-4o',
      clientProtocol: 'cc',
      requestBody: { model: 'gpt-4o', messages: [] },
      providerName: 'openai',
    });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('流式 estimateFallback 开启:上游无 usage 时估算 prompt/completion', async () => {
    // opt-in(estimateFallback=true)+ 生成类路径 → allowFallback。上游流式无 usage
    // chunk → 从 requestBody 估 prompt、从累积文本估 completion。
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"Hello world"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    fetchMock.mockResolvedValue(new Response(sseBody, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const app = buildApp({
      providerCfg: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-real', apiType: 'openai', estimateFallback: true },
      realModel: 'gpt-4o',
      clientProtocol: 'cc',
      requestBody: { model: 'gpt-4o', messages: [{ role: 'user', content: 'a prompt long enough to estimate' }] },
      providerName: 'openai',
    });
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'a prompt long enough to estimate' }] }),
    });
    await res.text(); // 消费 body 驱动 stream cb 的 finally(trackUsage 在 finally 里)
    const trackedUsage = mockedTrackUsage.mock.calls[0][1];
    // completion 从累积文本 "Hello world"(11 字符)→ ceil(11/2)=6
    expect(trackedUsage.completionTokens).toBe(6);
    // prompt 从 requestBody 估算(递归累加所有字符串长度)> 0
    expect(trackedUsage.promptTokens).toBeGreaterThan(0);
  });

  it('流式响应 content-type 透传上游原值(charset 变体),其余上游头不透传', async () => {
    // 回归:stream() 裸调 c.newResponse 不带任何头,流式响应曾完全没有 content-type
    // (上游的 text/event-stream 只进了日志的 responseHeaders,没到客户端)。严格按
    // MIME 判定 SSE 的消费方(浏览器 EventSource、部分 SDK/代理)会拒绝。修复:单透传
    // 上游 content-type 原值——charset 变体(`;charset=UTF-8`,无空格)原样保留。
    // 其余上游头刻意不透传:content-encoding 已被 fetch 自动解压(透传则客户端对明文
    // 再解压)、content-length 与转发字节不保证一致、上游 x-request-id 与网关回显的
    // X-Request-ID 双 id 混淆。
    const sseBody = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n';
    fetchMock.mockResolvedValue(
      new Response(sseBody, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream;charset=UTF-8',
          'content-encoding': 'gzip',
          'x-request-id': 'upstream-req-999',
        },
      }),
    );

    const app = buildApp({
      providerCfg: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-real', apiType: 'openai', estimateFallback: false },
      realModel: 'gpt-4o',
      clientProtocol: 'cc',
      requestBody: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: true },
      providerName: 'openai',
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    await res.text();

    // 上游原值原样透传(含无空格 charset 变体)
    expect(res.headers.get('content-type')).toBe('text/event-stream;charset=UTF-8');
    // 其余上游头不透传
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('x-request-id')).toBeNull();
    // 日志侧仍记录完整上游头(与客户端可见头是两回事)
    const logOpts = mockedPersistRequestLog.mock.calls[0][5] as any;
    expect(logOpts.responseHeaders['content-type']).toBe('text/event-stream;charset=UTF-8');
    expect(logOpts.responseHeaders['x-request-id']).toBe('upstream-req-999');
  });

  it('流式 SSE 行解析容错:无空格 data: + 中间畸形行不阻断终态 usage 提取', async () => {
    // 回归:passthrough 原先用 startsWith('data: ')(带空格)严格匹配、且单行
    // JSON.parse 失败即中断整个 for 循环(外层 catch 兜底)。无空格 `data:` 上游
    // (部分兼容服务商,如阿里云 DashScope)的事件行被全过滤掉,终态 usage 漏掉
    // → 记账 token 全 0。改用 parseSSEDataLines(与 BaseProvider.stream() 同口径:
    // 宽松行首 + 逐行容错)后修复。
    const sseBody = [
      'data:{"choices":[{"delta":{"content":"Hi"}}]}',
      'data: not-a-json-line',
      'data: {"choices":[],"usage":{"prompt_tokens":80,"completion_tokens":40,"prompt_tokens_details":{"cached_tokens":20}}}',
      'data: [DONE]',
    ].join('\n\n');
    fetchMock.mockResolvedValue(new Response(sseBody, { status: 200, headers: { 'content-type': 'text/event-stream' } }));

    const app = buildApp({
      providerCfg: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'sk-real', apiType: 'openai', estimateFallback: false },
      realModel: 'qwen-plus',
      clientProtocol: 'cc',
      requestBody: { model: 'qwen-plus', messages: [{ role: 'user', content: 'hi' }], stream: true },
      providerName: 'dashscope',
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen-plus', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    await res.text();

    // 无空格 data: 的 content 仍累积(畸形行未污染)
    const logOpts = mockedPersistRequestLog.mock.calls[0][5] as any;
    expect(logOpts.responseBody.content).toBe('Hi');
    // 终态 usage 仍提取(prompt=80-20=60, cacheRead=20, completion=40)——
    // 修复前此处全 0(行被严格过滤漏掉)。
    const trackedUsage = mockedTrackUsage.mock.calls[0][1];
    expect(trackedUsage.promptTokens).toBe(60);
    expect(trackedUsage.cacheReadTokens).toBe(20);
    expect(trackedUsage.completionTokens).toBe(40);
  });

  it('Content-Type 单值:body 重新 stringify 后不与客户端原值 append 成 application/json, application/json', async () => {
    // 回归:passthrough 预设 'Content-Type: application/json' 后又遍历复制客户端
    // 原始 header。WHATWG Headers.entries() 返回小写 'content-type',与预设的大写
    // 'Content-Type' 在普通对象里并存双 key;fetch 把 record 转 Headers 时对同名
    // header 做 append(非 set),合并成 'application/json, application/json' → 上游
    // (DashScope/OpenAI 兼容端点)拒 unsupported_content_type。修复:跳过客户端
    // content-type。所有 OpenAI SDK 客户端默认都带 Content-Type,故此坑命中面极广。
    fetchMock.mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const app = buildApp(
      {
        providerCfg: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'sk-real', apiType: 'openai', estimateFallback: false },
        realModel: 'qwen-plus',
        clientProtocol: 'responses',
        requestBody: { model: 'qwen-plus', input: 'hi' },
        providerName: 'dashscope',
      },
      '/v1/responses',
    );
    await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }, // 客户端默认都带
      body: JSON.stringify({ model: 'qwen-plus', input: 'hi' }),
    });
    const opts = fetchMock.mock.calls[0][1];
    // 模拟 fetch 内部 record→Headers 的 append 语义(大小写不敏感同名合并)——
    // 修复前此处为 'application/json, application/json'。
    const merged = new Headers();
    for (const [k, v] of Object.entries(opts.headers)) merged.append(k, v as string);
    expect(merged.get('content-type')).toBe('application/json');
  });

  it('剥离 content-length:body 重 stringify 换 model 后长度变化,不可透传客户端原 content-length', async () => {
    // 回归(kimi-k3 调用无响应):虚拟 model 'kimi-k3' → 真实 'kimi/kimi-k3'(变长),
    // passthrough 重 stringify body 长度变化,但 STRIP_HEADERS 未含 content-length →
    // 客户端原 content-length(按虚拟 model 的 body 算)被透传给上游;上游按旧长度读
    // body 永远收不齐 → 不返响应头 → fetch 挂死 → 客户端「无响应」。修复:STRIP_HEADERS
    // 含 content-length,fetch 按新 body 重算。dedicated 不受影响(透传原 body 不改长度)。
    fetchMock.mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const app = buildApp(
      {
        providerCfg: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'sk-real', apiType: 'openai', estimateFallback: false },
        realModel: 'kimi/kimi-k3',
        clientProtocol: 'cc',
        requestBody: { model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }] },
        providerName: 'dashscope',
      },
      '/v1/chat/completions',
    );
    // 模拟 @hono/node-server 注入的 incoming.rawHeaders(Node HTTP 层按客户端 body
    // 自动加 content-length)。app.request 的 WHATWG headers 不暴露 content-length
    // (forbidden header),必须经 incoming.rawHeaders 才测得到——与 headers.test.ts
    // 测大小写保留同一套路(fake incoming)。
    await app.request(
      '/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer app_sk_x' },
        body: JSON.stringify({ model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }] }),
      },
      { incoming: { rawHeaders: ['content-length', '119', 'content-type', 'application/json', 'authorization', 'Bearer app_sk_x', 'x-debug-marker', 'yes'] } },
    );
    const opts = fetchMock.mock.calls[0][1];
    // marker 确认 incoming.rawHeaders 注入生效(回退 WHATWG 时不会有它,避免误绿)
    expect(opts.headers['x-debug-marker']).toBe('yes');
    // content-length 必须被剥离(大小写都不留)——否则与按新 body 重算的长度冲突
    expect(opts.headers['content-length']).toBeUndefined();
    expect(opts.headers['Content-Length']).toBeUndefined();
    // body 是 realModel 替换后的(fetch 据此重算 content-length)
    expect(JSON.parse(opts.body as string).model).toBe('kimi/kimi-k3');
  });

  it('流式 stream:true + 上游 429(即便 content-type 是 text/event-stream)走非流式分支返 HTTP 429', async () => {
    // 回归(同族也卡住):某些上游(OpenAI 兼容端点)对 stream 请求的限流/错误也用
    // SSE 包装(429 + content-type: text/event-stream + 错误 body)。原先 passthrough
    // 只看 content-type → 进 stream() 发 200 头裸字节转发错误 SSE → 客户端 SDK 收到
    // 200+SSE 开始解析却只读到错误 → 卡住(与 Internal 跨族「先开流再判 429」同类坑)。
    // 修复:先看 upstreamRes.ok,非 2xx 走非流式分支返回真实 status。dedicated-proxy.ts
    // 同源同条件,一并修。
    const errorBody = 'data: {"error":{"message":"rate limited","type":"rate_limit_exceeded"}}\n\n';
    fetchMock.mockResolvedValue(new Response(errorBody, { status: 429, headers: { 'content-type': 'text/event-stream' } }));

    const app = buildApp({
      providerCfg: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-real', apiType: 'openai', estimateFallback: false },
      realModel: 'gpt-4o',
      clientProtocol: 'cc',
      requestBody: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: true },
      providerName: 'openai',
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });

    // HTTP 429 —— 非 200 text/event-stream,不再进 stream() 卡住。
    expect(res.status).toBe(429);
    // 非流式分支:c.set('usage', isError=true) 让 requestLog 落这条 429 日志。
    expect(capturedUsage.isError).toBe(true);
    // 非 2xx 不进流式 finally → 不调 trackUsage(无 token 可记,由中间件按 usage 落账)。
    expect(mockedTrackUsage).not.toHaveBeenCalled();
  });
});
