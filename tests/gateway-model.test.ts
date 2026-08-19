import { describe, it, expect } from 'vitest';
import { Agent, run, tool, type ModelRequest } from '@openai/agents';
import { z } from 'zod';
import {
  GatewayModel,
  createUsageAccumulator,
  modelRequestToInternal,
  internalResToModelResponse,
} from '../src/agents/gateway-model.js';
import type { ProviderAdapter, UpstreamRequest, UpstreamResponse } from '../src/providers/base.js';
import type { InternalRequest, InternalResponse, InternalStreamChunk } from '../src/types/internal.js';

// ── fake provider ────────────────────────────────────────────────────────────
// A scripted ProviderAdapter: transformResponse hands back preset InternalResponses
// in order, one per turn of the SDK's tool-calling loop. send/transformRequest are
// stubs — the bridge only needs the request to flow through; it never inspects the
// upstream body in getResponse. This lets us drive a REAL SDK Runner over a fake
// model and prove the Responses-API tool round-trip works on our own pipeline.

function makeScriptedProvider(responses: InternalResponse[]): ProviderAdapter {
  let idx = 0;
  return {
    name: 'scripted',
    transformRequest: (req: InternalRequest): UpstreamRequest => ({
      url: 'http://upstream.test/responses',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req.messages),
    }),
    send: async (): Promise<UpstreamResponse> => ({ status: 200, headers: {}, body: '{}' }),
    transformResponse: (): InternalResponse => {
      const r = responses[idx] ?? responses[responses.length - 1];
      idx += 1;
      return r;
    },
    transformStreamChunk: () => null,
    stream: async function* () {
      /* not used by getResponse */
    },
  } as unknown as ProviderAdapter;
}

// Shared minimal ModelRequest for getStreamedResponse tests (the bridge only
// inspects input/tools, which are empty here).
const baseModelRequest: ModelRequest = {
  input: 'q',
  modelSettings: {},
  tools: [],
  handoffs: [],
  tracing: undefined,
  outputType: undefined as never,
};

// Streaming variant: transformStreamChunk hands back preset InternalStreamChunks
// in order (one per upstream chunk the stream yields). Single-phase
// getStreamedResponse builds the authoritative output from the chunks alone, so
// it NEVER calls transformResponse — that throws here as a backfill regression guard.
function makeStreamingProvider(chunks: InternalStreamChunk[]): ProviderAdapter {
  let streamIdx = 0;
  return {
    name: 'streaming',
    transformRequest: (req: InternalRequest): UpstreamRequest => ({
      url: 'http://upstream.test/responses',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req.messages),
    }),
    send: async (): Promise<UpstreamResponse> => ({ status: 200, headers: {}, body: '{}' }),
    transformResponse: (): InternalResponse => {
      throw new Error('transformResponse must not be called in single-phase streaming');
    },
    transformStreamChunk: () => {
      const c = chunks[streamIdx];
      streamIdx += 1;
      return c ?? null;
    },
    stream: async function* () {
      // One sentinel per chunk so transformStreamChunk is called exactly once each.
      for (let i = 0; i < chunks.length; i++) {
        yield { data: i };
      }
    },
  } as unknown as ProviderAdapter;
}

// Multi-turn streaming variant: each call to stream() advances to the NEXT turn's
// chunk list, so a real SDK Runner tool loop (turn 1 = function_call via a
// tool_call chunk, turn 2 = final text) can be driven through getStreamedResponse
// end-to-end. transformResponse throws (no non-streamed backfill in any path).
function makeMultiTurnStreamingProvider(turnChunks: InternalStreamChunk[][]): ProviderAdapter {
  let turnIdx = 0;
  let curChunks: InternalStreamChunk[] = turnChunks[0];
  let curIdx = 0;
  return {
    name: 'multi-streaming',
    transformRequest: (req: InternalRequest): UpstreamRequest => ({
      url: 'http://upstream.test/responses',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req.messages),
    }),
    send: async (): Promise<UpstreamResponse> => ({ status: 200, headers: {}, body: '{}' }),
    transformResponse: (): InternalResponse => {
      throw new Error('transformResponse must not be called in single-phase streaming');
    },
    transformStreamChunk: (): InternalStreamChunk | null => {
      const c = curChunks[curIdx];
      curIdx += 1;
      return c ?? null;
    },
    stream: async function* () {
      curChunks = turnChunks[turnIdx] ?? turnChunks[turnChunks.length - 1];
      curIdx = 0;
      turnIdx += 1;
      const len = curChunks.length;
      for (let i = 0; i < len; i++) {
        yield { data: i };
      }
    },
  } as unknown as ProviderAdapter;
}

