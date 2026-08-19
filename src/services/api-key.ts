import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index.js';
import { apiKeys } from '../db/schema.js';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { formatUtcDateTime } from '../db/repositories/logs.js';

export type KeyMode = 'user' | 'app' | 'admin' | 'dedicated';

export interface GeneratedKey {
  plainText: string;
  secret: string;
  prefix: string;
}

export interface CreateApiKeyParams {
  mode: KeyMode;
  name: string;
  userId?: number;
  appId?: number;
  permissions?: Record<string, unknown>;
  expiresAt?: Date;
  providerId?: number;
  upstreamApiKey?: string;
}

export function generateApiKey(mode: KeyMode): GeneratedKey {
  const prefix = mode === 'user' ? 'usr_sk_' : mode === 'app' ? 'app_sk_' : mode === 'admin' ? 'adm_sk_' : 'ded_sk_';
  const random = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
  const plainText = prefix + random.substring(0, 40);
  return { plainText, secret: plainText, prefix: plainText.substring(0, 12) };
}

export function detectKeyMode(key: string): KeyMode | null {
  if (key.startsWith('usr_sk_')) return 'user';
  if (key.startsWith('app_sk_')) return 'app';
  if (key.startsWith('adm_sk_')) return 'admin';
  if (key.startsWith('ded_sk_')) return 'dedicated';
  return null;
}

export async function validateApiKey(
  plainText: string,
): Promise<typeof apiKeys.$inferSelect | null> {
  const mode = detectKeyMode(plainText);
  if (!mode) return null;

  const db = getDb();

  // With plaintext storage, we can do an exact match lookup via unique index
  const [candidate] = await db
    .select()
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.keySecret, plainText),
        eq(apiKeys.mode, mode),
        inArray(apiKeys.status, ['active', 'quota_exceeded']),
      ),
    )
    .limit(1);

  if (!candidate) return null;
  if (candidate.expiresAt && candidate.expiresAt < new Date()) return null;
  return candidate;
}

export async function createApiKey(params: CreateApiKeyParams) {
  const generated = generateApiKey(params.mode);
  const db = getDb();

  await db.insert(apiKeys).values({
    keySecret: generated.secret,
    keyPrefix: generated.prefix,
    mode: params.mode,
    userId: params.userId ?? null,
    appId: params.appId ?? null,
    providerId: params.providerId ?? null,
    upstreamApiKeyEnc: params.upstreamApiKey ?? null,
    name: params.name,
    permissions: params.permissions ?? null,
    // UTC wall-clock literal: the connection session is pinned to UTC
    // (db/index.ts) and drizzle's typeCast reads TIMESTAMP as UTC, so bind a
    // UTC literal to keep the stored instant correct. See formatUtcDateTime.
    expiresAt: params.expiresAt ? sql`${formatUtcDateTime(params.expiresAt)}` : null,
    status: 'active',
  });

  const inserted = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keySecret, generated.secret))
    .limit(1);

  return { plainText: generated.plainText, record: inserted[0] };
}
