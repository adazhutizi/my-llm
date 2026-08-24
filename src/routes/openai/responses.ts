import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import type { InternalRequest, InternalResponse, ContentBlock } from '../../types/internal.js';
import type { UpstreamStreamChunk } from '../../providers/base.js';
import { resolveModel, getProviderConfig, createProvider } from '../../services/model-router.js';
import { passthroughUpstream } from '../../services/passthrough.js';
import {
  GatewayError,
  Errors,
  formatOpenAIError,
  type GatewayStatusCode,
} from '../../utils/errors.js';
import { trackUsage } from '../../middleware/usage-track.js';
import { persistRequestLog } from '../../middleware/request-log.js';
import type { UsageData } from '../../middleware/usage-track.js';
import { estimateTokens, extractTextLength, estimateTokensFromMessages } from '../../utils/token-estimate.js';
import { imageUrlToSource } from '../../utils/image-block.js';

export const responses = new Hono();

responses.post('/', async (c) => {
  let requestBody: Record<string, unknown>;
  try {
    requestBody = await c.req.json();
  } catch {
    const error = Errors.invalidRequest('Invalid JSON body');
    return c.json(formatOpenAIError(error), 400);
  }

  const modelId = requestBody.model as string;
  if (!modelId) {
    const error = Errors.invalidRequest('model is required');
    return c.json(formatOpenAIError(error), 400);
  }

  // ── Convert Responses API input to internal format ──────────────────────
  const input = requestBody.input;
  const messages: InternalRequest['messages'] = convertInputToMessages(input);

  // Parse tools if present (Responses API flat format)
  const tools = (requestBody.tools as Array<Record<string, unknown>> | undefined)?.map((t) => ({
    name: t.name as string,
    description: t.description as string | undefined,
    input_schema: t.parameters,
  }));

  const internalReq: InternalRequest = {
    model: modelId,
    messages,
    parameters: {
      maxTokens: requestBody.max_output_tokens as number | undefined,
      temperature: requestBody.temperature as number | undefined,
      topP: requestBody.top_p as number | undefined,
      stream: !!requestBody.stream,
      tools,
    },
  };

  try {
    // ── Route to the correct provider ────────────────────────────────────
    const resolved = await resolveModel(modelId);
    const providerCfg = await getProviderConfig(resolved.provider);

    // 同族透传:Responses 客户端 + OpenAI 系上游时不经 Internal 中转,原样转发到
    // 上游 /responses(避免 Internal 中转丢失 previous_response_id/store/include
    // 等字段,且省去流式事件链的丢弃-重合成)。跨族(Responses 客户端 + Anthropic
    // 上游)走下方 Internal 管线。
    if (providerCfg.apiType === 'openai') {
      return passthroughUpstream(c, {
        providerCfg,
        realModel: resolved.realModel,
        clientProtocol: 'responses',
        requestBody,
        providerName: resolved.provider,
      });
    }

    const provider = createProvider(resolved.provider, providerCfg, providerCfg.apiType);

    internalReq.model = resolved.realModel;
    const upstreamReq = provider.transformRequest(internalReq);

    // ── Non-streaming response ───────────────────────────────────────────
    if (!requestBody.stream) {
      const upstreamRes = await provider.send(upstreamReq);

      if (upstreamRes.status >= 400) {
        // 上游 4xx/5xx 也要落请求日志:此分支直接 return,若不设 usage,
        // requestLogMiddleware 会按 usage===undefined 判为「流式/未到达 handler」
        // 跳过落库 → /logs 看不到这条上游 401/429(对齐流式 openStream catch
        // 分支与 dedicated/passthrough 的 isError 落库口径)。
        c.set('usage', {
          model: modelId,
          provider: resolved.provider,
          promptTokens: 0,
          completionTokens: 0,
          isError: true,
        } satisfies UsageData);
        const err = Errors.providerError(
          `Upstream error (${upstreamRes.status}): ${JSON.stringify(upstreamRes.body)}`,
        );
        return c.json(formatOpenAIError(err), (upstreamRes.status >= 500 ? 502 : upstreamRes.status) as GatewayStatusCode);
      }

      const internalRes = provider.transformResponse(upstreamRes);

      // Resolve tokens with fallback estimation when provider returns 0.
      // promptTokens is the NON-cached input (OpenAI's cached_tokens is split out
      // by the provider); cacheRead holds the cache hit. The OpenAI-protocol
      // usage returned to the client re-combines them (input_tokens includes
      // cache + input_tokens_details), while UsageData keeps them split for the
      // gateway's quota formula total = prompt + completion + cacheRead.
      let promptTokens = internalRes.usage.promptTokens;
      let completionTokens = internalRes.usage.completionTokens;
      const cacheRead = internalRes.usage.cacheRead ?? 0;
      if (providerCfg.estimateFallback && promptTokens + cacheRead === 0) {
        promptTokens = estimateTokensFromMessages(internalReq.messages);
      }
      if (providerCfg.estimateFallback && completionTokens === 0) {
        completionTokens = estimateTokens(extractTextLength(internalRes.content));
      }
      const grossInput = promptTokens + cacheRead;

      // Build Responses API output
      const output = buildOutput(internalRes.content);

      // Determine status
      const status = internalRes.stopReason === 'max_tokens' ? 'incomplete' : 'completed';

      const body = {
        id: internalRes.id,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model: internalRes.model,
        output,
        status,
        usage: {
          input_tokens: grossInput,
          output_tokens: completionTokens,
          total_tokens: grossInput + completionTokens,
          ...(cacheRead > 0 ? { input_tokens_details: { cached_tokens: cacheRead } } : {}),
        },
      };

      c.set('usage', {
        model: modelId,
        provider: resolved.provider,
        promptTokens,
        completionTokens,
        cacheReadTokens: cacheRead,
        isError: false,
      } satisfies UsageData);

      return c.json(body);
    }

    // ── Streaming response ───────────────────────────────────────────────
    // OpenAI's Responses streaming protocol mandates a full event chain:
    //   response.output_item.added → response.content_part.added →
    //   response.output_text.delta* → response.output_text.done →
    //   response.content_part.done → response.output_item.done →
    //   response.completed (response.output carries the final message item).
    // OpenAIProvider.transformStreamChunk intentionally drops the upstream
    // item/part lifecycle events (it only surfaces text deltas + the terminal
    // usage chunk), so the route must SYNTHESIZE them. Skipping them — or
    // leaving response.completed.response.output empty — leaves strict clients
    // (OpenAI SDK / Vercel AI SDK / Agents SDK) with no target to attach
    // deltas to and no final result to read, presenting as "no content shown".
    //
    // 先在上游响应头阶段判断:非 2xx(如 429)直接返回 HTTP 错误,不开 SSE 流
    // (对齐 dedicated/passthrough;修复原先先开 200 流再 fetch、429 时 200 头已发
    // 无法回退 + error chunk 缺 finish_reason → SDK 丢弃内容返回 null → 下游"无响应")。
    let streamIter: AsyncIterable<UpstreamStreamChunk>;
    try {
      streamIter = await provider.openStream(upstreamReq);
    } catch (openErr) {
      c.set('usage', {
        model: modelId,
        provider: resolved.provider,
        promptTokens: 0,
        completionTokens: 0,
        isError: true,
      } satisfies UsageData);
      if (openErr instanceof GatewayError) {
        return c.json(formatOpenAIError(openErr), openErr.statusCode);
      }
      const unexpected = Errors.internal(
        openErr instanceof Error ? openErr.message : 'Unexpected error',
      );
      return c.json(formatOpenAIError(unexpected), 500);
    }

    let promptTokens = 0;
    let completionTokens = 0;
    let cacheRead = 0;
    let completionCharLength = 0;
    let stopReason: InternalResponse['stopReason'] | undefined;
    const streamStartTime = Date.now();
    const collectedChunks: string[] = [];

    return streamSSE(c, async (stream) => {
      const responseId = `resp_${uuidv4().replace(/-/g, '').substring(0, 24)}`;
      const messageId = `msg_${uuidv4().replace(/-/g, '').substring(0, 24)}`;
      const created = Math.floor(Date.now() / 1000);

      // Accumulated assistant text + item/part lifecycle guard
      let textBuf = '';
      let itemAdded = false;
      // output_index is shared across message + function_call items, assigned in
      // arrival order. msgIndex holds the (single) message item's index once its
      // first delta lands; outputItems collects every final item to populate
      // response.completed.response.output (sorted by index — the Responses
      // protocol requires the output array order to match output_index).
      let msgIndex: number | null = null;
      let nextOutputIndex = 0;
      const outputItems: Array<{ index: number; item: any }> = [];

      // Helper to write SSE and collect chunks for logging
      const writeAndCollect = async (data: string, event?: string) => {
        collectedChunks.push(data);
        await stream.writeSSE({ ...(event ? { event } : {}), data });
      };

      // Emit response.created event
      await writeAndCollect(JSON.stringify({
        type: 'response.created',
        response: { id: responseId, object: 'response', created_at: created, model: resolved.realModel, output: [], status: 'in_progress' },
      }), 'response.created');

      try {
        for await (const chunk of streamIter) {
          const internal = provider.transformStreamChunk(chunk);
          if (!internal) continue;

          if (internal.type === 'content' && internal.content) {
            const text =
              internal.content.type === 'text'
                ? (internal.content as { type: 'text'; text: string }).text
                : '';
            if (!text) continue;
            completionCharLength += text.length;
            textBuf += text;

            // Lazily open the message item + content part before the first
            // delta so strict clients have a target to attach deltas to.
            if (!itemAdded) {
              msgIndex = nextOutputIndex++;
              await writeAndCollect(JSON.stringify({
                type: 'response.output_item.added',
                output_index: msgIndex,
                item: { type: 'message', id: messageId, role: 'assistant', status: 'in_progress', content: [] },
              }), 'response.output_item.added');
              await writeAndCollect(JSON.stringify({
                type: 'response.content_part.added',
                item_id: messageId,
                output_index: msgIndex,
                content_index: 0,
                part: { type: 'output_text', text: '', annotations: [] },
              }), 'response.content_part.added');
              itemAdded = true;
            }

            // Emit output_text.delta event
            await writeAndCollect(JSON.stringify({
              type: 'response.output_text.delta',
              item_id: messageId,
              output_index: msgIndex,
              content_index: 0,
              delta: text,
            }), 'response.output_text.delta');
          } else if (internal.type === 'usage' && internal.usage) {
            promptTokens = internal.usage.promptTokens;
            completionTokens = internal.usage.completionTokens;
            cacheRead = internal.usage.cacheRead ?? 0;
            if (internal.stopReason) stopReason = internal.stopReason;
          } else if (internal.type === 'stop') {
            // AnthropicProvider 终态 message_delta 映射成 {type:'stop', stopReason,
            // usage}(usage.completionTokens = 最终 output_tokens;promptTokens 刻意
            // 为 0,不覆盖 message_start 已设的输入侧值)。必须在此提取
            // completionTokens,否则 Responses + Anthropic 上游的流式调用
            // completion_tokens 记账为 0(对齐 /anthropic 路由 stop 分支只读
            // completionTokens 的口径;OpenAI 上游终态走 type:'usage' 分支不经此)。
            if (internal.stopReason) stopReason = internal.stopReason;
            if (internal.usage) {
              completionTokens = internal.usage.completionTokens;
            }
          } else if (internal.type === 'tool_call' && internal.toolCall) {
            // Synthesize a function_call item's lifecycle: output_item.added →
            // output_item.done. transformStreamChunk delivers the whole call at
            // once (from output_item.done), so there are no argument deltas —
            // the completed item carries the full arguments string. Item shape
            // mirrors the non-streaming buildOutput() helper.
            const tc = internal.toolCall;
            const fcIndex = nextOutputIndex++;
            const fcId = `fc_${uuidv4().replace(/-/g, '').substring(0, 24)}`;
            const fullArgs = JSON.stringify(tc.input ?? {});
            const fcItem = (status: 'in_progress' | 'completed') => ({
              type: 'function_call',
              id: fcId,
              name: tc.name,
              call_id: tc.id,
              arguments: status === 'completed' ? fullArgs : '',
              status,
            });
            // OpenAI Responses 流式 function_call 的官方事件链:
            //   output_item.added → function_call_arguments.delta* →
            //   function_call_arguments.done → output_item.done。
            // transformStreamChunk 一次性交付完整 call(无增量 delta),故跳过 delta、
            // 直接发 done(携带完整 arguments)。Node SDK 的 ResponseAccumulator 从
            // output_item.done 整体替换 item 取 arguments(不依赖此事件),但 Python SDK
            // (openai-python issue #2723)及部分严格客户端靠 function_call_arguments.done
            // 来 finalize arguments —— 缺它则 arguments 为 None → tool 不执行 → 多轮
            // agent 链中断("输出第一轮调用结果后突然停止")。补此事件对齐官方规范,对
            // Node/Agents SDK 无害(忽略多余的标准事件)。
            await writeAndCollect(JSON.stringify({
              type: 'response.output_item.added',
              output_index: fcIndex,
              item: fcItem('in_progress'),
            }), 'response.output_item.added');
            await writeAndCollect(JSON.stringify({
              type: 'response.function_call_arguments.done',
              output_index: fcIndex,
              item_id: fcId,
              arguments: fullArgs,
            }), 'response.function_call_arguments.done');
            await writeAndCollect(JSON.stringify({
              type: 'response.output_item.done',
              output_index: fcIndex,
              item: fcItem('completed'),
            }), 'response.output_item.done');
            outputItems.push({ index: fcIndex, item: fcItem('completed') });
          }
        }
      } catch (streamErr) {
        const errMsg =
          streamErr instanceof GatewayError
            ? streamErr.message
            : streamErr instanceof Error
              ? streamErr.message
              : 'Stream error';
        await writeAndCollect(JSON.stringify({
          type: 'response.failed',
          response: { id: responseId, status: 'failed', error: { message: errMsg } },
        }), 'response.failed');
      }

      // Fallback estimation when provider returns 0 tokens
      if (providerCfg.estimateFallback && promptTokens + cacheRead === 0) {
        promptTokens = estimateTokensFromMessages(internalReq.messages);
      }
      if (providerCfg.estimateFallback && completionTokens === 0) {
        completionTokens = estimateTokens(completionCharLength);
      }
      const grossInput = promptTokens + cacheRead;

      // finalStatus mirrors the non-streaming branch: max_tokens → incomplete.
      // (The prior `a ? 'completed' : 'completed'` was a no-op placeholder.)
      const finalStatus = stopReason === 'max_tokens' ? 'incomplete' : 'completed';

      // Close the item/part lifecycle opened above. The final message item
      // built here is collected into outputItems (alongside any function_call
      // items) to populate response.completed.response.output — the
      // authoritative result strict clients read when the stream ends.
      if (itemAdded) {
        const messageItem = {
          type: 'message',
          id: messageId,
          role: 'assistant',
          status: finalStatus,
          content: [{ type: 'output_text', text: textBuf, annotations: [] }],
        };
        await writeAndCollect(JSON.stringify({
          type: 'response.output_text.done',
          item_id: messageId,
          output_index: msgIndex,
          content_index: 0,
          text: textBuf,
        }), 'response.output_text.done');
        await writeAndCollect(JSON.stringify({
          type: 'response.content_part.done',
          item_id: messageId,
          output_index: msgIndex,
          content_index: 0,
          part: { type: 'output_text', text: textBuf, annotations: [] },
        }), 'response.content_part.done');
        await writeAndCollect(JSON.stringify({
          type: 'response.output_item.done',
          output_index: msgIndex,
          item: messageItem,
        }), 'response.output_item.done');
        outputItems.push({ index: msgIndex!, item: messageItem });
      }

      // Emit response.completed event with the final message item in output
      await writeAndCollect(JSON.stringify({
        type: 'response.completed',
        response: {
          id: responseId,
          object: 'response',
          created_at: created,
          model: resolved.realModel,
          output: outputItems.sort((a, b) => a.index - b.index).map((x) => x.item),
          status: finalStatus,
          usage: {
            input_tokens: grossInput,
            output_tokens: completionTokens,
            total_tokens: grossInput + completionTokens,
            ...(cacheRead > 0 ? { input_tokens_details: { cached_tokens: cacheRead } } : {}),
          },
        },
      }), 'response.completed');

      const usage: UsageData = {
        model: modelId,
        provider: resolved.provider,
        promptTokens,
        completionTokens,
        cacheReadTokens: cacheRead,
        isError: false,
      };
      c.set('usage', usage satisfies UsageData);

      // Persist log & usage directly — middleware can't see stream callback data
      try {
        await trackUsage(c, usage);
        await persistRequestLog(c, usage, requestBody, streamStartTime, true, {
          responseHeaders: provider.streamResponseHeaders ?? undefined,
          // Synthetic merged body so the log detail's response_body isn't empty
          // for streaming — mirrors the dedicated proxy's mergedResponseBody.
          // content is the fully-accumulated assistant text; usage matches the
          // client-facing (cache-recombined) figures, not the internal split.
          responseBody: {
            model: resolved.realModel,
            content: textBuf,
            stream_chunk_count: collectedChunks.length,
            usage: {
              prompt_tokens: grossInput,
              completion_tokens: completionTokens,
              total_tokens: grossInput + completionTokens,
              ...(cacheRead > 0 ? { cached_tokens: cacheRead } : {}),
            },
          },
          streamChunks: collectedChunks.join('\n'),
          streamChunkCount: collectedChunks.length,
        });
      } catch (logErr) {
        // Don't fail the stream if logging fails
      }
    });
  } catch (err) {
    if (err instanceof GatewayError) {
      return c.json(formatOpenAIError(err), err.statusCode);
    }
    const unexpected = Errors.internal(
      err instanceof Error ? err.message : 'Unexpected error',
    );
    return c.json(formatOpenAIError(unexpected), 500);
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────

/** Convert Responses API input to internal messages format */
function convertInputToMessages(input: unknown): InternalRequest['messages'] {
  if (!input) return [];

  // Simple string input
  if (typeof input === 'string') {
    return [{ role: 'user', content: [{ type: 'text', text: input }] }];
  }

  if (!Array.isArray(input)) return [];

  const messages: InternalRequest['messages'] = [];

  for (const item of input) {
    // EasyInputMessage: {role, content}
    if (item.role && item.content !== undefined) {
      const role = item.role as InternalRequest['messages'][0]['role'];
      let blocks: ContentBlock[];

      if (typeof item.content === 'string') {
        blocks = [{ type: 'text', text: item.content }];
      } else if (Array.isArray(item.content)) {
        // OpenAI Responses API 的 content part 用 input_text/output_text/input_image,
        // 内部表示与 Anthropic 用 text/image。跨族(Responses 客户端 → Anthropic 上游)
        // 若不归一化,Anthropic 收到不认识的 input_text/input_image block 类型会忽略
        // 整条消息 → 返回空 content。同族(Responses → OpenAI)走 passthrough 原样转发
        // 不经此处,不受影响。
        blocks = (item.content as Array<Record<string, unknown>>).map((part) => {
          if (part.type === 'input_text' || part.type === 'output_text') {
            return { type: 'text', text: String(part.text ?? '') };
          }
          if (part.type === 'input_image') {
            const url = String(part.image_url ?? '');
            return url
              ? { type: 'image', source: imageUrlToSource(url) }
              : (part as unknown as ContentBlock);
          }
          return part as unknown as ContentBlock;
        });
      } else {
        blocks = [{ type: 'text', text: String(item.content ?? '') }];
      }

      messages.push({ role, content: blocks });
      continue;
    }

    // function_call_output: {type:"function_call_output", call_id, output}
    if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        content: [{
          type: 'tool_result',
          tool_use_id: item.call_id,
          content: item.output || '',
        }],
      });
      continue;
    }

    // function_call: {type:"function_call", call_id, name, arguments}
    if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: item.call_id,
          name: item.name,
          input: JSON.parse(item.arguments || '{}'),
        }],
      });
      continue;
    }
  }

  return messages;
}

/** Build Responses API output from internal content blocks */
function buildOutput(content: ContentBlock[]): unknown[] {
  const output: unknown[] = [];

  // Group text blocks into a single message
  const textBlocks = content.filter((b) => b.type === 'text');
  if (textBlocks.length > 0) {
    const textContent = textBlocks.map((b) => ({
      type: 'output_text',
      text: (b as { type: 'text'; text: string }).text,
      annotations: [],
    }));
    output.push({
      type: 'message',
      id: `msg_${uuidv4().replace(/-/g, '').substring(0, 24)}`,
      status: 'completed',
      role: 'assistant',
      content: textContent,
    });
  }

  // Convert tool_use blocks to function_call items
  for (const block of content) {
    if (block.type === 'tool_use') {
      const tc = block as { type: 'tool_use'; id: string; name: string; input: unknown };
      output.push({
        type: 'function_call',
        id: `fc_${uuidv4().replace(/-/g, '').substring(0, 24)}`,
        call_id: tc.id,
        name: tc.name,
        arguments: JSON.stringify(tc.input),
      });
    }
  }

  return output;
}
