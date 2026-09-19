export enum GatewayErrorCode {
  AUTH_FAILED = 'authentication_failed',
  AUTH_EXPIRED = 'key_expired',
  RATE_LIMITED = 'rate_limit_exceeded',
  QUOTA_EXCEEDED = 'quota_exceeded',
  MODEL_NOT_FOUND = 'model_not_found',
  MODEL_NOT_ALLOWED = 'model_not_allowed',
  UA_NOT_ALLOWED = 'user_agent_not_allowed',
  PROVIDER_ERROR = 'provider_error',
  UPSTREAM_TIMEOUT = 'upstream_timeout',
  INVALID_REQUEST = 'invalid_request',
  INTERNAL_ERROR = 'internal_error',
}

/**
 * Numeric status-code literals used by the gateway.
 * Matches a subset of Hono's ContentfulStatusCode so values are directly
 * assignable when calling c.json(body, error.statusCode).
 */
export type GatewayStatusCode = 400 | 401 | 403 | 404 | 429 | 500 | 502 | 504;

export class GatewayError extends Error {
  constructor(
    public code: GatewayErrorCode,
    message: string,
    public statusCode: GatewayStatusCode = 500,
    public details?: unknown
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

// Format error for OpenAI protocol
export function formatOpenAIError(error: GatewayError): object {
  return {
    error: {
      message: error.message,
      type: error.code,
      code: error.code,
    },
  };
}

// Format error for Anthropic protocol
export function formatAnthropicError(error: GatewayError): object {
  const typeMap: Record<string, string> = {
    [GatewayErrorCode.RATE_LIMITED]: 'rate_limit_error',
    [GatewayErrorCode.AUTH_FAILED]: 'authentication_error',
    [GatewayErrorCode.MODEL_NOT_ALLOWED]: 'permission_error',
    [GatewayErrorCode.UA_NOT_ALLOWED]: 'permission_error',
    [GatewayErrorCode.INVALID_REQUEST]: 'invalid_request_error',
    [GatewayErrorCode.PROVIDER_ERROR]: 'api_error',
    [GatewayErrorCode.INTERNAL_ERROR]: 'api_error',
  };

  return {
    type: 'error',
    error: {
      type: typeMap[error.code] || 'api_error',
      message: error.message,
    },
  };
}

// Detect protocol from path and format error accordingly
export function formatErrorForPath(path: string, error: GatewayError): object {
  if (path.startsWith('/anthropic/')) {
    return formatAnthropicError(error);
  }
  return formatOpenAIError(error);
}

// Predefined errors
export const Errors = {
  authFailed: (msg = 'Invalid API key') =>
    new GatewayError(GatewayErrorCode.AUTH_FAILED, msg, 401),

  authExpired: () =>
    new GatewayError(GatewayErrorCode.AUTH_EXPIRED, 'API key has expired', 401),

  rateLimited: (msg = 'Rate limit exceeded') =>
    new GatewayError(GatewayErrorCode.RATE_LIMITED, msg, 429),

  quotaExceeded: (msg = 'Quota exceeded') =>
    new GatewayError(GatewayErrorCode.QUOTA_EXCEEDED, msg, 429),

  modelNotFound: (model: string) =>
    new GatewayError(GatewayErrorCode.MODEL_NOT_FOUND, `Model not found: ${model}`, 404),

  modelNotAllowed: (model: string) =>
    new GatewayError(
      GatewayErrorCode.MODEL_NOT_ALLOWED,
      `Model not allowed for this API key: ${model}`,
      403,
    ),

  uaNotAllowed: (
    level: string,
    mode: string,
    pattern?: string,
    uaPreview?: string,
  ) => {
    let msg = `User-Agent not allowed by ${level}-level ${mode === 'allow' ? 'allow' : 'block'} (UA) policy`;
    // The 403 is NOT persisted to request_logs (entry-layer rejection), so the
    // error message + pino warn are the only troubleshooting clues — include
    // the matched pattern and a truncated UA preview.
    if (mode === 'block' && pattern) msg += ` (matched pattern: ${pattern})`;
    if (uaPreview) msg += ` (user-agent: ${uaPreview})`;
    return new GatewayError(GatewayErrorCode.UA_NOT_ALLOWED, msg, 403);
  },

  providerError: (msg: string) =>
    new GatewayError(GatewayErrorCode.PROVIDER_ERROR, msg, 502),

  upstreamTimeout: () =>
    new GatewayError(GatewayErrorCode.UPSTREAM_TIMEOUT, 'Upstream request timeout', 504),

  invalidRequest: (msg: string) =>
    new GatewayError(GatewayErrorCode.INVALID_REQUEST, msg, 400),

  internal: (msg = 'Internal server error') =>
    new GatewayError(GatewayErrorCode.INTERNAL_ERROR, msg, 500),
};
