import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import type { InternalRequest, ContentBlock } from '../../types/internal.js';
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

export const chatCompletions = new Hono();

chatCompletions.post('/', async (c) => {
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

  // ── Convert OpenAI request to internal format ──────────────────────────
  // CC 协议与 Internal/Anthropic 的工具结构差异(跨族 CC→Anthropic 必须归一化,
  // 否则多轮 agent 历史残缺):
  // - CC assistant 的工具调用是顶层 tool_calls(不在 content 里);Internal/
  //   Anthropic 要 tool_use 在 content block 中 → 拆成 tool_use block 追加。
  // - CC 工具结果是 {role:'tool', tool_call_id, content:"…"};Internal/Anthropic
  //   要 tool_result content block + tool_use_id → 转成 tool_result block。
  // 同族(CC→OpenAI)走 passthrough 原样转发不经此处,不受影响。
  const messages: InternalRequest['messages'] = (
    (requestBody.messages as Array<Record<string, unknown>>) || []
  ).map((msg) => {
    const role = msg.role as InternalRequest['messages'][0]['role'];

    // CC tool 结果:顶层 tool_call_id + content → tool_result block
    if (role === 'tool') {
      const toolContent =
        typeof msg.content === 'string' ? msg.content : String(msg.content ?? '');
      return {
        role: 'tool',
        content: [{
          type: 'tool_result',
          tool_use_id: String(msg.tool_call_id ?? ''),
          content: toolContent,
        }],
      };
    }

    const blocks: ContentBlock[] = [];
    const content = msg.content;
    if (typeof content === 'string') {
      blocks.push({ type: 'text', text: content });
    } else if (Array.isArray(content)) {
      // CC content part:image_url / text(及可能的内置结构)。跨族(CC→Anthropic)
      // 须把 image_url 归一化为 Internal image block(source 承载 http URL 或
      // data:base64),否则 Anthropic 上游不认 image_url part → 图片被忽略。
      // 同族(CC→OpenAI)走 passthrough 原样转发不经此处。
      for (const part of content as Array<Record<string, unknown>>) {
        if (part.type === 'image_url') {
          // image_url 标准是 {url},少数实现发裸 string,两者兼容
          const iu = part.image_url;
          const url = typeof iu === 'string' ? iu : String((iu as { url?: string } | undefined)?.url ?? '');
          if (url) blocks.push({ type: 'image', source: imageUrlToSource(url) });
        } else if (part.type === 'text') {
          blocks.push({ type: 'text', text: String(part.text ?? '') });
        } else {
          blocks.push(part as unknown as ContentBlock);
        }
      }
    } else if (content != null) {
      blocks.push({ type: 'text', text: String(content) });
    }

    // CC assistant 的顶层 tool_calls → tool_use blocks(Responses/Anthropic 要
    // tool_use 在 content 中,而非顶层字段)。content 为 null 时只含 tool_use。
    const toolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined;
    if (role === 'assistant' && Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const fn = (tc.function as Record<string, unknown>) ?? {};
        let input: unknown = {};
        try {
          input = fn.arguments ? JSON.parse(String(fn.arguments)) : {};
        } catch {
          input = {};
        }
        blocks.push({
          type: 'tool_use',
          id: String(tc.id ?? ''),
          name: String(fn.name ?? ''),
          input,
        });
      }
    }

    // 兜底:无 content 也无 tool_calls 时保留原行为(单空 text block),
    // 不向下游发送 content:[] 的空消息。
    return { role, content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }] };
  });

  const internalReq: InternalRequest = {
    model: modelId,
    messages,
    parameters: {
      maxTokens: requestBody.max_tokens as number | undefined,
      temperature: requestBody.temperature as number | undefined,
      topP: requestBody.top_p as number | undefined,
      stop: requestBody.stop as string[] | undefined,
      stream: !!requestBody.stream,
      tools: (requestBody.tools as Array<Record<string, unknown>>)?.map((t) => ({
        name: (t.function as Record<string, unknown>).name as string,
        description: (t.function as Record<string, unknown>).description as string | undefined,
        input_schema: (t.function as Record<string, unknown>).parameters,
      })),
    },
  };

  try {
    // ── Route to the correct provider ────────────────────────────────────
    const resolved = await resolveModel(modelId);
    const providerCfg = await getProviderConfig(resolved.provider);

    // 同族透传:CC 客户端 + OpenAI 系上游时不经 Internal 中转,原样转发到上游
    // /chat/completions(消除原先 CC→Internal→Responses→CC 的双重改写,并修复
    // n/seed/logprobs/response_format/tools_choice 等字段丢失)。跨族(CC 客户端 +
    // Anthropic 上游)走下方 Internal 管线。
    if (providerCfg.apiType === 'openai') {
      return passthroughUpstream(c, {
        providerCfg,
        realModel: resolved.realModel,
        clientProtocol: 'cc',
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
      // promptTokens is the NON-cached input (OpenAI cached_tokens split out by
      // the provider); cacheRead holds the cache hit. Client-facing usage
      // re-combines them (prompt_tokens includes cache); UsageData keeps split.
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

      const toolCalls = internalRes.content.filter((b) => b.type === 'tool_use');
      const textContent = internalRes.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: 'text'; text: string }).text)
        .join('');

      const choice: Record<string, unknown> = {
        index: 0,
        message: {
          role: 'assistant',
          content: textContent || null,
          ...(toolCalls.length > 0
            ? {
                tool_calls: toolCalls.map((tc) => {
                  const t = tc as { type: 'tool_use'; id: string; name: string; input: unknown };
                  return {
                    id: t.id,
                    type: 'function',
                    function: { name: t.name, arguments: JSON.stringify(t.input) },
                  };
                }),
              }
            : {}),
        },
        finish_reason: mapStopReason(internalRes.stopReason),
      };

      const body = {
        id: internalRes.id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: internalRes.model,
        choices: [choice],
        usage: {
          prompt_tokens: grossInput,
          completion_tokens: completionTokens,
          total_tokens: grossInput + completionTokens,
          ...(cacheRead > 0 ? { prompt_tokens_details: { cached_tokens: cacheRead } } : {}),
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
    // 先在上游响应头阶段判断:非 2xx(如 429)直接返回 HTTP 错误,不开 SSE 流
    // (对齐 dedicated/passthrough)。修复:原先先开 200 SSE 流再 fetch 上游,429 时
    // 200 头已发无法回退,catch 写的 error chunk 缺 finish_reason → SDK 丢弃内容
    // 返回 null → 下游"无响应"。openStream 在响应头(~100ms)即 resolve/抛错,正常
    // 请求零额外延迟(响应头本来就要等)。
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
    // Fully-accumulated assistant text — populates the log's response_body for
    // streaming (mirrors the dedicated proxy's mergedResponseBody).
    let textBuf = '';
    // Guards against emitting finish_reason twice (a terminal event may arrive
    // as either a stop chunk or — for OpenAI's response.completed — a usage
    // chunk carrying stopReason). The OpenAI Chat Completions streaming spec
    // REQUIRES exactly one chunk with finish_reason before [DONE]; missing it
    // makes many SDKs discard the accumulated content and return null.
    let finishSent = false;
    // Per-call index for streaming tool_calls deltas (OpenAI requires a unique
    // index per tool call within one choice).
    let toolCallIndex = 0;
    const streamStartTime = Date.now();
    const collectedChunks: string[] = [];

    return streamSSE(c, async (stream) => {
      const chatId = `chatcmpl-${uuidv4().replace(/-/g, '').substring(0, 24)}`;
      const created = Math.floor(Date.now() / 1000);

      // Initial chunk with role
      const initialChunk = JSON.stringify({
        id: chatId,
        object: 'chat.completion.chunk',
        created,
        model: resolved.realModel,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      });
      collectedChunks.push(initialChunk);
      await stream.writeSSE({ data: initialChunk });

      // Helper to write SSE and collect chunks for logging
      const writeAndCollect = async (data: string) => {
        collectedChunks.push(data);
        await stream.writeSSE({ data });
      };

      try {
        for await (const chunk of streamIter) {
          const internal = provider.transformStreamChunk(chunk);
          if (!internal) continue;

          if (internal.type === 'content' && internal.content) {
            const text =
              internal.content.type === 'text'
                ? (internal.content as { type: 'text'; text: string }).text
                : '';
            if (text) {
              completionCharLength += text.length;
              textBuf += text;
            }
            await writeAndCollect(JSON.stringify({
              id: chatId,
              object: 'chat.completion.chunk',
              created,
              model: resolved.realModel,
              choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
            }));
          } else if (internal.type === 'stop') {
            if (!finishSent) {
              finishSent = true;
              await writeAndCollect(JSON.stringify({
                id: chatId,
                object: 'chat.completion.chunk',
                created,
                model: resolved.realModel,
                choices: [
                  { index: 0, delta: {}, finish_reason: mapStopReason(internal.stopReason) },
                ],
              }));
            }
          } else if (internal.type === 'usage' && internal.usage) {
            promptTokens = internal.usage.promptTokens;
            completionTokens = internal.usage.completionTokens;
            cacheRead = internal.usage.cacheRead ?? 0;
            const grossInput = promptTokens + cacheRead;
            // OpenAI's response.completed is the terminal event and arrives as
            // a usage chunk carrying stopReason (see OpenAIProvider). Emit the
            // required finish_reason chunk here. Anthropic's message_start usage
            // has NO stopReason (it is the input-side usage at stream start, not
            // terminal), so the guard correctly skips it — finish_reason is then
            // emitted from the stop branch on the later message_delta.
            if (internal.stopReason && !finishSent) {
              finishSent = true;
              await writeAndCollect(JSON.stringify({
                id: chatId,
                object: 'chat.completion.chunk',
                created,
                model: resolved.realModel,
                choices: [
                  { index: 0, delta: {}, finish_reason: mapStopReason(internal.stopReason) },
                ],
              }));
            }
            await writeAndCollect(JSON.stringify({
              id: chatId,
              object: 'chat.completion.chunk',
              created,
              model: resolved.realModel,
              choices: [],
              usage: {
                prompt_tokens: grossInput,
                completion_tokens: completionTokens,
                total_tokens: grossInput + completionTokens,
                ...(cacheRead > 0 ? { prompt_tokens_details: { cached_tokens: cacheRead } } : {}),
              },
            }));
          } else if (internal.type === 'tool_call' && internal.toolCall) {
            // Forward a complete function_call as a single tool_calls delta.
            // OpenAI streams tool_calls incrementally, but transformStreamChunk
            // doesn't parse arguments deltas — the whole call arrives at once
            // from output_item.done. A single chunk carrying the full arguments
            // is legal; clients accumulate arguments regardless of chunk count.
            // Order is safe: output_item.done arrives before response.completed,
            // so tool_calls deltas precede the finish_reason chunk.
            const tc = internal.toolCall;
            await writeAndCollect(JSON.stringify({
              id: chatId,
              object: 'chat.completion.chunk',
              created,
              model: resolved.realModel,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: toolCallIndex++,
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) },
                  }],
                },
                finish_reason: null,
              }],
            }));
          }
        }
      } catch (streamErr) {
        const errMsg =
          streamErr instanceof GatewayError
            ? streamErr.message
            : streamErr instanceof Error
              ? streamErr.message
              : 'Stream error';
        await writeAndCollect(JSON.stringify({ error: { message: errMsg } }));
      }

      collectedChunks.push('[DONE]');
      await stream.writeSSE({ data: '[DONE]' });

      // Fallback estimation when provider returns 0 tokens
      if (providerCfg.estimateFallback && promptTokens + cacheRead === 0) {
        promptTokens = estimateTokensFromMessages(internalReq.messages);
      }
      if (providerCfg.estimateFallback && completionTokens === 0) {
        completionTokens = estimateTokens(completionCharLength);
      }

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
          responseBody: {
            model: resolved.realModel,
            content: textBuf,
            stream_chunk_count: collectedChunks.length,
            usage: {
              prompt_tokens: promptTokens + cacheRead,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + cacheRead + completionTokens,
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

function mapStopReason(
  reason?: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use',
): string | null {
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'stop_sequence':
      return 'stop';
    default:
      return null;
  }
}
