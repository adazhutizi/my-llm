import type {
  InternalRequest,
  InternalResponse,
  InternalStreamChunk,
  ContentBlock,
  ImageBlock,
} from '../types/internal.js';
import {
  BaseProvider,
  type UpstreamRequest,
  type UpstreamResponse,
  type UpstreamStreamChunk,
  type ProviderConfig,
} from './base.js';
import { sourceToImageUrl } from '../utils/image-block.js';

function removeUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

// Split OpenAI's usage into the gateway's Anthropic-style cache columns.
// OpenAI's input_tokens ALREADY includes cached_tokens (the cache hit is a
// subset reported under input_tokens_details). To make the cache hit visible
// WITHOUT double-counting under the gateway's quota formula
// total = prompt + completion + cacheRead (usage-track.ts), we peel cached out:
// promptTokens = non-cached input, cacheRead = cached portion.
// See CLAUDE.md "Token 统计与配额口径".
function splitOpenAIUsage(usage: any): {
  promptTokens: number;
  completionTokens: number;
  cacheRead: number;
} {
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
  const input = usage?.input_tokens ?? 0;
  return {
    promptTokens: Math.max(0, input - cached),
    completionTokens: usage?.output_tokens ?? 0,
    cacheRead: cached,
  };
}

export class OpenAIProvider extends BaseProvider {
  name = 'openai';

  constructor(config: ProviderConfig) {
    super(config);
  }

  transformRequest(request: InternalRequest): UpstreamRequest {
    // Convert internal messages to Responses API input format
    const input: unknown[] = [];

    for (const msg of request.messages) {
      // Handle tool role messages (tool results)
      if (msg.role === 'tool') {
        // Convert tool results to function_call_output items
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            const toolResult = block as { type: 'tool_result'; tool_use_id: string; content: string | ContentBlock[] };
            input.push({
              type: 'function_call_output',
              call_id: toolResult.tool_use_id,
              output: typeof toolResult.content === 'string'
                ? toolResult.content
                : JSON.stringify(toolResult.content),
            });
          }
        }
        continue;
      }