function textResponse(text: string): InternalResponse {
  return {
    id: 'resp_text',
    model: 'test-model',
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
  };
}

function toolCallResponse(callId: string, name: string, input: unknown): InternalResponse {
  return {
    id: 'resp_tool',
    model: 'test-model',
    content: [{ type: 'tool_use', id: callId, name, input }],
    stopReason: 'tool_use',
    usage: { promptTokens: 15, completionTokens: 5, totalTokens: 20 },
  };
}

// ── 1. modelRequestToInternal ────────────────────────────────────────────────

describe('modelRequestToInternal', () => {
  it('turns a string input into a user message and forwards system instructions', () => {
    const req = modelRequestToInternal(
      {
        systemInstructions: 'You are helpful.',
        input: 'hi',
        modelSettings: {},
        tools: [],
        handoffs: [],
        tracing: undefined,
        outputType: undefined as never,
      },
      'real-model-x',
    );
    expect(req.model).toBe('real-model-x');
    expect(req.messages).toEqual([
      { role: 'system', content: [{ type: 'text', text: 'You are helpful.' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]);
    expect(req.parameters.stream).toBe(false);
  });

  it('maps an SDK function_call + function_call_result back to tool_use / tool_result', () => {
    const req = modelRequestToInternal(
      {
        input: [
          { type: 'user', role: 'user', content: 'please echo' },
          { type: 'function_call', callId: 'c1', name: 'echo', arguments: '{"message":"hi"}' },
          { type: 'function_call_result', callId: 'c1', name: 'echo', status: 'completed', output: 'ECHO: hi' },
        ],
        modelSettings: {},
        tools: [],
        handoffs: [],
        tracing: undefined,
        outputType: undefined as never,
      },
      'm',
    );
    // system absent, then user, assistant(tool_use), tool(tool_result)
    expect(req.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    const assistant = req.messages[1];
    expect(assistant.content[0]).toMatchObject({ type: 'tool_use', id: 'c1', name: 'echo' });
    expect((assistant.content[0] as { input: unknown }).input).toEqual({ message: 'hi' });
    const toolMsg = req.messages[2];
    expect(toolMsg.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'c1',
      content: 'ECHO: hi',
    });
  });

  it('serialises SDK function tools into Tool[] with their JSON-schema params', () => {
    const req = modelRequestToInternal(
      {
        input: 'q',
        modelSettings: {},
        tools: [
          {
            type: 'function',
            name: 'echo',
            description: 'echo',
            parameters: { type: 'object', properties: { message: { type: 'string' } } },
            strict: false,
          },
        ],
        handoffs: [],
        tracing: undefined,
        outputType: undefined as never,
      },
      'm',
    );
    expect(req.parameters.tools).toEqual([
      {
        name: 'echo',
        description: 'echo',
        input_schema: { type: 'object', properties: { message: { type: 'string' } } },
      },
    ]);
  });
});

// ── 2. internalResToModelResponse ────────────────────────────────────────────

describe('internalResToModelResponse', () => {
  it('turns a text InternalResponse into an assistant message item', () => {
    const mr = internalResToModelResponse(textResponse('hello there'));
    expect(mr.output).toHaveLength(1);
    expect(mr.output[0]).toMatchObject({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'hello there' }],
    });
  });

  it('turns a tool_use InternalResponse into a function_call item with stringified args', () => {
    const mr = internalResToModelResponse(toolCallResponse('c1', 'echo', { message: 'hi' }));
    const fc = mr.output.find((o) => o.type === 'function_call') as {
      type: string;
      callId: string;
      name: string;
      arguments: string;
    };
    expect(fc).toBeDefined();
    expect(fc.callId).toBe('c1');
    expect(fc.name).toBe('echo');
    expect(JSON.parse(fc.arguments)).toEqual({ message: 'hi' });
  });

  it('reports gross input (prompt + cacheRead + cacheCreation) in usage', () => {
    const mr = internalResToModelResponse({
      id: 'r',
      model: 'm',
      content: [{ type: 'text', text: 'x' }],
      usage: { promptTokens: 100, completionTokens: 10, totalTokens: 220, cacheRead: 50, cacheCreation: 60 },
    });
    // gross input = 100 + 50 + 60 = 210; total = 210 + 10 = 220
    expect(mr.usage.inputTokens).toBe(210);
    expect(mr.usage.outputTokens).toBe(10);
    expect(mr.usage.totalTokens).toBe(220);
  });
});

// ── 3. GatewayModel.getResponse end-to-end ───────────────────────────────────

describe('GatewayModel.getResponse', () => {
  it('runs a text turn through the fake provider and accumulates usage', async () => {
    const usage = createUsageAccumulator();
    const provider = makeScriptedProvider([textResponse('pong')]);
    const model = new GatewayModel({ provider, realModel: 'real-model-x', usage });

    const mr = await model.getResponse({
      input: 'ping',
      modelSettings: {},
      tools: [],
      handoffs: [],
      tracing: undefined,
      outputType: undefined as never,
    });
    const msg = mr.output[0] as { content: Array<{ type: string; text: string }> };
    expect(msg.content[0].text).toBe('pong');
    expect(usage.promptTokens).toBe(12);
    expect(usage.completionTokens).toBe(8);
  });

  it('throws on upstream >= 400', async () => {
    const provider = {
      name: 'bad',
      transformRequest: () => ({ url: 'u', method: 'POST', headers: {}, body: '' }),
      send: async () => ({ status: 429, headers: {}, body: '{"error":"rate"}' }),
      transformResponse: () => textResponse('x'),
      transformStreamChunk: () => null,
      stream: async function* () {},
    } as unknown as ProviderAdapter;
    const model = new GatewayModel({ provider, realModel: 'm', usage: createUsageAccumulator() });
    await expect(
      model.getResponse({
        input: 'q',
        modelSettings: {},
        tools: [],
        handoffs: [],
        tracing: undefined,
        outputType: undefined as never,
      }),
    ).rejects.toThrow(/分析模型上游错误/);
  });
});

// ── 4. real streaming ────────────────────────────────────────────────────────

describe('GatewayModel.getStreamedResponse (real streaming)', () => {
  // Single phase: response_done.output is assembled from the stream itself — text
  // via output_text.delta (accumulated into textBuf), each function_call via a
  // tool_call chunk (OpenAI's response.output_item.done). No non-streamed backfill,
  // so the fake provider's send/transformResponse are never called by these tests.

  it('streams per-token text deltas and assembles output+usage from the stream (no backfill)', async () => {
    const chunks: InternalStreamChunk[] = [
      { type: 'content', content: { type: 'text', text: 'Hello' } },
      { type: 'content', content: { type: 'text', text: ' ' } },
      { type: 'content', content: { type: 'text', text: 'world' } },
      { type: 'usage', usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 } },
    ];
    const provider = makeStreamingProvider(chunks);
    const usage = createUsageAccumulator();
    const model = new GatewayModel({ provider, realModel: 'm', usage });

    const events: { type: string; delta?: string }[] = [];
    for await (const ev of model.getStreamedResponse(baseModelRequest)) {
      events.push(ev as { type: string; delta?: string });
    }
    expect(events.map((e) => e.type)).toEqual([
      'response_started',
      'output_text_delta',
      'output_text_delta',
      'output_text_delta',
      'response_done',
    ]);
    expect(events.filter((e) => e.type === 'output_text_delta').map((e) => e.delta)).toEqual([
      'Hello',
      ' ',
      'world',
    ]);
    const done = events.find((e) => e.type === 'response_done') as {
      response: {
        output: Array<{ content: Array<{ type: string; text: string }> }>;
        usage: { inputTokens: number; outputTokens: number };
      };
    };
    // output text is the accumulated textBuf; usage is the streamed usage chunk
    // (prompt 10, completion 3, cacheRead 0 → grossInput 10, outputTokens 3).
    expect(done.response.output).toHaveLength(1);
    expect(done.response.output[0].content[0].text).toBe('Hello world');
    expect(done.response.usage.inputTokens).toBe(10);
    expect(done.response.usage.outputTokens).toBe(3);
    // Billing bills the SINGLE streamed request: prompt 10, completion 3.
    expect(usage.promptTokens).toBe(10);
    expect(usage.completionTokens).toBe(3);
  });

  it('assembles function_call output from a tool_call stream chunk (no backfill)', async () => {
    const chunks: InternalStreamChunk[] = [
      { type: 'content', content: { type: 'text', text: 'Let me check.' } },
      { type: 'tool_call', toolCall: { id: 'c1', name: 'echo', input: { message: 'hi' } } },
    ];
    const provider = makeStreamingProvider(chunks);
    const usage = createUsageAccumulator();
    const model = new GatewayModel({ provider, realModel: 'm', usage });

    const events: { type: string; delta?: string }[] = [];
    for await (const ev of model.getStreamedResponse(baseModelRequest)) {
      events.push(ev as { type: string; delta?: string });
    }
    // Preamble text streamed; function_call assembled from the tool_call chunk.
    expect(events.filter((e) => e.type === 'output_text_delta').map((e) => e.delta)).toEqual([
      'Let me check.',
    ]);
    const done = events.find((e) => e.type === 'response_done') as {
      response: { output: Array<{ type: string; callId?: string; name?: string }> };
    };
    const fc = done.response.output.find((o) => o.type === 'function_call');
    expect(fc).toBeDefined();
    expect(fc?.callId).toBe('c1');
    expect(fc?.name).toBe('echo');
    // No usage chunk in the stream → bills 0 (no backfill to top it up).
    expect(usage.promptTokens).toBe(0);
    expect(usage.completionTokens).toBe(0);
  });

  it('uses overwrite (last non-zero) semantics for streamed usage', async () => {
    // Anthropic-style: input side in message_start, output in message_delta.
    const chunks: InternalStreamChunk[] = [
      { type: 'usage', usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100, cacheRead: 30 } },
      { type: 'content', content: { type: 'text', text: 'ans' } },
    ];
    const provider = makeStreamingProvider(chunks);
    const usage = createUsageAccumulator();
    const model = new GatewayModel({ provider, realModel: 'm', usage });

    for await (const _ of model.getStreamedResponse(baseModelRequest)) {
      void _;
    }
    // Single streamed request: prompt 100, cacheRead 30, completion 0.
    expect(usage.promptTokens).toBe(100);
    expect(usage.cacheRead).toBe(30);
    expect(usage.completionTokens).toBe(0);
  });

  it('throws providerError on an empty stream (upstream non-SSE error)', async () => {
    const provider = makeStreamingProvider([]);
    const model = new GatewayModel({ provider, realModel: 'm', usage: createUsageAccumulator() });
    await expect(
      (async () => {
        for await (const _ of model.getStreamedResponse(baseModelRequest)) {
          void _;
        }
      })(),
    ).rejects.toThrow(/分析模型流式响应为空/);
  });

  // ── reasoning streaming ──────────────────────────────────────────────────
  // Reasoning deltas flow through the SDK's {type:'model', event} escape hatch
  // (StreamEventGenericItem) so the Runner re-emits them as raw_model_stream_event
  // and the analysis route can forward them. Reasoning must NEVER enter textBuf
  // (the final message text) or the usage sink — it's pure display.

  it('streams reasoning deltas via the {type:"model"} escape hatch (no textBuf/usage)', async () => {
    const chunks: InternalStreamChunk[] = [
      { type: 'reasoning', reasoning: '想一下' },
      { type: 'reasoning', reasoning: '再想想' },
      { type: 'usage', usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 } },
    ];
    const provider = makeStreamingProvider(chunks);
    const usage = createUsageAccumulator();
    const model = new GatewayModel({ provider, realModel: 'm', usage });

    const events: { type: string; delta?: string; event?: { type?: string; delta?: string } }[] = [];
    for await (const ev of model.getStreamedResponse(baseModelRequest)) {
      events.push(ev as { type: string; delta?: string; event?: { type?: string; delta?: string } });
    }
    expect(events.map((e) => e.type)).toEqual([
      'response_started',
      'model',
      'model',
      'response_done',
    ]);
    const reasoningEvents = events.filter((e) => e.type === 'model');
    expect(reasoningEvents.map((e) => e.event?.type)).toEqual(['reasoning_delta', 'reasoning_delta']);
    expect(reasoningEvents.map((e) => e.event?.delta)).toEqual(['想一下', '再想想']);
    // Reasoning does NOT pollute the usage sink: only the stream's usage chunk
    // (prompt 10, completion 3). No backfill, so no doubling.
    expect(usage.promptTokens).toBe(10);
    expect(usage.completionTokens).toBe(3);
  });

  it('streams reasoning before text in order', async () => {
    const chunks: InternalStreamChunk[] = [
      { type: 'reasoning', reasoning: '思考' },
      { type: 'content', content: { type: 'text', text: '答案' } },
    ];
    const provider = makeStreamingProvider(chunks);
    const usage = createUsageAccumulator();
    const model = new GatewayModel({ provider, realModel: 'm', usage });

    const events: { type: string; delta?: string; event?: { type?: string; delta?: string } }[] = [];
    for await (const ev of model.getStreamedResponse(baseModelRequest)) {
      events.push(ev as { type: string; delta?: string; event?: { type?: string; delta?: string } });
    }
    expect(events.map((e) => e.type)).toEqual([
      'response_started',
      'model', // reasoning first
      'output_text_delta', // text second
      'response_done',
    ]);
    expect(events.find((e) => e.type === 'model')?.event?.delta).toBe('思考');
    expect(events.find((e) => e.type === 'output_text_delta')?.delta).toBe('答案');
  });

  it('streams reasoning then assembles function_call from a tool_call chunk', async () => {
    const chunks: InternalStreamChunk[] = [
      { type: 'reasoning', reasoning: '我要调工具' },
      { type: 'tool_call', toolCall: { id: 'c1', name: 'echo', input: { message: 'hi' } } },
    ];
    const provider = makeStreamingProvider(chunks);
    const usage = createUsageAccumulator();
    const model = new GatewayModel({ provider, realModel: 'm', usage });

    const events: {
      type: string;
      event?: { type?: string; delta?: string };
      response?: { output: Array<{ type: string; callId?: string; name?: string }> };
    }[] = [];
    for await (const ev of model.getStreamedResponse(baseModelRequest)) {
      events.push(
        ev as {
          type: string;
          event?: { type?: string; delta?: string };
          response?: { output: Array<{ type: string; callId?: string; name?: string }> };
        },
      );
    }
    // Reasoning streamed via the model escape hatch…
    expect(events.some((e) => e.type === 'model' && e.event?.type === 'reasoning_delta')).toBe(true);
    // …and the function_call is assembled from the tool_call chunk (no backfill).
    const done = events.find((e) => e.type === 'response_done');
    const fc = done?.response?.output.find((o) => o.type === 'function_call');
    expect(fc).toBeDefined();
    expect(fc?.name).toBe('echo');
  });
});

