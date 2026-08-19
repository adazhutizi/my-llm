import { Hono } from 'hono';
import {
  getReportOverview,
  getReportTrends,
  getReportByModel,
  getReportByProvider,
  getReportByStatus,
} from '../../db/repositories/reports.js';
import type { ReportFilters } from '../../db/repositories/reports.js';

export const adminReports = new Hono();

// Parse the shared log-filter query params (same vocabulary as GET /admin/logs)
// into a ReportFilters object. Numbers use `Number(...) || undefined` so a
// malformed value collapses to undefined (and 0 never occurs for these ids).
function parseReportFilters(c: {
  req: { query: (name: string) => string | undefined };
}): ReportFilters {
  const q = c.req.query.bind(c.req);
  return {
    apiKeyId: Number(q('apiKeyId')) || undefined,
    appId: Number(q('appId')) || undefined,
    userId: Number(q('userId')) || undefined,
    groupId: Number(q('groupId')) || undefined,
    statusCode: Number(q('statusCode')) || undefined,
    model: q('model') || undefined,
    provider: q('provider') || undefined,
    appUserId: q('appUserId') || undefined,
    featureId: q('featureId') || undefined,
    requestPath: q('requestPath') || undefined,
    userAgent: q('userAgent') || undefined,
    startDate: q('startDate') ? new Date(q('startDate')!) : undefined,
    endDate: q('endDate') ? new Date(q('endDate')!) : undefined,
    hideArchived: q('hideArchived') === 'true',
  };
}

function parseGranularity(raw: string | undefined): 'hour' | 'day' | 'week' | 'month' {
  return raw === 'hour' || raw === 'week' || raw === 'month' ? raw : 'day';
}

// GET /admin/reports/overview - KPI summary for the current filter
adminReports.get('/overview', async (c) => {
  const data = await getReportOverview(parseReportFilters(c));
  return c.json({ data });
});

// GET /admin/reports/trends - time series (?granularity=hour|day|week|month)
adminReports.get('/trends', async (c) => {
  const filters = parseReportFilters(c);
  const granularity = parseGranularity(c.req.query('granularity'));
  const data = await getReportTrends({ ...filters, granularity });
  return c.json({ data });
});

// GET /admin/reports/by-model - token/request totals grouped by model
adminReports.get('/by-model', async (c) => {
  const data = await getReportByModel(parseReportFilters(c));
  return c.json({ data });
});

// GET /admin/reports/by-provider - token/request totals grouped by provider
adminReports.get('/by-provider', async (c) => {
  const data = await getReportByProvider(parseReportFilters(c));
  return c.json({ data });
});

// GET /admin/reports/by-status - request counts grouped by status-code class
adminReports.get('/by-status', async (c) => {
  const data = await getReportByStatus(parseReportFilters(c));
  return c.json({ data });
});
