import { getDb } from '../index.js';
import { requestLogs, requestDetails, users } from '../schema.js';
import { eq, and, sql, count, inArray, type SQL } from 'drizzle-orm';
import { getConfig } from '../../config/index.js';
import { planArchive } from '../../services/log-dedup.js';
import { getNumberSetting, SETTING_KEYS } from './settings.js';

export interface ListRequestLogsFilters {
  apiKeyId?: number;
  appId?: number;
  userId?: number;
  appUserId?: string;
  featureId?: string;
  model?: string;
  provider?: string;
  statusCode?: number;
  /** Fuzzy match (LIKE '%...%') on request_details.request_path. */
  requestPath?: string;
  /** Fuzzy match (LIKE '%...%') on request_details.user_agent. */
  userAgent?: string;
  startDate?: Date;
  endDate?: Date;
  /**
   * Restrict to logs whose user belongs to this user group. request_logs has no
   * group_id column (group lives on users.group_id), so this is resolved via a
   * users subquery. Logs with no user (dedicated/admin keys) are excluded — a
   * NULL user_id can't belong to any group.
   */
  groupId?: number;
  /** Only return rows whose request_details.archived_at IS NULL. */
  hideArchived?: boolean;
}

export interface Pagination {
  page: number;
  pageSize: number;
}

/**
 * Format a Date as a UTC wall-clock SQL literal (YYYY-MM-DD HH:mm:ss).
 *
 * Every MySQL connection's session is pinned to UTC (see db/index.ts
 * `pool.on('connection') SET SESSION time_zone='+00:00'`). drizzle-orm's mysql2
 * typeCast forces `field.string()` on all TIMESTAMP/DATETIME/DATE columns — it
 * takes the raw server literal and mysql2's timezone option never applies — and
 * `mapFromDriverValue` then parses it as UTC (`new Date(value + "+0000")`). So
 * reads are correct ONLY when the server emits UTC literals, i.e. the session
 * is UTC. This helper emits a UTC wall-clock literal so sql-template bound
 * values (expires_at/last_login_at/archived_at writes, WHERE bounds, archive
 * cutoff) are stored/compared correctly under that UTC session.
 *
 * Uses getUTC* (not getHours etc.) so the output is independent of the Node
 * process timezone — no longer coupled to the container TZ.
 */
export function formatUtcDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * Build the WHERE conditions shared by listRequestLogs and the reports
 * aggregation queries, so filtering stays consistent between the log list and
 * report charts (single source of truth — no drift). Pure: returns the SQL[]
 * only; the caller owns the FROM/JOIN. See logFilterNeedsDetails for whether
 * the caller must LEFT JOIN request_details (the requestPath/userAgent/
 * hideArchived predicates reference it).
 *
 * NOTE: requestPath/userAgent use an unescaped `%${value}%` LIKE (matching the
 * historical listRequestLogs behavior) — admin-side filters already scoped by a
 * date range, so a user-supplied % just widens the match. Kept identical on
 * purpose so extracting this changes no list behavior.
 */
