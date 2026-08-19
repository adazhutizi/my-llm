import { Context, Next } from 'hono';
import { sign } from 'hono/jwt';
import { validateApiKey, detectKeyMode } from '../services/api-key.js';
import { verifyJwtToken } from '../services/admin-auth.js';
import { getConfig } from '../config/index.js';
import { getDb } from '../db/index.js';
import { appUsers, features, providers, users, apps } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { Errors, formatErrorForPath } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';
import { tryRestoreQuota } from '../services/quota.js';
import type { UsageData } from './usage-track.js';

// ─── Hono Context type augmentation ──────────────────────────────────────────

export interface AuthContext {
  mode: 'user' | 'app' | 'admin' | 'dedicated';
  keyId: number;
  userId?: number;
  appId?: number;
  appUserId?: number;
  appExternalUid?: string;
  featureId?: string;
  permissions?: Record<string, unknown>;
  authMethod?: 'api_key' | 'jwt';
  adminUserId?: number;
  adminUsername?: string;
  adminRole?: 'admin' | 'super_admin';
  // Dedicated (one-to-one) mode fields
  providerId?: number;
  providerBaseUrl?: string;
  providerApiType?: 'openai' | 'anthropic';
  providerName?: string;
  providerEstimateFallback?: boolean;
  upstreamApiKey?: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext;
    requestId: string;
    usage: UsageData;
    estimatedTokens: number;
  }
}

// ─── JWT detection ──────────────────────────────────────────────────────────

