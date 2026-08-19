import { Hono } from 'hono';
import {
  listRequestLogs,
  getRequestDetail,
  getLogFilterOptions,
  runLogArchive,
} from '../../db/repositories/logs.js';
import { GatewayError } from '../../utils/errors.js';
import { generateLogSummary, getCachedSummary } from '../../services/log-summary.js';

export const adminLogs = new Hono();

// GET /admin/logs - query request logs with filters
adminLogs.get('/', async (c) => {
  const page = Number(c.req.query('page') ?? 1);
  const pageSize = Number(c.req.query('pageSize') ?? 20);

  const apiKeyId = c.req.query('apiKeyId') ? Number(c.req.query('apiKeyId')) : undefined;
  const appId = c.req.query('appId') ? Number(c.req.query('appId')) : undefined;
  const userId = c.req.query('userId') ? Number(c.req.query('userId')) : undefined;
  const groupId = c.req.query('groupId') ? Number(c.req.query('groupId')) : undefined;
  const model = c.req.query('model') || undefined;
  const statusCode = c.req.query('statusCode') ? Number(c.req.query('statusCode')) : undefined;
  const appUserId = c.req.query('appUserId') || undefined;
  const featureId = c.req.query('featureId') || undefined;
  const provider = c.req.query('provider') || undefined;
  const requestPath = c.req.query('requestPath') || undefined;
  const userAgent = c.req.query('userAgent') || undefined;
  const startDate = c.req.query('startDate') ? new Date(c.req.query('startDate')!) : undefined;
  const endDate = c.req.query('endDate') ? new Date(c.req.query('endDate')!) : undefined;
  const hideArchived = c.req.query('hideArchived') === 'true';

  const result = await listRequestLogs(
    { apiKeyId, appId, userId, groupId, model, provider, statusCode, appUserId, featureId, requestPath, userAgent, startDate, endDate, hideArchived },
    { page, pageSize },
  );

  return c.json({
    data: result.items,
    pagination: { page, pageSize, total: result.total },
  });
});

// GET /admin/logs/filter-options - distinct values for filter dropdowns
adminLogs.get('/filter-options', async (c) => {
  const options = await getLogFilterOptions();
  return c.json({ data: options });
});

// POST /admin/logs/archive - merge agentic loop sessions
// Registered BEFORE GET /:requestId so the literal "archive" segment isn't
// captured as a requestId. Optional body overrides config defaults.
adminLogs.post('/archive', async (c) => {
  let body: { retentionDays?: number; sessionTimeoutMin?: number; batchSize?: number } = {};
  try {
    body = await c.req.json();
  } catch {
    // empty body is fine — fall back to config defaults
  }
  const stats = await runLogArchive({
    retentionDays: typeof body.retentionDays === 'number' ? body.retentionDays : undefined,
    sessionTimeoutMin: typeof body.sessionTimeoutMin === 'number' ? body.sessionTimeoutMin : undefined,
    batchSize: typeof body.batchSize === 'number' ? body.batchSize : undefined,
  });
  return c.json({ data: stats });
});

// POST /admin/logs/:requestId/summary - generate (or return cached) an AI
// summary of a request body. Registered before GET /:requestId to mirror the
// /archive ordering (different HTTP methods, but keep literal segments ahead of
// the :requestId param route). Body { force?: boolean } bypasses the cache.
adminLogs.post('/:requestId/summary', async (c) => {
  const requestId = c.req.param('requestId');
  if (!requestId) {
    return c.json({ error: 'requestId is required' }, 400);
  }
  let body: { force?: boolean } = {};
  try {
    body = await c.req.json();
  } catch {
    // empty body is fine — cached or fresh generation without force
  }
  try {
    const result = await generateLogSummary(c, requestId, body.force === true);
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof GatewayError) {
      return c.json({ error: { message: err.message, type: err.code } }, err.statusCode);
    }
    return c.json({ error: { message: '生成小结失败' } }, 500);
  }
});

// GET /admin/logs/:requestId - get full request detail
adminLogs.get('/:requestId', async (c) => {
  const requestId = c.req.param('requestId');
  if (!requestId) {
    return c.json({ error: 'requestId is required' }, 400);
  }

  const detail = await getRequestDetail(requestId);
  if (!detail) {
    return c.json({ error: 'Request detail not found' }, 404);
  }

  // Attach a cached AI summary if one exists so the detail dialog renders it
  // without a second round-trip; null when none has been generated yet.
  const aiSummary = await getCachedSummary(requestId);
  return c.json({ data: { ...detail, aiSummary } });
});