export function buildRequestLogConditions(filters: ListRequestLogsFilters): SQL[] {
  const conditions: SQL[] = [];

  if (filters.apiKeyId !== undefined) {
    conditions.push(eq(requestLogs.apiKeyId, filters.apiKeyId));
  }
  if (filters.appId !== undefined) {
    conditions.push(eq(requestLogs.appId, filters.appId));
  }
  if (filters.userId !== undefined) {
    conditions.push(eq(requestLogs.userId, filters.userId));
  }
  if (filters.groupId !== undefined) {
    // Resolve the group through the users table with an IN (subquery) — keeps
    // it off the FROM clause (no JOIN) and naturally excludes logs whose
    // user_id is NULL (dedicated/admin keys), since NULL is never IN a set.
    conditions.push(
      sql`${requestLogs.userId} IN (SELECT ${users.id} FROM ${users} WHERE ${users.groupId} = ${filters.groupId})`,
    );
  }
  if (filters.model) {
    conditions.push(eq(requestLogs.model, filters.model));
  }
  if (filters.statusCode !== undefined) {
    conditions.push(eq(requestLogs.statusCode, filters.statusCode));
  }
  if (filters.appUserId) {
    conditions.push(eq(requestLogs.appUserId, filters.appUserId));
  }
  if (filters.featureId) {
    conditions.push(eq(requestLogs.featureId, filters.featureId));
  }
  if (filters.provider) {
    conditions.push(eq(requestLogs.provider, filters.provider));
  }
  // Fuzzy match (LIKE '%...%') on request_details columns. The leading wildcard
  // precludes index use, but these are admin-side filters already scoped by the
  // date range below, so the scan stays bounded. NULL (details row purged) never
  // matches LIKE, so such logs drop out of the result — correct, since a purged
  // row has no path/UA to match. Values are bound parameters (no injection).
  if (filters.requestPath) {
    conditions.push(sql`${requestDetails.requestPath} LIKE ${`%${filters.requestPath}%`}`);
  }
  if (filters.userAgent) {
    conditions.push(sql`${requestDetails.userAgent} LIKE ${`%${filters.userAgent}%`}`);
  }
  // Date filters: the connection session is pinned to UTC (db/index.ts) and
  // drizzle reads TIMESTAMP as UTC, so bind UTC wall-clock literals to match.
  if (filters.startDate) {
    conditions.push(sql`${requestLogs.createdAt} >= ${formatUtcDateTime(filters.startDate)}`);
  }
  if (filters.endDate) {
    conditions.push(sql`${requestLogs.createdAt} <= ${formatUtcDateTime(filters.endDate)}`);
  }

  if (filters.hideArchived) {
    conditions.push(sql`${requestDetails.archivedAt} IS NULL`);
  }

  return conditions;
}

/**
 * Whether a query using buildRequestLogConditions must LEFT JOIN request_details.
 * Only the requestPath/userAgent/hideArchived predicates reference that table;
 * without them the join is dead weight (and request_details rows are heavy).
 * listRequestLogs always joins (it SELECTs details columns for display), but
 * report aggregation queries join only when this returns true.
 */
export function logFilterNeedsDetails(filters: ListRequestLogsFilters): boolean {
  return Boolean(filters.requestPath || filters.userAgent || filters.hideArchived);
}

export async function listRequestLogs(
  filters: ListRequestLogsFilters,
  pagination: Pagination,
) {
  const db = getDb();
  const conditions = buildRequestLogConditions(filters);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // LEFT JOIN request_details to surface the archive marker (archived_at) for
  // the list badge and to support the hideArchived filter. 1:1 on requestId.
  const [totalResult] = await db
    .select({ total: count() })
    .from(requestLogs)
    .leftJoin(requestDetails, eq(requestDetails.requestId, requestLogs.requestId))
    .where(where);

  const offset = (pagination.page - 1) * pagination.pageSize;

  const items = await db
    .select({
      id: requestLogs.id,
      requestId: requestLogs.requestId,
      apiKeyId: requestLogs.apiKeyId,
      appId: requestLogs.appId,
      userId: requestLogs.userId,
      appUserId: requestLogs.appUserId,
      featureId: requestLogs.featureId,
      model: requestLogs.model,
      provider: requestLogs.provider,
      statusCode: requestLogs.statusCode,
      latencyMs: requestLogs.latencyMs,
      promptTokens: requestLogs.promptTokens,
      completionTokens: requestLogs.completionTokens,
      cacheReadTokens: requestLogs.cacheReadTokens,
      cacheCreationTokens: requestLogs.cacheCreationTokens,
      isStream: requestLogs.isStream,
      errorMessage: requestLogs.errorMessage,
      createdAt: requestLogs.createdAt,
      archivedAt: requestDetails.archivedAt,
      // Reuses the existing LEFT JOIN above (no new JOIN/WHERE) so the list
      // can draw a merge arrow from each archived row to its successor.
      mergedInto: requestDetails.mergedInto,
      // request_logs has no path column; request_path lives on request_details.
      // Reusing the same LEFT JOIN — no extra cost. The list's "请求路径"
      // column reads it. Null when the details row was purged.
      requestPath: requestDetails.requestPath,
      // User-Agent, also on request_details — same LEFT JOIN, no extra cost.
      // Null when the details row was purged. Shown in the list's "UA" column.
      userAgent: requestDetails.userAgent,
    })
    .from(requestLogs)
    .leftJoin(requestDetails, eq(requestDetails.requestId, requestLogs.requestId))
    .where(where)
    // ORDER BY needs a deterministic tiebreaker: created_at has second
    // resolution and many log rows share a timestamp, so without id DESC MySQL's
    // sort is unstable and OFFSET pagination leaks rows between pages (page 2's
    // head re-shows page-1 rows). id is monotonically increasing with created_at
    // and unique, so (created_at DESC, id DESC) is a stable total order.
    .orderBy(sql`${requestLogs.createdAt} DESC, ${requestLogs.id} DESC`)
    .limit(pagination.pageSize)
    .offset(offset);

  return { items, total: totalResult?.total ?? 0 };
}

