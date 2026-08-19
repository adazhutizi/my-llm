import { Hono } from 'hono';
import {
  getUsageOverview,
  getUsageByKey,
  getUsageByApp,
  getUsageByUser,
  getUsageByModel,
  getUsageTrends,
  getUsageByAppUser,
  getUsageByFeature,
} from '../../db/repositories/usage.js';

export const adminUsage = new Hono();

// GET /admin/usage/overview - aggregated stats
adminUsage.get('/overview', async (c) => {
  const startDate = c.req.query('startDate') ? new Date(c.req.query('startDate')!) : undefined;
  const endDate = c.req.query('endDate') ? new Date(c.req.query('endDate')!) : undefined;
  const apiKeyId = c.req.query('apiKeyId') ? Number(c.req.query('apiKeyId')) : undefined;
  const appId = c.req.query('appId') ? Number(c.req.query('appId')) : undefined;
  const userId = c.req.query('userId') ? Number(c.req.query('userId')) : undefined;

  const overview = await getUsageOverview({ startDate, endDate, apiKeyId, appId, userId });
  return c.json({ data: overview });
});

// GET /admin/usage/by-key - usage by API key
adminUsage.get('/by-key', async (c) => {
  const apiKeyId = c.req.query('apiKeyId') ? Number(c.req.query('apiKeyId')) : undefined;
  if (apiKeyId === undefined) {
    return c.json({ error: 'apiKeyId query parameter is required' }, 400);
  }

  const startDate = c.req.query('startDate') ? new Date(c.req.query('startDate')!) : undefined;
  const endDate = c.req.query('endDate') ? new Date(c.req.query('endDate')!) : undefined;

  const items = await getUsageByKey(apiKeyId, { startDate, endDate });
  return c.json({ data: items });
});

// GET /admin/usage/by-app - usage by app
adminUsage.get('/by-app', async (c) => {
  const appId = c.req.query('appId') ? Number(c.req.query('appId')) : undefined;
  if (appId === undefined) {
    return c.json({ error: 'appId query parameter is required' }, 400);
  }

  const startDate = c.req.query('startDate') ? new Date(c.req.query('startDate')!) : undefined;
  const endDate = c.req.query('endDate') ? new Date(c.req.query('endDate')!) : undefined;

  const items = await getUsageByApp(appId, { startDate, endDate });
  return c.json({ data: items });
});

// GET /admin/usage/by-user - usage by user
adminUsage.get('/by-user', async (c) => {
  const userId = c.req.query('userId') ? Number(c.req.query('userId')) : undefined;
  if (userId === undefined) {
    return c.json({ error: 'userId query parameter is required' }, 400);
  }

  const startDate = c.req.query('startDate') ? new Date(c.req.query('startDate')!) : undefined;
  const endDate = c.req.query('endDate') ? new Date(c.req.query('endDate')!) : undefined;

  const items = await getUsageByUser(userId, { startDate, endDate });
  return c.json({ data: items });
});

// GET /admin/usage/by-model - usage grouped by model
adminUsage.get('/by-model', async (c) => {
  const startDate = c.req.query('startDate') ? new Date(c.req.query('startDate')!) : undefined;
  const endDate = c.req.query('endDate') ? new Date(c.req.query('endDate')!) : undefined;

  const items = await getUsageByModel({ startDate, endDate });
  return c.json({ data: items });
});

// GET /admin/usage/trends - time series trends
adminUsage.get('/trends', async (c) => {
  const startDate = c.req.query('startDate') ? new Date(c.req.query('startDate')!) : undefined;
  const endDate = c.req.query('endDate') ? new Date(c.req.query('endDate')!) : undefined;
  const granularity = (c.req.query('granularity') ?? 'day') as 'hour' | 'day' | 'week' | 'month';
  const apiKeyId = c.req.query('apiKeyId') ? Number(c.req.query('apiKeyId')) : undefined;
  const appId = c.req.query('appId') ? Number(c.req.query('appId')) : undefined;
  const userId = c.req.query('userId') ? Number(c.req.query('userId')) : undefined;

  const items = await getUsageTrends({
    startDate,
    endDate,
    granularity,
    apiKeyId,
    appId,
    userId,
  });
  return c.json({ data: items });
});

// GET /admin/usage/by-app-user - usage by app end-users (from request_logs)
adminUsage.get('/by-app-user', async (c) => {
  const appId = c.req.query('appId') ? Number(c.req.query('appId')) : undefined;

  const startDate = c.req.query('startDate') ? new Date(c.req.query('startDate')!) : undefined;
  const endDate = c.req.query('endDate') ? new Date(c.req.query('endDate')!) : undefined;
  const page = c.req.query('page') ? Number(c.req.query('page')) : undefined;
  const pageSize = c.req.query('pageSize') ? Number(c.req.query('pageSize')) : undefined;
  const featureId = c.req.query('featureId') || undefined;
  const search = c.req.query('search')?.trim() || undefined;

  const result = await getUsageByAppUser({ appId, featureId, search, startDate, endDate, page, pageSize });
  return c.json({
    data: result.data,
    summary: result.summary,
    pagination: {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
    },
  });
});

// GET /admin/usage/by-feature - usage grouped by feature identifier
adminUsage.get('/by-feature', async (c) => {
  const appId = c.req.query('appId') ? Number(c.req.query('appId')) : undefined;
  const appUserId = c.req.query('appUserId') || undefined;
  const startDate = c.req.query('startDate') ? new Date(c.req.query('startDate')!) : undefined;
  const endDate = c.req.query('endDate') ? new Date(c.req.query('endDate')!) : undefined;
  const page = c.req.query('page') ? Number(c.req.query('page')) : undefined;
  const pageSize = c.req.query('pageSize') ? Number(c.req.query('pageSize')) : undefined;
  const search = c.req.query('search')?.trim() || undefined;

  const result = await getUsageByFeature({ appId, appUserId, search, startDate, endDate, page, pageSize });
  return c.json({
    data: result.data,
    summary: result.summary,
    pagination: {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
    },
  });
});