function isJWT(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

// ─── Middleware ───────────────────────────────────────────────────────────────

export async function authMiddleware(c: Context, next: Next) {
  const path = c.req.path;

  // 支持 Authorization: Bearer xxx 和 x-api-key: xxx 两种认证方式
  // Vercel AI SDK 的 Anthropic provider 使用 x-api-key 头
  let token: string | null = null;
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else {
    token = c.req.header('x-api-key') ?? null;
  }

  if (!token) {
    const error = Errors.authFailed('Missing or invalid Authorization header');
    return c.json(formatErrorForPath(path, error), error.statusCode);
  }

  // ── JWT path (admin routes only) ──
  if (isJWT(token)) {
    if (!path.startsWith('/admin')) {
      const error = Errors.authFailed('JWT authentication is only valid for admin routes');
      return c.json(formatErrorForPath(path, error), 401);
    }

    const payload = await verifyJwtToken(token);
    if (!payload) {
      const error = Errors.authFailed('Invalid or expired JWT token');
      return c.json(formatErrorForPath(path, error), 401);
    }

    c.set('auth', {
      mode: 'admin' as const,
      keyId: 0,
      authMethod: 'jwt',
      adminUserId: Number(payload.sub),
      adminUsername: payload.username as string,
      adminRole: payload.role as 'admin' | 'super_admin',
    });

    await next();

    // Sliding renewal: when the JWT nears expiry, mint a fresh token and expose
    // it via a response header so active admins stay logged in instead of being
    // bounced to the login page. `c.header()` after next() is supported by Hono
    // — it rebuilds the already-finalized Response and writes the header in.
    // `return` here is required: without it execution would fall through into
    // the API-key branch below and mis-handle the JWT.
    const now = Math.floor(Date.now() / 1000);
    const exp = typeof payload.exp === 'number' ? payload.exp : 0;
    const config = getConfig();
    if (exp - now < config.jwt.renewThreshold) {
      const fresh = await sign(
        {
          sub: String(payload.sub),
          username: payload.username,
          role: payload.role,
          iat: now,
          exp: now + config.jwt.expiresIn,
        },
        config.jwt.secret,
        'HS256',
      );
      c.header('X-Renewed-Token', fresh);
    }
    return;
  }

  // ── API key path (existing logic) ──
  const key = token;
  const mode = detectKeyMode(key);
  if (!mode) {
    const error = Errors.authFailed('Invalid API key format');
    return c.json(formatErrorForPath(path, error), error.statusCode);
  }

  // Validate key against database
  const keyRecord = await validateApiKey(key);
  if (!keyRecord) {
    const error = Errors.authFailed();
    return c.json(formatErrorForPath(path, error), error.statusCode);
  }

  // Check key status — validateApiKey returns active + quota_exceeded keys
  if (keyRecord.status === 'quota_exceeded') {
    // Lazy restore: if the quota window rolled over (past midnight Beijing
    // time) and both daily+monthly usage are back under the limits, auto-flip
    // to active and let the request through. tryRestoreQuota uses DB-accurate
    // checkQuota (not the 5s precheck cache) — a false restore would let an
    // over-quota key back in.
    const restored = await tryRestoreQuota('api_key', keyRecord.id);
    if (!restored) {
      const error = Errors.quotaExceeded(
        'API key suspended due to quota exceeded. Contact admin to restore.'
      );
      return c.json(formatErrorForPath(path, error), 429);
    }
    getLogger().info({ type: 'api_key', id: keyRecord.id }, 'Quota auto-restored (window rolled over)');
  }

  // Any other non-active status (revoked, expired) → auth failure
  if (keyRecord.status !== 'active') {
    const error = Errors.authFailed('API key is not active');
    return c.json(formatErrorForPath(path, error), error.statusCode);
  }

  // Quota auto-disable targets not only the API key but also the bound user and
  // app. The key status check above only covers the key — without these, a
  // disabled user/app would still pass auth on a still-active key.
  if (keyRecord.userId != null) {
    const [u] = await getDb()
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, keyRecord.userId))
      .limit(1);
    if (u?.status === 'quota_exceeded') {
      const restored = await tryRestoreQuota('user', keyRecord.userId);
      if (!restored) {
        const error = Errors.quotaExceeded('User quota exceeded. Contact admin to restore.');
        return c.json(formatErrorForPath(path, error), 429);
      }
      getLogger().info({ type: 'user', id: keyRecord.userId }, 'Quota auto-restored (window rolled over)');
    }
    if (u && u.status !== 'active') {
      const error = Errors.authFailed('User is not active');
      return c.json(formatErrorForPath(path, error), error.statusCode);
    }
  }
  if (keyRecord.appId != null) {
    const [a] = await getDb()
      .select({ status: apps.status })
      .from(apps)
      .where(eq(apps.id, keyRecord.appId))
      .limit(1);
    if (a?.status === 'quota_exceeded') {
      const restored = await tryRestoreQuota('app', keyRecord.appId);
      if (!restored) {
        const error = Errors.quotaExceeded('App quota exceeded. Contact admin to restore.');
        return c.json(formatErrorForPath(path, error), 429);
      }
      getLogger().info({ type: 'app', id: keyRecord.appId }, 'Quota auto-restored (window rolled over)');
    }
    if (a && a.status !== 'active') {
      const error = Errors.authFailed('App is not active');
      return c.json(formatErrorForPath(path, error), error.statusCode);
    }
  }

  // Build auth context
  const auth: AuthContext = {
    mode,
    keyId: keyRecord.id,
    userId: keyRecord.userId ?? undefined,
    appId: keyRecord.appId ?? undefined,
    permissions: (keyRecord.permissions as Record<string, unknown>) ?? undefined,
    authMethod: 'api_key',
  };

  // For dedicated mode: resolve bound provider info
  if (mode === 'dedicated' && keyRecord.providerId) {
    const db = getDb();
    const [provider] = await db
      .select({
        baseUrl: providers.baseUrl,
        apiType: providers.apiType,
        isActive: providers.isActive,
        name: providers.name,
        config: providers.config,
      })
      .from(providers)
      .where(eq(providers.id, keyRecord.providerId))
      .limit(1);

    if (!provider) {
      const error = Errors.authFailed('Bound provider no longer exists');
      return c.json(formatErrorForPath(path, error), error.statusCode);
    }
    if (!provider.isActive) {
      const error = Errors.authFailed('Bound provider is disabled');
      return c.json(formatErrorForPath(path, error), error.statusCode);
    }

    const cfg = (provider.config as Record<string, unknown>) || {};
    auth.providerId = keyRecord.providerId;
    auth.providerBaseUrl = provider.baseUrl;
    auth.providerApiType = provider.apiType;
    auth.providerName = provider.name;
    auth.providerEstimateFallback = cfg.estimateFallback === true;
    auth.upstreamApiKey = keyRecord.upstreamApiKeyEnc ?? '';
  }

  // For app mode: resolve or create app_users record from X-App-User-Id header
  if (mode === 'app' && keyRecord.appId != null) {
    const appExternalUid = c.req.header('X-App-User-Id');
    if (appExternalUid) {
      const db = getDb();

      let [appUser] = await db
        .select()
        .from(appUsers)
        .where(
          and(eq(appUsers.appId, keyRecord.appId), eq(appUsers.externalUid, appExternalUid)),
        )
        .limit(1);

      if (!appUser) {
        try {
          await db.insert(appUsers).values({
            appId: keyRecord.appId,
            externalUid: appExternalUid,
          });
        } catch (err) {
          // 并发首次见到同一 externalUid（多 pod 或同 pod 事件循环交错）时，另一请求
          // 已插入 → 撞 UNIQUE(app_id, external_uid)。吞掉，下方 select 拿已存在的行。
          if ((err as { code?: string }).code !== 'ER_DUP_ENTRY') throw err;
        }
        [appUser] = await db
          .select()
          .from(appUsers)
          .where(
            and(eq(appUsers.appId, keyRecord.appId), eq(appUsers.externalUid, appExternalUid)),
          )
          .limit(1);
      }

      if (appUser) {
        auth.appUserId = appUser.id;
        auth.appExternalUid = appExternalUid;
      }
    }
  }

  // Capture X-Feature-Id header (available for all API key modes)
  const featureId = c.req.header('X-Feature-Id');
  if (featureId) {
    auth.featureId = featureId;

    // For app mode: auto-register feature record (first-seen creates a row)
    if (mode === 'app' && keyRecord.appId != null) {
      const db = getDb();
      const [existing] = await db
        .select({ id: features.id })
        .from(features)
        .where(
          and(eq(features.appId, keyRecord.appId), eq(features.featureId, featureId)),
        )
        .limit(1);

      if (!existing) {
        try {
          await db.insert(features).values({
            appId: keyRecord.appId,
            featureId,
          });
        } catch (err) {
          // 并发首次见到同一 featureId → 撞 UNIQUE(app_id, feature_id)。吞掉即可，
          // 后续不读 id。
          if ((err as { code?: string }).code !== 'ER_DUP_ENTRY') throw err;
        }
      }
    }
  }

  c.set('auth', auth);
  await next();
}
