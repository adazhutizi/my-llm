import { getLogger } from './logger.js';

/**
 * Console log for upstream non-2xx responses (429 / 401 / 5xx), shared by every
 * egress path (dedicated-proxy, passthrough, the three cross-family routes,
 * embeddings, images) so the level policy can't drift between them:
 *   - 429 and 5xx → error (gateway or upstream is misbehaving / rate-limited)
 *   - other 4xx   → warn (usually a client-side request problem; error would
 *                    flood the console on malformed requests)
 * Upstream errors are persisted to request_logs, but before this helper the
 * console stayed silent — an upstream rate-limit storm was invisible unless you
 * opened the dashboard. Pass whatever identifying fields the call site has
 * (requestId / provider / model / upstreamUrl / body preview ≤500 chars).
 */
export function logUpstreamError(
  source: string,
  status: number,
  fields: Record<string, unknown>,
): void {
  const message = `${source} upstream error response`;
  if (status === 429 || status >= 500) {
    getLogger().error({ status, ...fields }, message);
  } else {
    getLogger().warn({ status, ...fields }, message);
  }
}
