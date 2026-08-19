import { describe, it, expect } from 'vitest';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import type { InternalRequest } from '../src/types/internal.js';
import type { UpstreamResponse, UpstreamStreamChunk } from '../src/providers/base.js';

const config = { baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-test-key' };

function makeRequest(overrides: Partial<InternalRequest> = {}): InternalRequest {
  return {
    model: 'claude-sonnet-4-20250514',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ],
    parameters: {},
    ...overrides,
  };
}

describe('AnthropicProvider', () => {
  describe('transformRequest', () => {
    it('should build correct URL and headers', () => {
      const provider = new AnthropicProvider(config);
      const result = provider.transformRequest(makeRequest());

      expect(result.url).toBe('https://api.anthropic.com/v1/messages');
      expect(result.method).toBe('POST');
      expect(result.headers['Content-Type']).toBe('application/json');
      expect(result.headers['x-api-key']).toBe('sk-ant-test-key');
      expect(result.headers['anthropic-version']).toBe('2023-06-01');
    });

    it('should map model and simple text message', () => {
      const provider = new AnthropicProvider(config);
      const result = provider.transformRequest(makeRequest());
      const body = result.body as any;

      expect(body.model).toBe('claude-sonnet-4-20250514');
      expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    });

    it('should default max_tokens to 4096', () => {
      const provider = new AnthropicProvider(config);
      const result = provider.transformRequest(makeRequest());
      const body = result.body as any;
      expect(body.max_tokens).toBe(4096);
    });

    it('should use provided maxTokens', () => {
      const provider = new AnthropicProvider(config);
      const result = provider.transformRequest(
        makeRequest({ parameters: { maxTokens: 200 } })
      );
      const body = result.body as any;
      expect(body.max_tokens).toBe(200);
    });

    it('should extract system messages into body.system', () => {
      const provider = new AnthropicProvider(config);
      const result = provider.transformRequest(
        makeRequest({
          messages: [
            { role: 'system', content: [{ type: 'text', text: 'Be helpful' }] },
            { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
          ],
        })
      );
      const body = result.body as any;

      expect(body.system).toBe('Be helpful');
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].role).toBe('user');
    });

    it('should join multiple system messages with newline', () => {
      const provider = new AnthropicProvider(config);
      const result = provider.transformRequest(
        makeRequest({
          messages: [
            { role: 'system', content: [{ type: 'text', text: 'Rule 1' }] },
            { role: 'system', content: [{ type: 'text', text: 'Rule 2' }] },
            { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
          ],
        })
      );
      const body = result.body as any;
      expect(body.system).toBe('Rule 1\nRule 2');
    });

    it('should not include system field when no system messages', () => {
      const provider = new AnthropicProvider(config);
      const result = provider.transformRequest(makeRequest());
      const body = result.body as any;
      expect(body.system).toBeUndefined();
    });

    it('should map tool role to user', () => {
      const provider = new AnthropicProvider(config);
      const result = provider.transformRequest(
        makeRequest({
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'use tool' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'calling tool' }] },
            { role: 'tool', content: [{ type: 'text', text: 'tool result' }] },
          ],
        })
      );
      const body = result.body as any;
      expect(body.messages[2].role).toBe('user');
    });

    it('should collapse single text content to string', () => {
      const provider = new AnthropicProvider(config);
      const result = provider.transformRequest(
        makeRequest({
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'Just text' }] },
          ],
        })
      );
      const body = result.body as any;
      expect(body.messages[0].content).toBe('Just text');
    });

    it('should keep multi-modal content as array', () => {
      const provider = new AnthropicProvider(config);
      const result = provider.transformRequest(
        makeRequest({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Describe this' },
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'abc123',
                  },
                },
              ],
            },
          ],
        })
      );
      const body = result.body as any;
      expect(Array.isArray(body.messages[0].content)).toBe(true);
      expect(body.messages[0].content).toHaveLength(2);
    });

    it('should map temperature', () => {
      const provider = new AnthropicProvider(config);
      const result = provider.transformRequest(
        makeRequest({ parameters: { temperature: 0.5 } })
      );
      const body = result.body as any;
      expect(body.temperature).toBe(0.5);
    });

    it('should map topP to top_p', () => {
      const provider = new AnthropicProvider(config);
      const result = provider.transformRequest(
        makeRequest({ parameters: { topP: 0.95 } })
      );
      const body = result.body as any;
      expect(body.top_p).toBe(0.95);
    });

    it('should map stop to stop_sequences', () => {
      const provider = new AnthropicProvider(config);
      const result = provider.transformRequest(
        makeRequest({ parameters: { stop: ['END', '\n'] } })
      );
      const body = result.body as any;
      expect(body.stop_sequences).toEqual(['END', '\n']);
    });

    it('should map stream flag', () => {
      const provider = new AnthropicProvider(config);
      const result = provider.transformRequest(
        makeRequest({ parameters: { stream: true } })
      );
      const body = result.body as any;
      expect(body.stream).toBe(true);
    });

    it('should map tools with name, description, input_schema', () => {
      const provider = new AnthropicProvider(config);
      const result = provider.transformRequest(
        makeRequest({
          parameters: {
            tools: [
              {
                name: 'get_weather',
                description: 'Get weather info',
                input_schema: {
                  type: 'object',
                  properties: { city: { type: 'string' } },
                },
              },
            ],
          },
        })
      );
      const body = result.body as any;
      expect(body.tools).toEqual([
        {
          name: 'get_weather',
          description: 'Get weather info',
          input_schema: {
            type: 'object',
            properties: { city: { type: 'string' } },
          },
        },
      ]);
    });

    it('should not include tools key when no tools provided', () => {
      const provider = new AnthropicProvider(config);
      const result = provider.transformRequest(makeRequest());
      const body = result.body as any;
      expect(body.tools).toBeUndefined();
    });

    it('should include passthrough params', () => {
      const provider = new AnthropicProvider(config);
      const result = provider.transformRequest(
        makeRequest({ passthrough: { metadata: { user_id: 'u-1' } } })
      );
      const body = result.body as any;
      expect(body.metadata).toEqual({ user_id: 'u-1' });
    });

    it('should not include undefined optional params', () => {
      const provider = new AnthropicProvider(config);
      const result = provider.transformRequest(makeRequest());
      const body = result.body as any;
      expect(body.temperature).toBeUndefined();
      expect(body.top_p).toBeUndefined();
      expect(body.stop_sequences).toBeUndefined();
      expect(body.stream).toBeUndefined();
    });
  });

  describe('transformResponse', () => {
    it('should map text content blocks', () => {
      const provider = new AnthropicProvider(config);
      const upstream: UpstreamResponse = {
        status: 200,
        headers: {},
        body: {
          id: 'msg_123',
          model: 'claude-sonnet-4-20250514',
          content: [{ type: 'text', text: 'Hello there!' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      };

      const result = provider.transformResponse(upstream);

      expect(result.id).toBe('msg_123');
      expect(result.model).toBe('claude-sonnet-4-20250514');
      expect(result.content).toEqual([{ type: 'text', text: 'Hello there!' }]);
      expect(result.stopReason).toBe('end_turn');
      expect(result.usage).toEqual({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cacheRead: 0,
        cacheCreation: 0,
      });
    });

    it('should map tool_use content blocks', () => {
      const provider = new AnthropicProvider(config);
      const upstream: UpstreamResponse = {
        status: 200,
        headers: {},
        body: {
          id: 'msg_456',
          model: 'claude-sonnet-4-20250514',
          content: [
            { type: 'text', text: 'Let me check the weather.' },
            {
              type: 'tool_use',
              id: 'toolu_abc',
              name: 'get_weather',
              input: { city: 'NYC' },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 20, output_tokens: 15 },
        },
      };

      const result = provider.transformResponse(upstream);

      expect(result.content).toHaveLength(2);
      expect(result.content[0]).toEqual({
        type: 'text',
        text: 'Let me check the weather.',
      });
      expect(result.content[1]).toEqual({
        type: 'tool_use',
        id: 'toolu_abc',
        name: 'get_weather',
        input: { city: 'NYC' },
      });
      expect(result.stopReason).toBe('tool_use');
    });

    it('should map stop_reason values correctly', () => {
      const provider = new AnthropicProvider(config);

      for (const [stopReason, expected] of [
        ['end_turn', 'end_turn'],
        ['max_tokens', 'max_tokens'],
        ['stop_sequence', 'stop_sequence'],
        ['tool_use', 'tool_use'],
      ] as const) {
        const upstream: UpstreamResponse = {
          status: 200,
          headers: {},
          body: {
            id: 'msg_test',
            model: 'claude-sonnet-4-20250514',
            content: [],
            stop_reason: stopReason,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };

        const result = provider.transformResponse(upstream);
        expect(result.stopReason).toBe(expected);
      }
    });

    it('should map usage with input_tokens and output_tokens', () => {
      const provider = new AnthropicProvider(config);
      const upstream: UpstreamResponse = {
        status: 200,
        headers: {},
        body: {
          id: 'msg_usage',
          model: 'claude-sonnet-4-20250514',
          content: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      };

      const result = provider.transformResponse(upstream);
      expect(result.usage.promptTokens).toBe(100);
      expect(result.usage.completionTokens).toBe(50);
      expect(result.usage.totalTokens).toBe(150);
    });

    it('should fold cache_creation/cache_read into totalTokens (non-streaming)', () => {
      const provider = new AnthropicProvider(config);
      const upstream: UpstreamResponse = {
        status: 200,
        headers: {},
        body: {
          id: 'msg_cached',
          model: 'claude-sonnet-4-20250514',
          content: [],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 12,
            output_tokens: 200,
            cache_creation_input_tokens: 5000,
            cache_read_input_tokens: 30000,
          },
        },
      };

      const result = provider.transformResponse(upstream);
      // promptTokens is the NON-cached input; total folds cache in; breakdown preserved
      expect(result.usage.promptTokens).toBe(12);
      expect(result.usage.completionTokens).toBe(200);
      expect(result.usage.cacheRead).toBe(30000);
      expect(result.usage.cacheCreation).toBe(5000);
      expect(result.usage.totalTokens).toBe(35212);
    });

    it('should handle missing usage gracefully', () => {
      const provider = new AnthropicProvider(config);
      const upstream: UpstreamResponse = {
        status: 200,
        headers: {},
        body: {
          id: 'msg_no_usage',
          model: 'claude-sonnet-4-20250514',
          content: [],
          stop_reason: 'end_turn',
        },
      };

      const result = provider.transformResponse(upstream);
      expect(result.usage).toEqual({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheRead: 0,
        cacheCreation: 0,
      });
    });

    it('should handle null stop_reason', () => {
      const provider = new AnthropicProvider(config);
      const upstream: UpstreamResponse = {
        status: 200,
        headers: {},
        body: {
          id: 'msg_null_stop',
          model: 'claude-sonnet-4-20250514',
          content: [{ type: 'text', text: 'hi' }],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };

      const result = provider.transformResponse(upstream);
      expect(result.stopReason).toBeUndefined();
    });
  });

  describe('transformStreamChunk', () => {
    it('should handle message_start with usage', () => {
      const provider = new AnthropicProvider(config);
      const chunk: UpstreamStreamChunk = {
        data: {
          type: 'message_start',
          message: {
            id: 'msg_123',
            usage: { input_tokens: 25, output_tokens: 0 },
          },
        },
      };

      const result = provider.transformStreamChunk(chunk);

      expect(result).toEqual({
        type: 'usage',
        usage: {
          promptTokens: 25,
          completionTokens: 0,
          totalTokens: 25,
          cacheRead: 0,
          cacheCreation: 0,
        },
      });
    });

    it('should fold cache tokens into totalTokens in message_start', () => {
      const provider = new AnthropicProvider(config);
      const chunk: UpstreamStreamChunk = {
        data: {
          type: 'message_start',
          message: {
            id: 'msg_cached',
            usage: {
              input_tokens: 12,
              output_tokens: 0,
              cache_creation_input_tokens: 5000,
              cache_read_input_tokens: 30000,
            },
          },
        },
      };

      const result = provider.transformStreamChunk(chunk);

      expect(result).toEqual({
        type: 'usage',
        usage: {
          promptTokens: 12, // non-cached input only
          completionTokens: 0,
          totalTokens: 35012, // input + cache_creation + cache_read
          cacheRead: 30000,
          cacheCreation: 5000,
        },
      });
    });

    it('should handle content_block_delta with text', () => {
      const provider = new AnthropicProvider(config);
      const chunk: UpstreamStreamChunk = {
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello world' },
        },
      };

      const result = provider.transformStreamChunk(chunk);

      expect(result).toEqual({
        type: 'content',
        content: { type: 'text', text: 'Hello world' },
      });
    });

    it('should handle message_delta with stop_reason', () => {
      const provider = new AnthropicProvider(config);
      const chunk: UpstreamStreamChunk = {
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
        },
      };

      const result = provider.transformStreamChunk(chunk);

      // No usage here → completionTokens stays 0 (the route keeps message_start's
      // value); promptTokens is 0 so it won't overwrite the input-side value.
      expect(result).toEqual({
        type: 'stop',
        stopReason: 'end_turn',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      });
    });

    it('should handle message_delta with tool_use stop_reason', () => {
      const provider = new AnthropicProvider(config);
      const chunk: UpstreamStreamChunk = {
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
        },
      };

      const result = provider.transformStreamChunk(chunk);

      expect(result).toEqual({
        type: 'stop',
        stopReason: 'tool_use',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      });
    });

    it('should read final output_tokens from message_delta usage', () => {
      const provider = new AnthropicProvider(config);
      const chunk: UpstreamStreamChunk = {
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 415 },
        },
      };

      const result = provider.transformStreamChunk(chunk);

      expect(result).toEqual({
        type: 'stop',
        stopReason: 'end_turn',
        usage: { promptTokens: 0, completionTokens: 415, totalTokens: 415 },
      });
    });

    it('should fire on message_delta carrying usage without stop_reason', () => {
      // Some streams send a terminal message_delta with usage but no stop_reason —
      // the guard `stop_reason || usage` must still catch it.
      const provider = new AnthropicProvider(config);
      const chunk: UpstreamStreamChunk = {
        data: {
          type: 'message_delta',
          delta: {},
          usage: { output_tokens: 88 },
        },
      };

      const result = provider.transformStreamChunk(chunk);

      expect(result).toEqual({
        type: 'stop',
        stopReason: undefined,
        usage: { promptTokens: 0, completionTokens: 88, totalTokens: 88 },
      });
    });

    it('should return null for unrecognized event types', () => {
      const provider = new AnthropicProvider(config);
      const chunk: UpstreamStreamChunk = {
        data: { type: 'ping' },
      };

      const result = provider.transformStreamChunk(chunk);
      expect(result).toBeNull();
    });

    it('should return null for content_block_start events', () => {
      const provider = new AnthropicProvider(config);
      const chunk: UpstreamStreamChunk = {
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      };

      const result = provider.transformStreamChunk(chunk);
      expect(result).toBeNull();
    });

    it('should return null for content_block_stop events', () => {
      const provider = new AnthropicProvider(config);
      const chunk: UpstreamStreamChunk = {
        data: { type: 'content_block_stop', index: 0 },
      };

      const result = provider.transformStreamChunk(chunk);
      expect(result).toBeNull();
    });

    it('should return null for message_delta without stop_reason', () => {
      const provider = new AnthropicProvider(config);
      const chunk: UpstreamStreamChunk = {
        data: {
          type: 'message_delta',
          delta: {},
        },
      };

      const result = provider.transformStreamChunk(chunk);
      expect(result).toBeNull();
    });

    it('accumulates input_json_delta fragments and emits a complete tool_call', () => {
      // Anthropic streams a tool_use as content_block_start (id+name, empty
      // input) → input_json_delta* (partial_json fragments) → content_block_stop.
      // The provider must accumulate the fragments and emit ONE complete
      // {type:'tool_call'} at content_block_stop — matching how OpenAI/DashScope
      // surface tool calls, so routes consume a unified shape.
      const provider = new AnthropicProvider(config);

      const start = provider.transformStreamChunk({
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_abc', name: 'get_weather', input: {} },
        },
      });
      expect(start).toBeNull();

      const d1 = provider.transformStreamChunk({
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"city":' },
        },
      });
      expect(d1).toBeNull();

      const d2 = provider.transformStreamChunk({
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: ' "NYC"}' },
        },
      });
      expect(d2).toBeNull();

      const done = provider.transformStreamChunk({
        data: { type: 'content_block_stop', index: 0 },
      });
      expect(done).toEqual({
        type: 'tool_call',
        toolCall: { id: 'toolu_abc', name: 'get_weather', input: { city: 'NYC' } },
      });
    });

    it('clears pending state so successive tool_use blocks are independent', () => {
      // The pendingToolUse slot must reset at content_block_stop, otherwise the
      // second tool_use in one stream would be contaminated by the first's
      // accumulated fragments.
      const provider = new AnthropicProvider(config);

      provider.transformStreamChunk({
        data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'a', input: {} } },
      });
      provider.transformStreamChunk({
        data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } },
      });
      const done1 = provider.transformStreamChunk({ data: { type: 'content_block_stop', index: 0 } });
      expect(done1).toEqual({ type: 'tool_call', toolCall: { id: 'toolu_1', name: 'a', input: { x: 1 } } });

      provider.transformStreamChunk({
        data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_2', name: 'b', input: {} } },
      });
      provider.transformStreamChunk({
        data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"y":2}' } },
      });
      const done2 = provider.transformStreamChunk({ data: { type: 'content_block_stop', index: 1 } });
      expect(done2).toEqual({ type: 'tool_call', toolCall: { id: 'toolu_2', name: 'b', input: { y: 2 } } });
    });

    it('ignores input_json_delta when no tool_use block is pending', () => {
      // Defensive: a stray input_json_delta without a preceding tool_use
      // content_block_start must not crash or fabricate a tool_call.
      const provider = new AnthropicProvider(config);
      const result = provider.transformStreamChunk({
        data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":1}' } },
      });
      expect(result).toBeNull();
    });
  });
});
