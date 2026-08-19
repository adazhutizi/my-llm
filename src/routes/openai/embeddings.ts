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
