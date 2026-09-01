import { Hono } from 'hono';
import {
  resolveModel,
  getProviderConfig,
  createProvider,
} from '../../services/model-router.js';
import {
  GatewayError,
  Errors,
  formatOpenAIError,
  type GatewayStatusCode,
} from '../../utils/errors.js';
import type { UsageData } from '../../middleware/usage-track.js';
import type { UpstreamRequest } from '../../providers/base.js';
import { logUpstreamError } from '../../utils/upstream-error.js';

export const embeddings = new Hono();

embeddings.post('/', async (c) => {
  let requestBody: Record<string, unknown>;
  try {
    requestBody = await c.req.json();
  } catch {
    return c.json(
      formatOpenAIError(Errors.invalidRequest('Invalid JSON body')),
      400,
    );
  }

  const modelId = requestBody.model as string;
  if (!modelId) {
    return c.json(
      formatOpenAIError(Errors.invalidRequest('model is required')),
      400,
    );
  }

  try {
    const resolved = await resolveModel(modelId);
    const providerCfg = await getProviderConfig(resolved.provider);

    // Anthropic does not have an embeddings API
    if (providerCfg.apiType === 'anthropic') {
      return c.json(
        formatOpenAIError(
          Errors.invalidRequest(
            `Provider '${resolved.provider}' does not support embeddings. Use an OpenAI-compatible provider.`,
          ),
        ),
        400,
      );
    }

    const provider = createProvider(
      resolved.provider,
      providerCfg,
      providerCfg.apiType,
    );

    // Passthrough: forward body as-is, only swap virtual model for real model
    const passthroughBody = { ...requestBody, model: resolved.realModel };

    const upstreamReq: UpstreamRequest = {
      url: `${providerCfg.baseUrl}/embeddings`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${providerCfg.apiKey}`,
      },
      body: passthroughBody,
    };

    const upstreamRes = await provider.send(upstreamReq);

    if (upstreamRes.status >= 400) {
      // 上游 4xx/5xx 也要落请求日志(对齐三路由 2026-08 修复口径):不设 usage 则
      // requestLogMiddleware 按 usage===undefined 判为「未到达 handler」跳过落库,
      // /logs 看不到这条上游 429/401。catch 分支(resolveModel 404 等未到上游的
      // 错误)刻意不设——与「未到达 LLM handler 不落日志」设计一致。
      c.set('usage', {
        model: modelId,
        provider: resolved.provider,
        promptTokens: 0,
        completionTokens: 0,
        isError: true,
      } satisfies UsageData);
      logUpstreamError('Embeddings', upstreamRes.status, {
        requestId: c.get('requestId'),
        provider: resolved.provider,
        model: modelId,
        body: JSON.stringify(upstreamRes.body) ?? '',
      });
      const err = Errors.providerError(
        `Upstream error (${upstreamRes.status}): ${JSON.stringify(upstreamRes.body)}`,
      );
      return c.json(
        formatOpenAIError(err),
        (upstreamRes.status >= 500 ? 502 : upstreamRes.status) as GatewayStatusCode,
      );
    }

    // Extract usage for tracking (embeddings only have prompt_tokens)
    const upstreamBody = upstreamRes.body as Record<string, unknown>;
    const usage = (upstreamBody.usage ?? {}) as Record<string, number>;
    const promptTokens = usage.prompt_tokens ?? 0;

    c.set('usage', {
      model: modelId,
      provider: resolved.provider,
      promptTokens,
      completionTokens: 0,
      isError: false,
    } satisfies UsageData);

    // Passthrough: return upstream response unchanged
    return c.json(upstreamBody);
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
