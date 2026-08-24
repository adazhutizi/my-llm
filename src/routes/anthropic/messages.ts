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
  formatAnthropicError,
  type GatewayStatusCode,
} from '../../utils/errors.js';
import { trackUsage } from '../../middleware/usage-track.js';
import { persistRequestLog } from '../../middleware/request-log.js';
import type { UsageData } from '../../middleware/usage-track.js';
import { estimateTokens, extractTextLength, estimateTokensFromMessages } from '../../utils/token-estimate.js';

export const messages = new Hono();

messages.post('/', async (c) => {
  let requestBody: Record<string, unknown>;
  try {
    requestBody = await c.req.json();
  } catch {
    const error = Errors.invalidRequest('Invalid JSON body');
    return c.json(formatAnthropicError(error), 400);
  }

  const modelId = requestBody.model as string;
  if (!modelId) {
    const error = Errors.invalidRequest('model is required');
    return c.json(formatAnthropicError(error), 400);
  }

  // ── Convert Anthropic request to internal format ───────────────────────
  const messages: InternalRequest['messages'] = [];

  // Anthropic puts system prompt at the top level, not in messages
  if (requestBody.system) {
    const systemText =
      typeof requestBody.system === 'string'
        ? requestBody.system
        : Array.isArray(requestBody.system)
          ? (requestBody.system as Array<{ type: string; text: string }>)
              .map((b) => b.text)
              .join('\n')
          : String(requestBody.system);

    messages.push({
      role: 'system',
      content: [{ type: 'text', text: systemText }],
    });
  }

  const rawMessages = (requestBody.messages as Array<Record<string, unknown>>) || [];
  for (const msg of rawMessages) {
    const content = msg.content;
    let blocks: ContentBlock[];
    if (typeof content === 'string') {
      blocks = [{ type: 'text', text: content }];
    } else if (Array.isArray(content)) {
      blocks = content as ContentBlock[];
    } else {
      blocks = [{ type: 'text', text: String(content ?? '') }];
    }
    messages.push({
      role: msg.role as InternalRequest['messages'][0]['role'],
      content: blocks,
    });
  }

  const internalReq: InternalRequest = {
    model: modelId,
    messages,
    parameters: {
      maxTokens: (requestBody.max_tokens as number) ?? 4096,
      temperature: requestBody.temperature as number | undefined,
      topP: requestBody.top_p as number | undefined,
      stop: requestBody.stop_sequences as string[] | undefined,
      stream: !!requestBody.stream,
      tools: (requestBody.tools as Array<Record<string, unknown>>)?.map((t) => ({
        name: t.name as string,
        description: t.description as string | undefined,
        input_schema: t.input_schema,
      })),
    },
  };

  try {
    // ── Route to the correct provider ────────────────────────────────────
    const resolved = await resolveModel(modelId);
    const providerCfg = await getProviderConfig(resolved.provider);

    // 同族透传:Anthropic 客户端 + Anthropic 上游时不经 Internal 中转,原样转发到
    // 上游 /v1/messages(避免 Internal 中转丢失 content block 级 cache_control
    // 标记、top_k 等字段)。跨族(Anthropic 客户端 + OpenAI 系上游)走下方 Internal
    // 管线(转 Responses 发 /responses)。
    if (providerCfg.apiType === 'anthropic') {
      return passthroughUpstream(c, {
        providerCfg,
        realModel: resolved.realModel,
        clientProtocol: 'anthropic',
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
        return c.json(
          formatAnthropicError(err),
          (upstreamRes.status >= 500 ? 502 : upstreamRes.status) as GatewayStatusCode,
        );
      }

      const internalRes = provider.transformResponse(upstreamRes);

      // Resolve tokens with fallback estimation when provider returns 0
      let promptTokens = internalRes.usage.promptTokens;
      let completionTokens = internalRes.usage.completionTokens;
      // promptTokens is Anthropic's non-cached input_tokens; cache* are separate.
      const cacheRead = internalRes.usage.cacheRead ?? 0;
      const cacheCreation = internalRes.usage.cacheCreation ?? 0;
      if (providerCfg.estimateFallback && promptTokens === 0) {
        promptTokens = estimateTokensFromMessages(internalReq.messages);
      }
      if (providerCfg.estimateFallback && completionTokens === 0) {
        completionTokens = estimateTokens(extractTextLength(internalRes.content));
      }

      const contentBlocks = internalRes.content.map((block) => {
        if (block.type === 'text') {
          return { type: 'text', text: (block as { type: 'text'; text: string }).text };
        }
        if (block.type === 'tool_use') {
          const t = block as { type: 'tool_use'; id: string; name: string; input: unknown };
          return { type: 'tool_use', id: t.id, name: t.name, input: t.input };
        }
        return block;
      });

      // Restore Anthropic's usage shape for the client: input_tokens is the
      // non-cached input (promptTokens), cache_*_input_tokens stay independent
      // (omitted when 0 to mirror upstream).
      const clientUsage: Record<string, number> = {
        input_tokens: promptTokens,
        output_tokens: completionTokens,
      };
      if (cacheCreation > 0) clientUsage.cache_creation_input_tokens = cacheCreation;
      if (cacheRead > 0) clientUsage.cache_read_input_tokens = cacheRead;

      const body = {
        id: internalRes.id,
        type: 'message',
        role: 'assistant',
        content: contentBlocks,
        model: internalRes.model,
        stop_reason: internalRes.stopReason ?? null,
        stop_sequence: null,
        usage: clientUsage,
      };

      c.set('usage', {
        model: modelId,
        provider: resolved.provider,
        promptTokens,
        completionTokens,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreation,
        isError: false,
      } satisfies UsageData);

      return c.json(body);
    }

    // ── Streaming response ───────────────────────────────────────────────
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
        return c.json(formatAnthropicError(openErr), openErr.statusCode);
      }
      const unexpected = Errors.internal(
        openErr instanceof Error ? openErr.message : 'Unexpected error',
      );
      return c.json(formatAnthropicError(unexpected), 500);
    }

    let promptTokens = 0;
    let completionTokens = 0;
    let cacheRead = 0;
    let cacheCreation = 0;
    let completionCharLength = 0;
    // Fully-accumulated assistant text — populates the log's response_body for
    // streaming (mirrors the dedicated proxy's mergedResponseBody).
    let textBuf = '';
    const streamStartTime = Date.now();
    const collectedChunks: string[] = [];

    return streamSSE(c, async (stream) => {
      const msgId = `msg_${uuidv4().replace(/-/g, '').substring(0, 24)}`;

      // Helper to write SSE and collect chunks for logging
      const writeAndCollect = async (data: string, event?: string) => {
        collectedChunks.push(data);
        await stream.writeSSE({ ...(event ? { event } : {}), data });
      };

      try {
        // message_start
        await writeAndCollect(JSON.stringify({
          type: 'message_start',
          message: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            content: [],
            model: resolved.realModel,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }), 'message_start');

        // Content blocks are opened lazily and tracked dynamically. A text
        // block opens on the first text delta; a tool_use block opens when a
        // tool_call chunk arrives (the provider emits one complete tool_call
        // per tool_use, so we synthesize start→input_json_delta→stop in one
        // shot). Block indices are self-assigned in arrival order — upstream's
        // own content_block_start/stop events are dropped by the provider, so
        // we can't mirror its indices; self-assignment keeps array order =
        // index order, which is what Anthropic clients expect.
        let nextBlockIndex = 0;
        let openTextBlockIndex: number | null = null;

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
            // Lazily open a text block on the first delta. Upstream may emit
            // no text at all (e.g. a pure tool_use response), in which case we
            // never open one — unlike the previous hardcoded block.
            if (openTextBlockIndex === null) {
              openTextBlockIndex = nextBlockIndex++;
              await writeAndCollect(JSON.stringify({
                type: 'content_block_start',
                index: openTextBlockIndex,
                content_block: { type: 'text', text: '' },
              }), 'content_block_start');
            }
            await writeAndCollect(JSON.stringify({
              type: 'content_block_delta',
              index: openTextBlockIndex,
              delta: { type: 'text_delta', text },
            }), 'content_block_delta');
          } else if (internal.type === 'tool_call' && internal.toolCall) {
            // A complete tool_use: close any open text block first (text and
            // tool_use are distinct content blocks with distinct indices), then
            // synthesize the tool_use block's full lifecycle. The provider
            // delivers the whole call at once (no incremental arguments), so
            // input_json_delta carries the complete JSON in a single delta.
            if (openTextBlockIndex !== null) {
              await writeAndCollect(JSON.stringify({
                type: 'content_block_stop',
                index: openTextBlockIndex,
              }), 'content_block_stop');
              openTextBlockIndex = null;
            }
            const tc = internal.toolCall;
            const toolIndex = nextBlockIndex++;
            await writeAndCollect(JSON.stringify({
              type: 'content_block_start',
              index: toolIndex,
              content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} },
            }), 'content_block_start');
            await writeAndCollect(JSON.stringify({
              type: 'content_block_delta',
              index: toolIndex,
              delta: { type: 'input_json_delta', partial_json: JSON.stringify(tc.input ?? {}) },
            }), 'content_block_delta');
            await writeAndCollect(JSON.stringify({
              type: 'content_block_stop',
              index: toolIndex,
            }), 'content_block_stop');
          } else if (internal.type === 'usage' && internal.usage) {
            promptTokens = internal.usage.promptTokens;
            completionTokens = internal.usage.completionTokens;
            // message_start carries the full input-side cache breakdown
            cacheRead = internal.usage.cacheRead ?? 0;
            cacheCreation = internal.usage.cacheCreation ?? 0;
          } else if (internal.type === 'stop') {
            // message_delta's final output_tokens (promptTokens stays from
            // message_start — do NOT read it here, provider sends 0)
            if (internal.usage) {
              completionTokens = internal.usage.completionTokens;
            }
            // Close the text block if still open. tool_use blocks were already
            // closed in the tool_call branch; a bare stop with no open block
            // (pure tool_use, or empty response) emits no content_block_stop.
            if (openTextBlockIndex !== null) {
              await writeAndCollect(JSON.stringify({
                type: 'content_block_stop',
                index: openTextBlockIndex,
              }), 'content_block_stop');
              openTextBlockIndex = null;
            }

            // message_delta with stop_reason and usage
            await writeAndCollect(JSON.stringify({
              type: 'message_delta',
              delta: { stop_reason: internal.stopReason ?? 'end_turn', stop_sequence: null },
              usage: { output_tokens: completionTokens },
            }), 'message_delta');
          }
        }

        // message_stop
        await writeAndCollect(JSON.stringify({ type: 'message_stop' }), 'message_stop');
      } catch (streamErr) {
        const errMsg =
          streamErr instanceof GatewayError
            ? streamErr.message
            : streamErr instanceof Error
              ? streamErr.message
              : 'Stream error';
        await writeAndCollect(JSON.stringify({ type: 'error', error: { type: 'api_error', message: errMsg } }), 'error');
      }

      // Fallback estimation when provider returns 0 tokens
      if (providerCfg.estimateFallback && promptTokens === 0) {
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
        cacheCreationTokens: cacheCreation,
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
      return c.json(formatAnthropicError(err), err.statusCode);
    }
    const unexpected = Errors.internal(
      err instanceof Error ? err.message : 'Unexpected error',
    );
    return c.json(formatAnthropicError(unexpected), 500);
  }
});
