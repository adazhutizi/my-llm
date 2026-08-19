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

export const imageGenerations = new Hono();

imageGenerations.post('/', async (c) => {
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

    // Anthropic does not support image generation
    if (providerCfg.apiType === 'anthropic') {
      return c.json(
        formatOpenAIError(
          Errors.invalidRequest(
            `Provider '${resolved.provider}' does not support image generation. Use an OpenAI-compatible provider.`,
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
      url: `${providerCfg.baseUrl}/images/generations`,
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

    // Images have no tokens — track request count only
    c.set('usage', {
      model: modelId,
      provider: resolved.provider,
      promptTokens: 0,
      completionTokens: 0,
      isError: false,
    } satisfies UsageData);

    // Passthrough: return upstream response unchanged
    return c.json(upstreamRes.body);
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