      // Assistant messages may carry tool_use blocks (a prior tool call replayed
      // by the Agents SDK Runner, or a multi-turn agentic Chat Completions
      // client). The Responses API does NOT allow tool_use inside an assistant
      // message's content array — function calls are top-level output items —
      // so split text → assistant message, tool_use → top-level function_call
      // items. (Anthropic's Messages API keeps tool_use in content; this split
      // is OpenAI-Responses-specific.)
      if (msg.role === 'assistant') {
        const textParts: string[] = [];
        const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push((block as { type: 'text'; text: string }).text);
          } else if (block.type === 'tool_use') {
            const tu = block as { type: 'tool_use'; id: string; name: string; input: unknown };
            toolUses.push({ id: tu.id, name: tu.name, input: tu.input });
          }
        }
        if (textParts.length > 0) {
          input.push({ role: 'assistant', content: textParts.join('') });
        }
        for (const tu of toolUses) {
          input.push(
            removeUndefined({
              type: 'function_call',
              call_id: tu.id,
              name: tu.name,
              arguments: JSON.stringify(tu.input ?? {}),
            }),
          );
        }
        continue;
      }

      // Regular messages (user, system). Single text block → plain string;
      // otherwise map each block to its Responses content-part shape
      // (input_text / input_image) — Responses user content parts only accept
      // input_text/input_image, so internal {type:'text'}/{type:'image'} sent
      // verbatim are ignored by the upstream. image → input_image via helper
      // (base64 synthesizes a data: URI, url passes through).
      let content: unknown;
      if (msg.content.length === 1 && msg.content[0].type === 'text') {
        content = (msg.content[0] as { type: 'text'; text: string }).text;
      } else {
        content = msg.content.map((block) => {
          if (block.type === 'text') {
            return { type: 'input_text', text: (block as { type: 'text'; text: string }).text };
          }
          if (block.type === 'image') {
            return {
              type: 'input_image',
              image_url: sourceToImageUrl((block as ImageBlock).source),
            };
          }
          return block;
        });
      }

      input.push(removeUndefined({
        role: msg.role,
        content,
      }));
    }

    const body: Record<string, unknown> = {
      model: request.model,
      input,
      ...request.passthrough,
    };

    const { maxTokens, temperature, topP, tools, stream, reasoning } = request.parameters;

    // Responses API uses max_output_tokens instead of max_tokens
    if (maxTokens !== undefined) body.max_output_tokens = maxTokens;
    if (temperature !== undefined) body.temperature = temperature;
    if (topP !== undefined) body.top_p = topP;
    // Note: Responses API does not support 'stop' parameter
    if (stream !== undefined) body.stream = stream;
    // Reasoning: {summary:'auto'} makes the model stream reasoning summary deltas
    // (response.reasoning_summary_text.delta). Only valid for reasoning models.
    if (reasoning) body.reasoning = removeUndefined({ summary: reasoning.summary, effort: reasoning.effort });

    // Responses API uses flat tool format: {type:"function", name, description, parameters}
    if (tools && tools.length > 0) {
      body.tools = tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      }));
    }

    return {
      url: `${this.config.baseUrl}/responses`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: removeUndefined(body),
    };
  }

  transformResponse(response: UpstreamResponse): InternalResponse {
    const data = response.body as any;
    const output: any[] = data.output || [];

    const content: ContentBlock[] = [];
    let hasToolCalls = false;

    for (const item of output) {
      if (item.type === 'message') {
        // Extract text content from message
        const messageContent = item.content || [];
        for (const block of messageContent) {
          if (block.type === 'output_text' && block.text) {
            content.push({ type: 'text', text: block.text });
          }
        }
      } else if (item.type === 'function_call') {
        // Convert function_call to ToolUseBlock
        hasToolCalls = true;
        content.push({
          type: 'tool_use',
          id: item.call_id,
          name: item.name,
          input: JSON.parse(item.arguments || '{}'),
        });
      }
      // Skip 'reasoning' type items
    }

    // Responses API uses input_tokens and output_tokens. Split the cache hit
    // (cached_tokens, a subset of input_tokens under input_tokens_details) out
    // of promptTokens — see splitOpenAIUsage.
    const usage = data.usage || {};
    const { promptTokens, completionTokens, cacheRead } = splitOpenAIUsage(usage);

    // Determine stop reason
    let stopReason: InternalResponse['stopReason'] = 'end_turn';
    if (hasToolCalls) {
      stopReason = 'tool_use';
    } else if (data.status === 'incomplete') {
      stopReason = 'max_tokens';
    }

    return {
      id: data.id,
      model: data.model,
      content,
      stopReason,
      usage: {
        promptTokens,
        completionTokens,
        cacheRead,
        totalTokens: promptTokens + completionTokens + cacheRead,
      },
    };
  }

  transformStreamChunk(chunk: UpstreamStreamChunk): InternalStreamChunk | null {
    const data = chunk.data as any;

    // Responses API streaming events are identified by 'type' field
    const eventType = data.type;

    // Text delta event
    if (eventType === 'response.output_text.delta') {
      if (data.delta) {
        return {
          type: 'content',
          content: { type: 'text', text: data.delta },
        };
      }
      return null;
    }

    // Reasoning summary delta — only emitted when the request enabled
    // reasoning.summary (e.g. o-series / gpt-5 with body.reasoning.summary='auto').
    // Forwarded as a pure-display reasoning chunk; never enters textBuf/usage.
    if (eventType === 'response.reasoning_summary_text.delta') {
      if (data.delta) {
        return { type: 'reasoning', reasoning: data.delta };
      }
      return null;
    }

    // A complete function_call item. The Responses API streams each output item
    // as output_item.added → (deltas) → output_item.done; the .done event carries
    // the full name + call_id + arguments. Surfacing it as a tool_call chunk lets
    // streaming-only callers (GatewayModel) assemble the authoritative output
    // (text + function_calls) WITHOUT a non-streamed backfill request. The SSE
    // routes ignore this chunk type (they only match content/usage/stop).
    if (eventType === 'response.output_item.done') {
      const item = data.item;
      if (item?.type === 'function_call' && item.call_id) {
        let input: unknown = {};
        try {
          input = JSON.parse(item.arguments || '{}');
        } catch {
          input = {};
        }
        return { type: 'tool_call', toolCall: { id: item.call_id, name: item.name, input } };
      }
      return null;
    }

    // Response completed event - contains usage and final status
    if (eventType === 'response.completed') {
      const usage = data.response?.usage;

      // Determine stop reason
      const status = data.response?.status;
      let stopReason: InternalResponse['stopReason'] = 'end_turn';
      if (status === 'incomplete') {
        stopReason = 'max_tokens';
      }
      // Check if output contains function calls
      const output = data.response?.output || [];
      if (output.some((item: any) => item.type === 'function_call')) {
        stopReason = 'tool_use';
      }

      // response.completed is the TERMINAL event. When usage is present (the
      // common case) we return a usage chunk that ALSO carries stopReason, so
      // the Chat Completions route can emit the required finish_reason chunk
      // from its usage branch. Without stopReason here the route's stop branch
      // never fires (this is the only terminal chunk emitted, there is no
      // separate stop chunk) and the stream ends with no finish_reason — which
      // violates the OpenAI streaming protocol and makes many SDKs discard the
      // accumulated content and return null. When usage is absent, fall back to
      // a plain stop chunk.
      // Split OpenAI's cached_tokens out of input — see splitOpenAIUsage.
      if (usage) {
        const { promptTokens, completionTokens, cacheRead } = splitOpenAIUsage(usage);
        return {
          type: 'usage',
          stopReason,
          usage: {
            promptTokens,
            completionTokens,
            cacheRead,
            totalTokens: promptTokens + completionTokens + cacheRead,
          },
        };
      }
      return {
        type: 'stop',
        stopReason,
      };
    }

    // Other events (response.created, response.output_item.added, etc.) are ignored
    return null;
  }
}
