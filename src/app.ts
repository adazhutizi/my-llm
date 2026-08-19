import { existsSync } from 'node:fs';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { requestIdMiddleware } from './middleware/request-id.js';
import { authMiddleware } from './middleware/auth.js';
import { adminAuthMiddleware } from './middleware/admin-auth.js';
import { rateLimitMiddleware } from './middleware/rate-limit.js';
import { quotaCheckMiddleware } from './middleware/quota-check.js';
import { usageTrackMiddleware } from './middleware/usage-track.js';
import { dedicatedProxyMiddleware } from './middleware/dedicated-proxy.js';
import { requestLogMiddleware } from './middleware/request-log.js';
import { chatCompletions } from './routes/openai/chat-completions.js';
import { responses } from './routes/openai/responses.js';
import { embeddings } from './routes/openai/embeddings.js';
import { models } from './routes/openai/models.js';
import { imageGenerations } from './routes/openai/images-generations.js';
import { messages } from './routes/anthropic/messages.js';
import { adminApiKeys } from './routes/admin/api-keys.js';
import { adminUsers } from './routes/admin/users.js';
import { adminUserGroups } from './routes/admin/user-groups.js';
import { adminAdmins } from './routes/admin/admins.js';
import { adminApps } from './routes/admin/apps.js';
import { adminModels } from './routes/admin/models.js';
import { adminProviders } from './routes/admin/providers.js';
import { adminRateLimits } from './routes/admin/rate-limits.js';
import { adminUsage } from './routes/admin/usage.js';
import { adminLogs } from './routes/admin/logs.js';
import { adminSettings } from './routes/admin/settings.js';
import { adminAnalysis } from './routes/admin/analysis.js';
import { adminReports } from './routes/admin/reports.js';
import { adminQuotas } from './routes/admin/quotas.js';
import { adminAuth } from './routes/admin/auth.js';
import {
  GatewayError,
  formatErrorForPath,
  Errors,
} from './utils/errors.js';
import { startCleanup, stopCleanup } from './services/rate-limiter.js';
import { startQuotaCacheCleanup, stopQuotaCacheCleanup } from './services/quota-cache.js';
import { startLogArchiveCleanup, stopLogArchiveCleanup } from './services/log-archive.js';

const app = new Hono();

// ── Global middleware ────────────────────────────────────────────────────

app.use(
  '*',
  cors({ exposeHeaders: ['X-Renewed-Token'] }),
);
app.use('*', requestIdMiddleware);
app.use('*', requestLogMiddleware);

// ── Health check (unauthenticated) ──────────────────────────────────────

app.get('/health', (c) =>
  c.json({ status: 'ok', timestamp: new Date().toISOString() }),
);


// ── OpenAI-compatible routes ────────────────────────────────────────────

app.use('/openai/*', authMiddleware);
app.use('/openai/*', rateLimitMiddleware);
app.use('/openai/*', quotaCheckMiddleware);
app.use('/openai/*', usageTrackMiddleware);
app.use('/openai/*', dedicatedProxyMiddleware);
app.route('/openai/v1/chat/completions', chatCompletions);
app.route('/openai/v1/responses', responses);
app.route('/openai/v1/embeddings', embeddings);
app.route('/openai/v1/models', models);
app.route('/openai/v1/images/generations', imageGenerations);

// ── Anthropic-compatible routes ─────────────────────────────────────────

app.use('/anthropic/*', authMiddleware);
app.use('/anthropic/*', rateLimitMiddleware);
app.use('/anthropic/*', quotaCheckMiddleware);
app.use('/anthropic/*', usageTrackMiddleware);
app.use('/anthropic/*', dedicatedProxyMiddleware);
app.route('/anthropic/v1/messages', messages);

// ── Admin auth (unauthenticated — login endpoint) ────────────────────────

app.route('/admin/auth', adminAuth);

// ── Admin routes (require admin auth) ──────────────────────────────────

