import { Context, Next } from 'hono';
import { checkRateLimit } from '../services/rate-limiter.js';
import {
  Errors,
  formatOpenAIError,
  formatAnthropicError,
} from '../utils/errors.js';
import type { AuthContext } from './auth.js';

export async function rateLimitMiddleware(c: Context, next: Next) {
  const auth = c.get('auth') as AuthContext | undefined;

  // Build the ordered list of rate-limit targets to check
  const checks: Array<{
    type: 'global' | 'app' | 'user' | 'api_key';
    id: number | null;
  }> = [{ type: 'global', id: null }];

  if (auth?.appId != null) {
    checks.push({ type: 'app', id: auth.appId });
  }
  if (auth?.userId != null) {
    checks.push({ type: 'user', id: auth.userId });
  }
  if (auth?.keyId != null) {
    checks.push({ type: 'api_key', id: auth.keyId });
  }

  for (const check of checks) {
    const allowed = await checkRateLimit(check.type, check.id);
    if (!allowed) {
      const error = Errors.rateLimited();
      const path = c.req.path;

      if (path.startsWith('/anthropic/')) {
        return c.json(formatAnthropicError(error), 429);
      }
      return c.json(formatOpenAIError(error), 429);
    }
  }

  await next();
}
