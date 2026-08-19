import { describe, it, expect } from 'vitest';
import {
  Errors,
  GatewayError,
  GatewayErrorCode,
  formatOpenAIError,
  formatAnthropicError,
  formatErrorForPath,
} from '../src/utils/errors.js';

describe('Errors', () => {
  it('should create auth failed error', () => {
    const error = Errors.authFailed();
    expect(error.statusCode).toBe(401);
    expect(error.code).toBe('authentication_failed');
  });

  it('should create rate limited error', () => {
    const error = Errors.rateLimited();
    expect(error.statusCode).toBe(429);
    expect(error.code).toBe('rate_limit_exceeded');
  });

  it('should create model not found error with model name', () => {
    const error = Errors.modelNotFound('gpt-5');
    expect(error.statusCode).toBe(404);
    expect(error.message).toContain('gpt-5');
  });

  it('should format OpenAI error', () => {
    const error = Errors.rateLimited();
    const formatted = formatOpenAIError(error);
    expect(formatted).toEqual({
      error: {
        message: 'Rate limit exceeded',
        type: 'rate_limit_exceeded',
        code: 'rate_limit_exceeded',
      },
    });
  });

  it('should format Anthropic error', () => {
    const error = Errors.rateLimited();
    const formatted = formatAnthropicError(error);
    expect(formatted).toEqual({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'Rate limit exceeded',
      },
    });
  });

  it('should format Anthropic auth error', () => {
    const error = Errors.authFailed();
    const formatted = formatAnthropicError(error);
    expect(formatted).toEqual({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'Invalid API key',
      },
    });
  });

  it('should detect protocol from path - OpenAI', () => {
    const error = Errors.authFailed();
    const formatted = formatErrorForPath('/openai/v1/chat', error) as any;
    expect(formatted.error.type).toBe('authentication_failed');
  });

  it('should detect protocol from path - Anthropic', () => {
    const error = Errors.authFailed();
    const formatted = formatErrorForPath('/anthropic/v1/messages', error) as any;
    expect(formatted.type).toBe('error');
    expect(formatted.error.type).toBe('authentication_error');
  });
});
