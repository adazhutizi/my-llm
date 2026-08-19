import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { requestIdMiddleware } from '../src/middleware/request-id.js';

describe('Request ID Middleware', () => {
  it('should generate request ID', async () => {
    const app = new Hono();
    app.use('*', requestIdMiddleware);
    app.get('/', (c) => c.text(c.get('requestId')));

    const res = await app.request('/');
    const requestId = await res.text();

    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get('X-Request-ID')).toBe(requestId);
  });

  it('should honor client-provided X-Request-ID', async () => {
    const app = new Hono();
    app.use('*', requestIdMiddleware);
    app.get('/', (c) => c.text(c.get('requestId')));

    const res = await app.request('/', {
      headers: { 'X-Request-ID': 'custom-id' },
    });
    const requestId = await res.text();

    expect(requestId).toBe('custom-id');
    expect(res.headers.get('X-Request-ID')).toBe('custom-id');
  });
});
