import type {
  InternalRequest,
  InternalResponse,
  InternalStreamChunk,
  ContentBlock,
} from '../types/internal.js';
import {
  BaseProvider,
  type UpstreamRequest,
  type UpstreamResponse,
  type UpstreamStreamChunk,
  type ProviderConfig,
} from './base.js';

export class AnthropicProvider extends BaseProvider {
  name = 'anthropic';

  // Pending tool_use block being accumulated from input_json_delta events.
  // Anthropic streams tool_use arguments incrementally: content_block_start
  // carries id+name with empty input, input_json_delta fragments carry
  // partial_json, content_block_stop closes the block. We accumulate the
  // fragments and emit a SINGLE complete {type:'tool_call'} chunk at
  // content_block_stop — matching how OpenAI/DashScope surface tool calls
  // (from output_item.done), so streaming routes consume one unified tool_call
  // shape regardless of upstream. Per-request instance (createProvider news one
  // each request), so this state never leaks across concurrent streams.
  private pendingToolUse: { id: string; name: string; jsonBuf: string } | null = null;

  constructor(config: ProviderConfig) {
    super(config);
  }

  transformRequest(request: InternalRequest): UpstreamRequest {
    const systemMessages = request.messages.filter((m) => m.role === 'system');
    const nonSystemMessages = request.messages.filter((m) => m.role !== 'system');

    const system =
      systemMessages.length > 0
        ? systemMessages
            .map((m) =>
              m.content
                .filter((b) => b.type === 'text')
                .map((b) => (b as { type: 'text'; text: string }).text)
                .join('')
            )
            .join('\n')
        : undefined;

    const messages = nonSystemMessages.map((msg) => {
      const role = msg.role === 'tool' ? 'user' : msg.role;
      const content =
        msg.content.length === 1 && msg.content[0].type === 'text'
          ? (msg.content[0] as { type: 'text'; text: string }).text
          : msg.content;

      return { role, content };
    });

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.parameters.maxTokens ?? 4096,
      ...request.passthrough,
    };

    if (system !== undefined) body.system = system;

    const { temperature, topP, stop, stream } = request.parameters;

    if (temperature !== undefined) body.temperature = temperature;
    if (topP !== undefined) body.top_p = topP;
    if (stop !== undefined) body.stop_sequences = stop;
    if (stream !== undefined) body.stream = stream;

    if (request.parameters.tools && request.parameters.tools.length > 0) {
      body.tools = request.parameters.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
      }));
    }

    return {
      url: `${this.config.baseUrl}/v1/messages`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body,
    };
  }

  transformResponse(response: UpstreamResponse): InternalResponse {
    const data = response.body as any;

    const content: ContentBlock[] = (data.content || []).map((block: any) => {
      if (block.type === 'text') {
        return { type: 'text', text: block.text };
      }
      if (block.type === 'tool_use') {
        return {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        };
      }
      return block;
    });

    const usage = data.usage || {};
    // Anthropic reports cache as SEPARATE fields not included in input_tokens.
    // promptTokens stays the non-cached input (matches Anthropic's input_tokens
    // semantics for clients); totalTokens folds cache in for quota tracking.
    const cacheCreation = usage.cache_creation_input_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const promptTokens = usage.input_tokens || 0;
    const completionTokens = usage.output_tokens || 0;

    return {
      id: data.id,
      model: data.model,
      content,
      stopReason: data.stop_reason || undefined,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens + cacheCreation + cacheRead,
        cacheRead,
        cacheCreation,
      },
    };
  }

  transformStreamChunk(chunk: UpstreamStreamChunk): InternalStreamChunk | null {
    const data = chunk.data as any;

    // message_start with usage (carries the full input-side breakdown incl. cache)
    if (data.type === 'message_start' && data.message?.usage) {
      const usage = data.message.usage;
      const cacheCreation = usage.cache_creation_input_tokens || 0;
      const cacheRead = usage.cache_read_input_tokens || 0;
      const promptTokens = usage.input_tokens || 0;
      const completionTokens = usage.output_tokens || 0;
      return {
        type: 'usage',
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens + cacheCreation + cacheRead,
          cacheRead,
          cacheCreation,
        },
      };
    }

    // content_block_delta with text
    if (data.type === 'content_block_delta' && data.delta?.text) {
      return {
        type: 'content',
        content: { type: 'text', text: data.delta.text },
      };
    }

    // content_block_start for a tool_use block: capture id+name and begin
    // accumulating input_json_delta fragments. A text content_block_start still
    // falls through to null (the route opens text blocks lazily on first delta).
    if (
      data.type === 'content_block_start' &&
      data.content_block?.type === 'tool_use'
    ) {
      const cb = data.content_block;
      this.pendingToolUse = { id: cb.id, name: cb.name, jsonBuf: '' };
      return null;
    }

    // input_json_delta: accumulate partial JSON into the pending tool_use block.
    if (
      data.type === 'content_block_delta' &&
      data.delta?.type === 'input_json_delta' &&
      this.pendingToolUse
    ) {
      this.pendingToolUse.jsonBuf += data.delta.partial_json ?? '';
      return null;
    }

    // content_block_stop closing a tool_use block: emit the complete tool_call
    // (full input reconstructed from accumulated fragments). A bare
    // content_block_stop with no pending tool_use (e.g. closing a text block)
    // falls through to null — the route manages text-block lifecycle itself.
    if (data.type === 'content_block_stop' && this.pendingToolUse) {
      const ptu = this.pendingToolUse;
      this.pendingToolUse = null;
      let input: unknown = {};
      try {
        input = ptu.jsonBuf ? JSON.parse(ptu.jsonBuf) : {};
      } catch {
        input = {};
      }
      return {
        type: 'tool_call',
        toolCall: { id: ptu.id, name: ptu.name, input },
      };
    }

    // message_delta carries the FINAL output_tokens (and usually stop_reason).
    // Guard on either so we don't miss the final usage when stop_reason is absent.
    // promptTokens MUST stay 0 here — the route's stop branch only reads
    // completionTokens; a non-zero promptTokens would overwrite message_start's
    // correct value (Anthropic doesn't resend input in message_delta).
    if (data.type === 'message_delta' && (data.delta?.stop_reason || data.usage)) {
      const outputTokens = data.usage?.output_tokens || 0;
      return {
        type: 'stop',
        stopReason: data.delta?.stop_reason,
        usage: {
          promptTokens: 0,
          completionTokens: outputTokens,
          totalTokens: outputTokens,
        },
      };
    }

    return null;
  }
}