app.use('/admin/*', authMiddleware);
app.use('/admin/*', adminAuthMiddleware);
app.route('/admin/api-keys', adminApiKeys);
app.route('/admin/users', adminUsers);
// Registered before app.route('/admin', adminQuotas) for the same reason as
// /admin/settings (app.ts comment above): adminQuotas is mounted at the /admin
// root and its /:type/:id sub-route would otherwise capture /admin/user-groups
// as type=user-groups. The more-specific path must win.
app.route('/admin/user-groups', adminUserGroups);
app.route('/admin/admins', adminAdmins);
app.route('/admin/apps', adminApps);
app.route('/admin/models', adminModels);
app.route('/admin/providers', adminProviders);
app.route('/admin/rate-limits', adminRateLimits);
app.route('/admin/usage', adminUsage);
app.route('/admin/logs', adminLogs);
// Registered BEFORE app.route('/admin', adminQuotas): adminQuotas is mounted at
// the /admin root and its /:type/:id sub-route would otherwise capture
// /admin/settings as type=settings. The more-specific path must win.
app.route('/admin/settings', adminSettings);
// Same reason as /admin/settings above — adminQuotas' /:type/:id would capture
// /admin/analysis as type=analysis. Mounted on the /admin root, this owns
// POST /admin/analysis/chat (SSE) + GET /admin/analysis/config.
app.route('/admin/analysis', adminAnalysis);
// Same reason as /admin/settings & /admin/analysis above — adminQuotas' /:type/:id
// catch-all would capture /admin/reports as type=reports. Owns the 5 report
// aggregation endpoints (overview/trends/by-model/by-provider/by-status).
app.route('/admin/reports', adminReports);
app.route('/admin', adminQuotas);

// ── Dashboard (static files, built from web/) ──────────────────────────
// Build the dashboard with `cd web && npm install && npm run build` first.
// Next.js 16 static export outputs to web/out/ with per-route HTML files
// (e.g. login.html instead of login/index.html), so we resolve .html
// extensions manually via rewriteRequestPath.
//
// IMPORTANT: Must be registered BEFORE the catch-all /* route below.
// The dashboard is a static frontend — its login page carries no
// Authorization header, so if /dashboard/* matched the catch-all first,
// authMiddleware would return 401 and the request would never reach
// serveStatic. serveStatic calls next() when no file matches, so it falls
// through cleanly to the catch-all for any path without a corresponding asset.

const DASHBOARD_ROOT = './web/out';

app.use(
  '/dashboard/*',
  serveStatic({
    root: DASHBOARD_ROOT,
    rewriteRequestPath: (reqPath) => {
      const stripped = reqPath.replace(/^\/dashboard/, '');
      // If the path has no extension and a .html file exists, rewrite to it
      if (!stripped.includes('.') && stripped !== '/' && existsSync(`${DASHBOARD_ROOT}${stripped}.html`)) {
        return `${stripped}.html`;
      }
      return stripped;
    },
  }),
);

// ── Catch-all: dedicated key transparent proxy on ANY path ──────────────
// Must be registered AFTER both the admin routes AND the dashboard above:
//   - /admin/* paths are matched by the admin middleware above, not here.
//   - /dashboard/* static assets are served above, not intercepted here.
// Only handles requests not matched by any specific route above.
// dedicatedProxyMiddleware is a no-op for non-dedicated keys → 404.
app.all('/*', authMiddleware, rateLimitMiddleware, quotaCheckMiddleware, usageTrackMiddleware, dedicatedProxyMiddleware);

// ── Error handler ───────────────────────────────────────────────────────

app.onError((err, c) => {
  const path = c.req.path;

  if (err instanceof GatewayError) {
    return c.json(formatErrorForPath(path, err), err.statusCode);
  }

  const internal = Errors.internal(err.message || 'Internal server error');
  return c.json(formatErrorForPath(path, internal), 500);
});

// ── 404 handler ─────────────────────────────────────────────────────────

app.notFound((c) => {
  const error = Errors.invalidRequest(`Route not found: ${c.req.method} ${c.req.path}`);
  return c.json(formatErrorForPath(c.req.path, error), 404);
});

// ── Lifecycle helpers (used by index.ts) ────────────────────────────────

export function startRateLimiterCleanup(): void {
  startCleanup();
}

export function stopRateLimiterCleanup(): void {
  stopCleanup();
}

export function startQuotaCleanup(): void {
  startQuotaCacheCleanup();
}

export function stopQuotaCleanup(): void {
  stopQuotaCacheCleanup();
}

export function startLogArchive(): void {
  startLogArchiveCleanup();
}

export function stopLogArchive(): void {
  stopLogArchiveCleanup();
}

export default app;
