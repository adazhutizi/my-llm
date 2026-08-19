import { Context, Next } from 'hono';
import { v4 as uuidv4 } from 'uuid';

export async function requestIdMiddleware(c: Context, next: Next) {
  // Honor a client-provided X-Request-ID when present (for cross-system trace
  // correlation); otherwise generate a fresh uuid. A client/proxy that reuses
  // the same X-Request-ID across requests (retries, connection-level caching,
  // upstream gateway aggregation) makes request_id collide, so persistRequestLog
  // upserts on request_id (request_logs.request_id is UNIQUE): a repeat ID
  // overwrites the prior row's content instead of inserting a duplicate. The
  // uuid fallback never collides, so its upsert path is always an insert — no
  // duplicate-check logic needed for the generated case.
  const requestId = c.req.header('X-Request-ID') || uuidv4();

  // Set in context
  c.set('requestId', requestId);

  // Echo the request ID back so clients can correlate errors/logs.
  c.header('X-Request-ID', requestId);

  await next();
}