// ── 5. FULL tool-calling loop via real SDK Runner ────────────────────────────
// This is the Phase 0 gate: prove the Responses-API tool round-trip (which the
// project has never run before) works on our own provider pipeline. The SDK
// Runner drives the loop: turn 1 model returns a function_call → Runner executes
// the tool → appends a function_call_result → turn 2 model returns text.

describe('SDK tool-calling loop through GatewayModel', () => {
  it('runs a two-turn tool loop end-to-end (tool_call → execute → final text)', async () => {
    const echoTool = tool({
      name: 'echo',
      description: 'Echo a message back, prefixed with ECHO:',
      parameters: z.object({ message: z.string() }),
      execute: async (input) => `ECHO: ${input.message}`,
    });

    const agent = new Agent({
      name: 'test-agent',
      instructions: 'You are a test agent. Use the echo tool when asked to echo.',
      tools: [echoTool],
    });

    const usage = createUsageAccumulator();
    const provider = makeScriptedProvider([
      toolCallResponse('call_1', 'echo', { message: 'hello world' }),
      textResponse('I echoed your message.'),
    ]);
    // Pin the model directly on the agent as a Model INSTANCE (not a string).
    // run()'s SharedRunOptions does NOT accept modelProvider/tracingDisabled —
    // those live on RunConfig and only take effect via `new Runner(config)`.
    // Attaching the instance bypasses provider resolution (which would otherwise
    // fall back to the default OpenAI provider and demand OPENAI_API_KEY).
    const model = new GatewayModel({ provider, realModel: 'real-model-x', usage });
    agent.model = model;

    const result = await run(agent, 'Please echo "hello world"');

    expect(result.finalOutput).toBe('I echoed your message.');
    // Two model turns: function_call turn + final text turn.
    expect(result.rawResponses).toHaveLength(2);
    // Usage from BOTH turns accumulated into our sink.
    expect(usage.promptTokens).toBe(15 + 12);
    expect(usage.completionTokens).toBe(5 + 8);
  }, 15000);
});

