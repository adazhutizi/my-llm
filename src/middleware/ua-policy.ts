import { Context, Next } from 'hono';
import type { AuthContext } from './auth.js';
import {
  getUaPoliciesForRequest,
  evaluateUaPolicies,
  type UaPolicyTarget,
} from '../services/ua-policy.js';
import { Errors, formatErrorForPath } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';

// Cap the UA before matching: catastrophic-backtracking inputs rely on long
// strings, so a 512-char bound limits the backtrack surface even if a
// dangerous regex slipped past the save-time safety check (direct DB edits).
// Anchored patterns may no longer match the tail of very long UAs — DoS
// protection wins (documented).
const UA_MATCH_LIMIT = 512;

/**
 * Stacked User-Agent allow/block lists across global → app → user → api_key.
 *
 * Mounted on the three LLM chains AFTER rateLimit and BEFORE quotaCheck:
 *   - after rateLimit: banned-UA clients typically retry-storm, and the token
 *     bucket absorbs the storm before each retry costs a full auth round
 *     (3-6 DB point queries) plus this middleware;
 *   - before quotaCheck: same layer as the modelPolicy 403 — permission
 *     answers precede quota answers.
 *
 * Deliberately does NOT set `usage` on rejection: entry-layer rejections
 * (auth 401 / rateLimit 429 / modelPolicy 403) are not persisted to
 * request_logs, and this 403 must not break that invariant. The pino warn
 * below is the realtime observability window for admins.
 */
export async function uaPolicyMiddleware(c: Context, next: Next) {
  const auth = c.get('auth') as AuthContext | undefined;

  // Defensive only: JWT requests can't reach the LLM chains (auth rejects
  // them), but this guard future-proofs against the middleware ever being
  // mounted on a wildcard that also covers admin routes.
  if (auth?.authMethod === 'jwt') {
    return next();
  }

  // Same construction as rate-limit.ts's checks array: global always, then
  // app/user only when the key carries them, api_key always.
  const targets: UaPolicyTarget[] = [{ type: 'global', id: null }];
  if (auth?.appId != null) targets.push({ type: 'app', id: auth.appId });
  if (auth?.userId != null) targets.push({ type: 'user', id: auth.userId });
  if (auth?.keyId != null) targets.push({ type: 'api_key', id: auth.keyId });

  // getUaPoliciesForRequest already fail-opens internally (Redis → DB →
  // "no policy"), so this try/catch is the last-resort guard: any unexpected
  // throw must never take down request processing.
  let policies;
  try {
    policies = await getUaPoliciesForRequest(targets);
  } catch (err) {
    getLogger().error({ err }, 'UA policy check failed — allowing request (fail-open)');
    return next();
  }

  // Fast path: no level has a policy → skip regex work entirely (the
  // overwhelmingly common case on deployments that never configure this).
  if (policies.every((p) => p === null)) {
    return next();
  }

  const ua = (c.req.header('user-agent') ?? '').slice(0, UA_MATCH_LIMIT);
  const levels = targets.map((target, i) => ({ target, policy: policies[i] }));
  const verdict = evaluateUaPolicies(levels, ua);

  if (!verdict.allowed) {
    const reason = verdict.reason!;
    const uaPreview = ua.slice(0, 80);
    getLogger().warn(
      {
        requestId: c.get('requestId') as string | undefined,
        level: reason.level,
        mode: reason.mode,
        pattern: reason.pattern,
        ua: uaPreview,
        apiKeyId: auth?.keyId,
      },
      'Request rejected by UA policy',
    );
    const error = Errors.uaNotAllowed(reason.level, reason.mode, reason.pattern, uaPreview || undefined);
    return c.json(formatErrorForPath(c.req.path, error), error.statusCode);
  }

  return next();
}