export async function getRequestDetail(requestId: string) {
  const db = getDb();

  const results = await db
    .select()
    .from(requestDetails)
    .where(eq(requestDetails.requestId, requestId))
    .limit(1);

  return results[0] ?? null;
}

/** Get distinct model and provider values from request_logs for filter dropdowns */
export async function getLogFilterOptions() {
  const db = getDb();

  const models = await db
    .selectDistinct({ model: requestLogs.model })
    .from(requestLogs)
    .where(sql`${requestLogs.model} IS NOT NULL`)
    .orderBy(requestLogs.model);

  const providers = await db
    .selectDistinct({ provider: requestLogs.provider })
    .from(requestLogs)
    .where(sql`${requestLogs.provider} IS NOT NULL`)
    .orderBy(requestLogs.provider);

  return {
    models: models.map((r) => r.model!),
    providers: providers.map((r) => r.provider!),
  };
}

// ─── Log archive: merge agentic loop sessions ──────────────────────────────────
//
// See plans/fizzy-painting-rabin.md. Single paged scan: walk unarchived rows
// older than the cutoff by primary key (`id > lastId ... ORDER BY id LIMIT N`)
// and run planArchive within each page. FORCE INDEX (PRIMARY) is what makes
// the PK walk real — without it the `created_at < cutoff` range lures the
// optimizer onto idx_request_details_created_at, so ORDER BY id filesorts.
// Each row averages ~53KB and reaches ~1MB (full request_body JSON), so that
// filesort overflows the 2MB sort_buffer_size → "Out of sort memory" once old
// rows back up. (A prior two-pass variant re-selected each session group with
// `WHERE id IN (...) ORDER BY id` and hit the same error on large groups.)
//
// A page holds batchSize rows (default 200) — small on purpose, since each
// row's request_body can exceed 1MB and the whole page is loaded into the JS
// heap at once (a large page OOMs the gateway mid-archive). A conversation's
// prefix chain may straddle pages; that only defers its merge to the next
// daily run — no data loss, since the strict-prefix check is the real signal.
//
// Correctness comes from the content-level strict-prefix check, not from the
// clustering — a collision only widens a group, never causes a wrong merge.

export interface RunLogArchiveOptions {
  retentionDays?: number;
  sessionTimeoutMin?: number;
  batchSize?: number;
  maxAgeDays?: number;
  logsRetentionDays?: number;
}

export interface LogArchiveStats {
  scanned: number;
  cleaned: number;
  kept: number;
  deleted: number;
  deletedLogs: number;
  cutoff: string;
}

interface ArchiveRow {
  id: number;
  requestId: string;
  apiKeyId: number;
  requestBody: unknown;
  createdAt: Date;
}

