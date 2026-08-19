import { describe, it, expect } from 'vitest';
import { OpenAIProvider } from '../src/providers/openai.js';
import type { InternalRequest } from '../src/types/internal.js';
import type { UpstreamResponse, UpstreamStreamChunk } from '../src/providers/base.js';

const config = { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test-key' };

function makeRequest(overrides: Partial<InternalRequest> = {}): InternalRequest {
  return {
    model: 'gpt-4',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ],
    parameters: {},
    ...overrides,
  };
}

describe('OpenAIProvider', () => {
  describe('transformRequest', () => {
    it('should build correct URL and headers', () => {
      const provider = new OpenAIProvider(config);
      const result = provider.transformRequest(makeRequest());

      expect(result.url).toBe('https://api.openai.com/v1/responses');
      expect(result.method).toBe('POST');
      expect(result.headers['Content-Type']).toBe('application/json');
      expect(result.headers['Authorization']).toBe('Bearer sk-test-key');
    });

    it('should map model and simple text message to input format', () => {
      const provider = new OpenAIProvider(config);
      const result = provider.transformRequest(makeRequest());
      const body = result.body as any;

      expect(body.model).toBe('gpt-4');
      expect(body.input).toEqual([{ role: 'user', content: 'Hello' }]);
    });

    it('should collapse single text content to string', () => {
      const provider = new OpenAIProvider(config);
      const result = provider.transformRequest(
        makeRequest({
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'Just text' }] },
          ],
        })
      );
      const body = result.body as any;
      expect(body.input[0].content).toBe('Just text');
    });

    it('should keep multi-modal content as array', () => {
      const provider = new OpenAIProvider(config);
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
      expect(Array.isArray(body.input[0].content)).toBe(true);
      expect(body.input[0].content).toHaveLength(2);
    });

    it('should convert internal image blocks to input_image parts (base64 → data: URI, url → passthrough)', () => {
      // Responses user content parts only accept input_text/input_image; internal
      // {type:'image', source} must be converted. base64 synthesizes a data: URI,
      // url passes through. text → input_text (the multi-block map also fixes the
      // prior bug where a bare {type:'text'} was ignored by Responses).
      const provider = new OpenAIProvider(config);
      const result = provider.transformRequest(
        makeRequest({
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: 'Describe these' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
              { type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } },
            ],
          }],
        })
      );
      const body = result.body as any;
      expect(body.input[0].content).toEqual([
        { type: 'input_text', text: 'Describe these' },
        { type: 'input_image', image_url: 'data:image/png;base64,abc123' },
        { type: 'input_image', image_url: 'https://example.com/cat.png' },
      ]);
    });

    it('should map maxTokens to max_output_tokens', () => {
      const provider = new OpenAIProvider(config);
      const result = provider.transformRequest(
        makeRequest({ parameters: { maxTokens: 100 } })
      );
      const body = result.body as any;
      expect(body.max_output_tokens).toBe(100);
    });

    it('should map temperature', () => {
      const provider = new OpenAIProvider(config);
      const result = provider.transformRequest(
        makeRequest({ parameters: { temperature: 0.7 } })
      );
      const body = result.body as any;
      expect(body.temperature).toBe(0.7);
    });

    it('should map topP to top_p', () => {
      const provider = new OpenAIProvider(config);
      const result = provider.transformRequest(
        makeRequest({ parameters: { topP: 0.9 } })
      );
      const body = result.body as any;
      expect(body.top_p).toBe(0.9);
    });

    it('should map stream flag', () => {
      const provider = new OpenAIProvider(config);
      const result = provider.transformRequest(
        makeRequest({ parameters: { stream: true } })
      );
      const body = result.body as any;
      expect(body.stream).toBe(true);
    });

    it('should map tools to Responses API flat format', () => {
      const provider = new OpenAIProvider(config);
      const result = provider.transformRequest(
        makeRequest({
          parameters: {
            tools: [
              {
                name: 'get_weather',
                description: 'Get weather info',
                input_schema: { type: 'object', properties: {} },
              },
            ],
          },
        })
      );
      const body = result.body as any;
      expect(body.tools).toEqual([
        {
          type: 'function',
          name: 'get_weather',
          description: 'Get weather info',
          parameters: { type: 'object', properties: {} },
        },
      ]);
    });

    it('should not include tools key when no tools provided', () => {
      const provider = new OpenAIProvider(config);
      const result = provider.transformRequest(makeRequest());
      const body = result.body as any;
      expect(body.tools).toBeUndefined();
    });

    it('should include passthrough params', () => {
      const provider = new OpenAIProvider(config);
      const result = provider.transformRequest(
        makeRequest({ passthrough: { user: 'user-123', seed: 42 } })
      );
      const body = result.body as any;
      expect(body.user).toBe('user-123');
      expect(body.seed).toBe(42);
    });

    it('should omit undefined parameter values', () => {
      const provider = new OpenAIProvider(config);
      const result = provider.transformRequest(
        makeRequest({
          parameters: { maxTokens: undefined, temperature: 0 },
        })
      );
      const body = result.body as any;
      expect(body.max_output_tokens).toBeUndefined();
      expect(body.temperature).toBe(0);
    });

    it('should handle system, assistant roles', () => {
      const provider = new OpenAIProvider(config);
      const result = provider.transformRequest(
        makeRequest({
          messages: [
            { role: 'system', content: [{ type: 'text', text: 'You are helpful' }] },
            { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] },
          ],
        })
      );
      const body = result.body as any;
      expect(body.input[0].role).toBe('system');
      expect(body.input[1].role).toBe('user');
      expect(body.input[2].role).toBe('assistant');
    });

    it('should convert tool role messages to function_call_output', () => {
      const provider = new OpenAIProvider(config);
      const result = provider.transformRequest(
        makeRequest({
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'What is the weather?' }] },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'call_123', name: 'get_weather', input: { city: 'NYC' } }] },
            { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'call_123', content: 'Sunny, 72°F' }] },
          ],
        })
      );
      const body = result.body as any;

      // Tool role should be converted to function_call_output
      expect(body.input[2]).toEqual({
        type: 'function_call_output',
        call_id: 'call_123',
        output: 'Sunny, 72°F',
      });
    });

    it('splits assistant tool_use into top-level function_call items (not message content)', () => {
      // The Agents SDK Runner (and any multi-turn agentic Chat Completions
      // client) replays a prior tool call as an assistant message carrying a
      // tool_use content block. The Responses API does NOT allow tool_use
      // inside an assistant message's content array — only input_text /
      // output_text — so it must become a TOP-LEVEL function_call item.
      // Regression test for the upstream 400:
      //   "Invalid content type: tool_use. Supported types for assistant role
      //    are: 'input_text', 'output_text'."
      const provider = new OpenAIProvider(config);
      const result = provider.transformRequest(
        makeRequest({
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'NYC' } }] },
            { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Sunny' }] },
          ],
        })
      );
      const body = result.body as any;

      // assistant tool_use → top-level function_call item, NOT
      // { role:'assistant', content:[{ type:'tool_use', ... }] }
      expect(body.input[1]).toEqual({
        type: 'function_call',
        call_id: 'call_1',
        name: 'get_weather',
        arguments: '{"city":"NYC"}',
      });
      expect(body.input[1].role).toBeUndefined();
      expect(body.input[1].content).toBeUndefined();

      // tool result still → function_call_output (unchanged)
      expect(body.input[2]).toEqual({
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'Sunny',
      });
    });

    it('emits assistant text as a message AND tool_use as a function_call when both present', () => {
      const provider = new OpenAIProvider(config);
      const result = provider.transformRequest(
        makeRequest({
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
            {
              role: 'assistant',
              content: [
                { type: 'text', text: 'Let me check.' },
                { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'NYC' } },
              ],
            },
          ],
        })
      );
      const body = result.body as any;
      // text → assistant message item (string content)
      expect(body.input[1]).toEqual({ role: 'assistant', content: 'Let me check.' });
      // tool_use → next top-level function_call item
      expect(body.input[2]).toEqual({
        type: 'function_call',
        call_id: 'call_1',
        name: 'get_weather',
        arguments: '{"city":"NYC"}',
      });
    });
  });

  describe('transformResponse', () => {
    it('should map text content from output array', () => {
      const provider = new OpenAIProvider(config);
      const upstream: UpstreamResponse = {
        status: 200,
        headers: {},
        body: {
          id: 'resp_123',
          model: 'gpt-4-0613',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'Hello there!' }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      };

      const result = provider.transformResponse(upstream);

      expect(result.id).toBe('resp_123');
      expect(result.model).toBe('gpt-4-0613');
      expect(result.content).toEqual([{ type: 'text', text: 'Hello there!' }]);
      expect(result.stopReason).toBe('end_turn');
      expect(result.usage).toEqual({
        promptTokens: 10,
        completionTokens: 5,
        cacheRead: 0,
        totalTokens: 15,
      });
    });

    it('should map function_call to ToolUseBlock', () => {
      const provider = new OpenAIProvider(config);
      const upstream: UpstreamResponse = {
        status: 200,
        headers: {},
        body: {
          id: 'resp_456',
          model: 'gpt-4',
          output: [
            {
              type: 'function_call',
              call_id: 'call_abc',
              name: 'get_weather',
              arguments: '{"city":"NYC"}',
            },
          ],
          usage: { input_tokens: 20, output_tokens: 10 },
        },
      };

      const result = provider.transformResponse(upstream);

      expect(result.content).toEqual([
        {
          type: 'tool_use',
          id: 'call_abc',
          name: 'get_weather',
          input: { city: 'NYC' },
        },
      ]);
      expect(result.stopReason).toBe('tool_use');
    });

    it('should map status incomplete to max_tokens', () => {
      const provider = new OpenAIProvider(config);
      const upstream: UpstreamResponse = {
        status: 200,
        headers: {},
        body: {
          id: 'resp_789',
          model: 'gpt-4',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'partial' }],
            },
          ],
          status: 'incomplete',
          usage: { input_tokens: 5, output_tokens: 100 },
        },
      };

      const result = provider.transformResponse(upstream);
      expect(result.stopReason).toBe('max_tokens');
    });

    it('should handle missing usage gracefully', () => {
      const provider = new OpenAIProvider(config);
      const upstream: UpstreamResponse = {
        status: 200,
        headers: {},
        body: {
          id: 'resp_000',
          model: 'gpt-4',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'hi' }],
            },
          ],
        },
      };

      const result = provider.transformResponse(upstream);
      expect(result.usage).toEqual({
        promptTokens: 0,
        completionTokens: 0,
        cacheRead: 0,
        totalTokens: 0,
      });
    });

    it('should handle empty output array', () => {
      const provider = new OpenAIProvider(config);
      const upstream: UpstreamResponse = {
        status: 200,
        headers: {},
        body: {
          id: 'resp_empty',
          model: 'gpt-4',
          output: [],
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      };

      const result = provider.transformResponse(upstream);
      expect(result.content).toEqual([]);
    });

    it('should skip reasoning type items', () => {
      const provider = new OpenAIProvider(config);
      const upstream: UpstreamResponse = {
        status: 200,
        headers: {},
        body: {
          id: 'resp_reason',
          model: 'gpt-4',
          output: [
            { type: 'reasoning', content: 'thinking...' },
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'final answer' }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      };

      const result = provider.transformResponse(upstream);
      expect(result.content).toEqual([{ type: 'text', text: 'final answer' }]);
    });
  });

  describe('transformStreamChunk', () => {
    it('should handle text delta event', () => {
      const provider = new OpenAIProvider(config);
      const chunk: UpstreamStreamChunk = {
        data: {
          type: 'response.output_text.delta',
          delta: 'Hello',
        },
      };

      const result = provider.transformStreamChunk(chunk);

      expect(result).toEqual({
        type: 'content',
        content: { type: 'text', text: 'Hello' },
      });
    });

    it('should return null for text delta with no delta content', () => {
      const provider = new OpenAIProvider(config);
      const chunk: UpstreamStreamChunk = {
        data: {
          type: 'response.output_text.delta',
          delta: '',
        },
      };

      const result = provider.transformStreamChunk(chunk);
      expect(result).toBeNull();
    });

    it('should handle completed event with usage', () => {
      const provider = new OpenAIProvider(config);
      const chunk: UpstreamStreamChunk = {
        data: {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [],
            usage: { input_tokens: 10, output_tokens: 20 },
          },
        },
      };

      const result = provider.transformStreamChunk(chunk);

      // response.completed is terminal: the usage chunk must also carry
      // stopReason so the Chat Completions route can emit finish_reason from
      // its usage branch (there is no separate stop chunk for this event).
      expect(result).toEqual({
        type: 'usage',
        stopReason: 'end_turn',
        usage: {
          promptTokens: 10,
          completionTokens: 20,
          cacheRead: 0,
          totalTokens: 30,
        },
      });
    });

    it('should handle completed event without usage', () => {
      const provider = new OpenAIProvider(config);
      const chunk: UpstreamStreamChunk = {
        data: {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [],
          },
        },
      };

      const result = provider.transformStreamChunk(chunk);

      expect(result).toEqual({
        type: 'stop',
        stopReason: 'end_turn',
      });
    });

    it('should handle completed event with incomplete status', () => {
      const provider = new OpenAIProvider(config);
      const chunk: UpstreamStreamChunk = {
        data: {
          type: 'response.completed',
          response: {
            status: 'incomplete',
            output: [],
            usage: { input_tokens: 5, output_tokens: 100 },
          },
        },
      };

      const result = provider.transformStreamChunk(chunk);

      expect(result).toEqual({
        type: 'usage',
        stopReason: 'max_tokens',
        usage: {
          promptTokens: 5,
          completionTokens: 100,
          cacheRead: 0,
          totalTokens: 105,
        },
      });
    });

    it('should return null for other events', () => {
      const provider = new OpenAIProvider(config);
      const chunk: UpstreamStreamChunk = {
        data: {
          type: 'response.created',
          response: { id: 'resp_123' },
        },
      };

      const result = provider.transformStreamChunk(chunk);
      expect(result).toBeNull();
    });

    it('should return null for output_item.added event', () => {
      const provider = new OpenAIProvider(config);
      const chunk: UpstreamStreamChunk = {
        data: {
          type: 'response.output_item.added',
          item: { type: 'message' },
        },
      };

      const result = provider.transformStreamChunk(chunk);
      expect(result).toBeNull();
    });

    // response.output_item.done for a function_call carries the COMPLETE item
    // (name + call_id + arguments). Surfacing it as a tool_call chunk lets the
    // streaming-only GatewayModel assemble the authoritative output WITHOUT a
    // non-streamed backfill.
    it('surfaces a complete function_call from output_item.done as a tool_call chunk', () => {
      const provider = new OpenAIProvider(config);
      const chunk: UpstreamStreamChunk = {
        data: {
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            call_id: 'call_abc',
            name: 'get_weather',
            arguments: '{"city":"NYC"}',
          },
        },
      };

      const result = provider.transformStreamChunk(chunk);
      expect(result).toEqual({
        type: 'tool_call',
        toolCall: { id: 'call_abc', name: 'get_weather', input: { city: 'NYC' } },
      });
    });

    it('returns null for output_item.done of a non-function_call item (e.g. message)', () => {
      const provider = new OpenAIProvider(config);
      const chunk: UpstreamStreamChunk = {
        data: {
          type: 'response.output_item.done',
          item: { type: 'message', id: 'msg_1', content: [] },
        },
      };

      const result = provider.transformStreamChunk(chunk);
      expect(result).toBeNull();
    });

    it('falls back to {} for malformed function_call arguments', () => {
      const provider = new OpenAIProvider(config);
      const chunk: UpstreamStreamChunk = {
        data: {
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            call_id: 'call_bad',
            name: 'echo',
            arguments: 'not-json',
          },
        },
      };

      const result = provider.transformStreamChunk(chunk);
      expect(result).toEqual({
        type: 'tool_call',
        toolCall: { id: 'call_bad', name: 'echo', input: {} },
      });
    });
  });
});