// ── 6. FULL tool-calling loop via getStreamedResponse (stream:true) ───────────
// The loop test above (section 5) exercises the NON-streaming getResponse. This
// one proves the reworked SINGLE-PHASE getStreamedResponse drives the SDK Runner
// tool loop on its own: turn 1 yields a function_call (from a tool_call chunk) →
// Runner executes the tool → turn 2 yields final text. No non-streamed backfill
// occurs (the provider's transformResponse would throw if it did).

describe('SDK tool-calling loop through getStreamedResponse (stream:true)', () => {
  it('runs a two-turn tool loop with NO non-streamed backfill', async () => {
    const echoTool = tool({
      name: 'echo',
      description: 'Echo a message back, prefixed with ECHO:',
      parameters: z.object({ message: z.string() }),
      execute: async (input) => `ECHO: ${input.message}`,
    });

    const agent = new Agent({
      name: 'test-agent',
      instructions: 'You are a test agent. Use the echo tool when asked to echo.',
      tools: [echoTool],
    });

    const usage = createUsageAccumulator();
    // Turn 1: function_call surfaced as a tool_call chunk + usage. Turn 2: text + usage.
    const provider = makeMultiTurnStreamingProvider([
      [
        { type: 'tool_call', toolCall: { id: 'call_1', name: 'echo', input: { message: 'hello' } } },
        { type: 'usage', usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 } },
      ],
      [
        { type: 'content', content: { type: 'text', text: 'I echoed your message.' } },
        { type: 'usage', usage: { promptTokens: 30, completionTokens: 8, totalTokens: 38 } },
      ],
    ]);
    const model = new GatewayModel({ provider, realModel: 'real-model-x', usage });
    agent.model = model;

    const result = await run(agent, 'Please echo "hello"', { stream: true });
    // Drain the streaming events so the run fully completes before we assert.
    for await (const _ of result) {
      void _;
    }

    expect(result.finalOutput).toBe('I echoed your message.');
    // Two model turns: function_call turn + final text turn.
    expect(result.rawResponses).toHaveLength(2);
    // Usage from BOTH turns accumulated (one upstream request each — no backfill doubling).
    expect(usage.promptTokens).toBe(20 + 30);
    expect(usage.completionTokens).toBe(5 + 8);
  }, 15000);
});