export async function runLogArchive(
  opts: RunLogArchiveOptions = {},
): Promise<LogArchiveStats> {
  // Defaults come from config so manual archive runs (which may omit some
  // options) agree with the scheduler. A hardcoded `?? 30` for sessionTimeout
  // here previously made manual runs use a 30-min session window while the
  // scheduler used the 7-day config default — they now match.
  const cfg = getConfig().log.archive;
  const retentionDays = opts.retentionDays ?? cfg.retentionDays;
  const sessionTimeoutMin = opts.sessionTimeoutMin ?? cfg.sessionTimeoutMin;
  const batchSize = opts.batchSize ?? cfg.batchSize;
  // Retention periods are runtime-configurable from system_settings (the admin
  // "系统设置" page); fall back to the config defaults when no value is saved.
  // maxAgeDays governs request_details (heavy payloads), logsRetentionDays
  // request_logs (lightweight list rows, kept longer by default).
  const maxAgeDays = opts.maxAgeDays
    ?? await getNumberSetting(SETTING_KEYS.logDetailsRetentionDays, cfg.maxAgeDays);
  const logsRetentionDays = opts.logsRetentionDays
    ?? await getNumberSetting(SETTING_KEYS.logLogsRetentionDays, cfg.logsRetentionDays);

  const db = getDb();
  const sessionTimeoutMs = sessionTimeoutMin * 60_000;
  const cutoffDate = new Date(Date.now() - retentionDays * 86_400_000);
  // created_at is a TIMESTAMP column read as UTC under the pinned UTC session
  // (db/index.ts); bind a UTC literal so the cutoff lands on the right day.
  const cutoff = formatUtcDateTime(cutoffDate);

  // Physical purge of rows older than maxAgeDays. Old detail rows no longer
  // earn a content-level prefix comparison, so instead of merging we delete
  // them outright — this bounds per-run work (the merge scan never grows into
  // years of history) and caps request_details growth. Batched DELETE ... LIMIT
  // so a large backlog (first enable, or after a few days of downtime) doesn't
  // hold one giant lock / balloon the binlog. No archived_at filter: already-
  // merged rows (big fields nulled) still occupy a row shell to reclaim.
  // idx_request_details_created_at makes the range efficient; LIMIT without
  // ORDER BY is fine — we loop until a batch comes back under-full.
  const maxAgeDate = new Date(Date.now() - maxAgeDays * 86_400_000);
  const maxAgeCutoff = formatUtcDateTime(maxAgeDate);
  let deleted = 0;
  for (;;) {
    const [delResult] = await db.execute(sql`
      DELETE FROM request_details
      WHERE created_at < ${maxAgeCutoff}
      LIMIT ${batchSize}
    `);
    const affected = Number(
      (delResult as { affectedRows?: number } | undefined)?.affectedRows ?? 0,
    );
    deleted += affected;
    if (affected < batchSize) break;
  }

  // Physical purge of request_logs older than logsRetentionDays. request_logs is
  // the lightweight list/stats table (no payload fields), so it is kept longer
  // than request_details by default; the archive run deletes it in the same
  // batched manner. idx_request_logs_created_at makes the range efficient.
  const logsCutoff = formatUtcDateTime(new Date(Date.now() - logsRetentionDays * 86_400_000));
  let deletedLogs = 0;
  for (;;) {
    const [delResult] = await db.execute(sql`
      DELETE FROM request_logs
      WHERE created_at < ${logsCutoff}
      LIMIT ${batchSize}
    `);
    const affected = Number(
      (delResult as { affectedRows?: number } | undefined)?.affectedRows ?? 0,
    );
    deletedLogs += affected;
    if (affected < batchSize) break;
  }

  // Single paged scan. `id > lastId ... ORDER BY id LIMIT N` walks the table
  // in primary-key order — but only because FORCE INDEX (PRIMARY) pins it.
  // Without the hint, `created_at < cutoff` sends the optimizer onto
  // idx_request_details_created_at and ORDER BY id then filesorts the ~53KB/
  // 1MB request_body rows into the 2MB sort_buffer_size → "Out of sort memory"
  // (see the section comment above). batchSize defaults to 200 — small on
  // purpose so a page's worth of up-to-1MB request_body rows stays well under
  // the Node heap (a large page OOMs mid-archive); a prefix chain that
  // straddles pages just defers its merge to the next run (no data loss).
  let scanned = 0;
  let cleaned = 0;
  let lastId = 0;
  for (;;) {
    // FORCE INDEX (PRIMARY): pin the PK so the `id > lastId ... ORDER BY id`
    // scan stays in id order. Drizzle's query builder can't attach an index
    // hint — `.from(sql`... FORCE INDEX ...`)` makes drizzle treat the clause
    // as an anonymous table and reject the request_details column refs — so
    // this scan runs as raw SQL via db.execute(). Without the hint the
    // optimizer picks idx_request_details_created_at (due to `created_at <
    // cutoff`) and ORDER BY id filesorts the ~53KB/1MB request_body rows into
    // the 2MB sort_buffer_size → "Out of sort memory". EXPLAIN confirms the
    // hinted plan: type=range, key=PRIMARY, Extra="Using where" (no filesort).
    // Raw execute bypasses drizzle's column mapping: bigint cols come back as
    // numbers within safe range but Number() is kept for safety; the json col
    // is already parsed by mysql2 (defensive parse just in case); and
    // timestamps come back as 'YYYY-MM-DD HH:mm:ss' strings in session-local
    // time, so wrap in new Date() — planArchive calls .getTime() on them and a
    // bare string would throw.
    const [rawRows] = await db.execute(sql`
      SELECT id, request_id, api_key_id, request_body, created_at
      FROM request_details FORCE INDEX (PRIMARY)
      WHERE id > ${lastId}
        AND archived_at IS NULL
        AND created_at < ${cutoff}
        AND created_at >= ${maxAgeCutoff}
      ORDER BY id
      LIMIT ${batchSize}
    `);
    const batch: ArchiveRow[] = (rawRows as unknown as unknown[]).map((raw) => {
      const r = raw as Record<string, unknown>;
      const body = r.request_body;
      return {
        id: Number(r.id),
        requestId: r.request_id as string,
        apiKeyId: Number(r.api_key_id),
        requestBody: typeof body === 'string' ? JSON.parse(body) : body,
        createdAt: new Date(r.created_at as string),
      };
    });

    if (batch.length === 0) break;
    lastId = batch[batch.length - 1].id;
    scanned += batch.length;

    // Pure merge decision (see services/log-dedup.ts → planArchive): clusters
    // the batch by session and marks each superseded prefix for cleanup.
    const toClean = planArchive(batch, sessionTimeoutMs);

    // Batch the UPDATEs by successor so one statement covers many rows.
    // Guarded by `archived_at IS NULL` for idempotency — re-running the task
    // or overlapping scheduled + manual runs never double-processes a row.
    const byTarget = new Map<string, number[]>();
    for (const c of toClean) {
      const arr = byTarget.get(c.mergedInto);
      if (arr) arr.push(c.id);
      else byTarget.set(c.mergedInto, [c.id]);
    }
    for (const [mergedInto, idList] of byTarget) {
      await db
        .update(requestDetails)
        .set({
          requestBody: null,
          requestHeaders: null,
          responseBody: null,
          streamChunks: null,
          archivedAt: sql`${formatUtcDateTime(new Date())}`,
          mergedInto,
        })
        .where(
          and(
            inArray(requestDetails.id, idList),
            sql`${requestDetails.archivedAt} IS NULL`,
          ),
        );
    }

    cleaned += toClean.length;
  }

  return { scanned, cleaned, kept: scanned - cleaned, deleted, deletedLogs, cutoff };
}
