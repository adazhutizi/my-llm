import { z } from 'zod';
import { tool } from '@openai/agents';
import { sql, type SQL } from 'drizzle-orm';
import {
  getUsageOverview,
  getUsageByModel,
  getUsageTrends,
} from '../db/repositories/usage.js';
import { getLogFilterOptions, formatUtcDateTime } from '../db/repositories/logs.js';
import { likePattern } from '../db/repositories/like.js';
import { getDb } from '../db/index.js';
import {
  QUERYABLE_TABLES,
  TABLE_NAMES,
  TABLE_BY_NAME,
  COLUMN_NAMES_BY_TABLE,
  COLUMN_META_BY_TABLE,
  SENSITIVE_BY_TABLE,
  buildQueryTableDescription,
  findJoinRelation,
  describeJoinPaths,
  type ColKind,
} from './query-table-schema.js';

// ─────────────────────────────────────────────────────────────────────────────
// Analysis tools — read-only queries over the gateway's own operational data.
//
// Each tool wraps an existing repository function with a Chinese description
// (the model uses these to decide when to call which tool). Every execute()
// swallows errors and returns `{ error }` instead of throwing, so a single
// failed tool call degrades the answer rather than aborting the whole run.
//
// WHY strict:false + JSON Schema (NOT strict zod):
// agents-core's `tool()` with a Zod schema forces strict:true (all fields
// required + nullable, no preprocess) and then parses the model's arguments
// with that Zod schema BEFORE execute() runs. DashScope/qwen and other
// non-OpenAI providers are sloppy about function-calling types: they send
// numbers as strings ("10") and fill unused ID fields with "" / "None" /
// "0". Strict Zod parse rejects those with InvalidToolInputError, which the
// SDK raises before execute() — so the tool's own try/catch never sees it.
// The model retries with the same stringy args and the run loops until
// MaxTurnsExceeded (verified against qwen3.7-max via DashScope).
//
// strict:false with a JSON Schema skips Zod validation entirely — execute()
// receives the RAW argument object and we clean it ourselves (cleanInt /
// parseDate / cleanGranularity). This is robust to any provider's type
// fidelity. The Zod schemas below are still the single source of truth;
// z.toJSONSchema() converts them to the JSON Schema the model actually sees.
//
// Date handling: the model passes ISO 8601 UTC strings; we parse them to Date
// and hand them to the repository. record_time is a UTC wall-clock literal and
// drizzle serialises Date params via toISOString() (UTC), so the values line up
// with no further offset. The trend query already shifts to Beijing via
// CONVERT_TZ for bucketing — the bridge does NOT apply any second offset.
// ─────────────────────────────────────────────────────────────────────────────

const GRANULARITIES = ['hour', 'day', 'week', 'month'] as const;
type Granularity = (typeof GRANULARITIES)[number];

function parseDate(value: unknown): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const d = new Date(typeof value === 'string' ? value : String(value));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Coerce a model-supplied value to an integer id, tolerating the stringy forms
 * sloppy providers emit: "10" → 10, "" / "None" / "null" / "0" abuse → undefined.
 */
function cleanInt(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '' || /^(none|null|nan|undefined)$/i.test(s)) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function cleanGranularity(v: unknown): Granularity | undefined {
  return typeof v === 'string' && (GRANULARITIES as readonly string[]).includes(v)
    ? (v as Granularity)
    : undefined;
}

interface AnalysisFilters {
  startDate?: Date;
  endDate?: Date;
  userId?: number;
  appId?: number;
  apiKeyId?: number;
}

function parseFilters(raw: unknown): AnalysisFilters {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    startDate: parseDate(o.startDate),
    endDate: parseDate(o.endDate),
    userId: cleanInt(o.userId),
    appId: cleanInt(o.appId),
    apiKeyId: cleanInt(o.apiKeyId),
  };
}

/** Read an arbitrary typed field off the raw (unvalidated) tool input object. */
function fieldOf(raw: unknown, key: string): unknown {
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[key] : undefined;
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

// Shared date-range + scope filter fields. Zod is the single source of truth;
// z.toJSONSchema() below converts each tool's Zod object into the JSON Schema
// the model sees (strict:false, so fields stay genuinely optional).
const filterShape = {
  startDate: z
    .string()
    .optional()
    .describe('时间下界，ISO 8601 UTC 字符串，例如 2025-01-01T00:00:00Z。不传则不设下界（从最早记录算起）'),
  endDate: z
    .string()
    .optional()
    .describe('时间上界，ISO 8601 UTC 字符串，例如 2025-02-01T00:00:00Z。不传则不设上界（到最新记录）'),
  userId: z.number().int().optional().describe('用户 ID（数字）；不确定则不传，不要传空字符串'),
  appId: z.number().int().optional().describe('应用 ID（数字）；不确定则不传，不要传空字符串'),
  apiKeyId: z.number().int().optional().describe('API 密钥 ID（数字）；不确定则不传，不要传空字符串'),
};

// agents-core's tool() in strict:false mode accepts a plain JSON Schema object
// at runtime (verified), but its TS type (JsonObjectSchemaNonStrict, defined in
// the transitive @openai/agents-core package) isn't re-exported by @openai/agents
// and its `additionalProperties: true` literal won't match zod's output anyway.
// We bridge the purely nominal mismatch with `any` at this single boundary;
// the runtime JSON Schema shape is correct and was validated end-to-end.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toJsonSchema = (s: z.ZodType): any => z.toJSONSchema(s);

// ─── query_table: controlled parameterized query ─────────────────────────────
// Lets the model SELECT from whitelisted tables with whitelisted columns /
// operators; every value is parameter-bound. The whitelist (from
// query-table-schema.ts) IS the SQL-injection boundary — sql.identifier() does
// NOT escape backticks (drizzle docs: "validate input beforehand"), so we never
// interpolate untrusted text into SQL structure. See plan calm-purring-bachman.md.
const QUERY_TIMEOUT_MS = 5000;
const QUERY_DEFAULT_LIMIT = 100;
const QUERY_MAX_LIMIT = 500;
const HEAVY_MAX_CHARS = 1000;
const MAX_RESULT_BYTES = 30_000;
const ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const AGG_FUNCS = ['SUM', 'COUNT', 'AVG', 'MIN', 'MAX'] as const;
type AggFunc = (typeof AGG_FUNCS)[number];
const OPS = [
  '=', '!=', '>', '>=', '<', '<=',
  'LIKE', 'NOT LIKE', 'IN', 'NOT IN', 'IS NULL', 'IS NOT NULL',
] as const;
// op → fixed SQL text. Each value is a literal from the OPS enum, rendered via
// sql.raw(); the enum check in isOp() guarantees no untrusted string reaches here.
const OP_TEXT: Record<string, string> = {
  '=': '=', '!=': '!=', '>': '>', '>=': '>=', '<': '<', '<=': '<=',
  LIKE: 'LIKE', 'NOT LIKE': 'NOT LIKE', IN: 'IN', 'NOT IN': 'NOT IN',
  'IS NULL': 'IS NULL', 'IS NOT NULL': 'IS NOT NULL',
};

interface SelectColumn {
  table: string; // owning table ('' only for COUNT(*)); bare for single-table render
  column: string; // DB column name or '*' (only with COUNT)
  func?: AggFunc;
  alias?: string;
  outputKey: string; // result-row key: alias → column → table_column (JOIN disambig)
  kind: ColKind; // for deterministic coerce; aggregates → decimal/int
  heavy: boolean;
}
// A validated JOIN. ON columns + the relation itself are whitelisted in
// parseQuerySpec; polymorphic rows (rate_limits / ua_policies) carry the
// discriminator column (always on the polymorphic side) + the fixed typeValue
// (whitelist constant).
interface JoinClause {
  table: string; // table being joined
  from: string; // left-side table (main or a previously-joined table)
  leftCol: string; // ON column on `from`
  rightCol: string; // ON column on `table`
  type: 'INNER' | 'LEFT';
  polymorphicSide: 'from' | 'to' | null; // which side is the polymorphic table (rate_limits / ua_policies)
  typeColumn?: string; // e.g. rate_limits.target_type (polymorphic only)
  typeValue?: string; // 'api_key' | 'user' | 'app' (polymorphic only; whitelist constant)
}
interface QuerySpec {
  table: string;
  joins: JoinClause[];
  involvedTables: Set<string>; // main + every joined table (connected-tree check)
  selectColumns: SelectColumn[];
  where?: SQL;
  groupBy?: SQL;
  orderBy?: SQL;
  limit: number;
}
type SpecResult = { ok: true; spec: QuerySpec } | { ok: false; error: string };

const specError = (error: string): SpecResult => ({ ok: false, error });

// drizzle's sql.identifier() takes ONE arg and does NOT escape backticks (per
// the drizzle docs: "validate input beforehand"), so the column/table NAME
// whitelist is the real SQL-injection boundary — these helpers only render
// already-validated identifiers. Qualified `\`t\`.\`c\`` is built by joining two
// single-arg identifiers with a raw dot (sql.identifier(t, c) does not exist).
//
// sql.identifier() returns drizzle's `Name` type, not `SQL`; both are valid
// inside sql`` templates and sql.join(), so helpers/locals that may hold either
// use SqlFragment. (Name isn't a subtype of SQL — assigning it to a `: SQL`
// annotation trips TS2740.)
type SqlFragment = SQL | ReturnType<typeof sql.identifier>;
function ident(table: string, column?: string): SqlFragment {
  if (!column) return sql.identifier(table);
  return sql.join([sql.identifier(table), sql.identifier(column)], sql.raw('.'));
}
// Single-table mode keeps bare `\`column\`` (backward compat — existing tests
// assert on raw column names). JOIN mode qualifies every column ref so two
// tables can't collide on a same-named column (e.g. both have `id`).
function colIdent(table: string, column: string, qualify: boolean): SqlFragment {
  return qualify ? ident(table, column) : sql.identifier(column);
}

function isAggFunc(v: unknown): v is AggFunc {
  return typeof v === 'string' && (AGG_FUNCS as readonly string[]).includes(v);
}
function isOp(v: unknown): v is (typeof OPS)[number] {
  return typeof v === 'string' && (OPS as readonly string[]).includes(v);
}

/** Coerce a filter value to the column's declared kind, or reject. */
function coerceFilterValue(
  raw: unknown,
  kind: ColKind,
  enumValues: readonly string[] | undefined,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: false, error: 'value 不能为空（判空请用 IS NULL）' };
  }
  switch (kind) {
    case 'datetime': {
      const d = parseDate(raw);
      if (!d) return { ok: false, error: `日期值无效：${String(raw)}` };
      return { ok: true, value: formatUtcDateTime(d) };
    }
    case 'int':
    case 'bigint': {
      const n = cleanInt(raw);
      if (n === undefined) return { ok: false, error: `整数值无效：${String(raw)}` };
      return { ok: true, value: n };
    }
    case 'decimal': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, error: `数值无效：${String(raw)}` };
      return { ok: true, value: n };
    }
    case 'enum': {
      const s = String(raw);
      if (!enumValues || !enumValues.includes(s)) {
        return { ok: false, error: `枚举值无效：${s}（允许：${enumValues?.join(', ') ?? '(未定义)'}）` };
      }
      return { ok: true, value: s };
    }
    case 'bool': {
      if (raw === true || raw === 1 || raw === '1' || raw === 'true') return { ok: true, value: true };
      if (raw === false || raw === 0 || raw === '0' || raw === 'false') return { ok: true, value: false };
      return { ok: false, error: `布尔值无效：${String(raw)}` };
    }
    case 'json':
      return { ok: true, value: raw };
    case 'string':
    case 'text':
    default:
      return { ok: true, value: String(raw) };
  }
}

function buildFilterFragment(
  f: Record<string, unknown>,
  defaultTable: string,
  involvedTables: Set<string>,
  qualify: boolean,
): { ok: true; fragment: SQL } | { ok: false; error: string } {
  // Resolve which table this filter's column lives on. JOIN mode REQUIRES an
  // explicit table prefix (a same-named column may exist on two tables);
  // single-table mode defaults to the main table.
  const filterTable =
    typeof f.table === 'string' && f.table ? f.table : defaultTable;
  if (!involvedTables.has(filterTable)) {
    return { ok: false, error: `筛选列的表 '${filterTable}' 不在本次查询涉及的表中` };
  }
  const column = typeof f.column === 'string' ? f.column : '';
  const colNames = COLUMN_NAMES_BY_TABLE.get(filterTable)!;
  const sensitive = SENSITIVE_BY_TABLE.get(filterTable)!;
  if (!column || !colNames.has(column)) {
    return { ok: false, error: `未知列名：${column || '(空)'}` };
  }
  if (sensitive.has(column)) {
    return { ok: false, error: `列 '${filterTable}.${column}' 是敏感字段，不允许作为筛选条件` };
  }
  if (!isOp(f.op)) {
    return { ok: false, error: `不支持的操作符：${String(f.op)}` };
  }
  const op: (typeof OPS)[number] = f.op;
  const colMeta = COLUMN_META_BY_TABLE.get(filterTable)!.get(column)!;
  const identCol = colIdent(filterTable, column, qualify);

  if (op === 'IS NULL') return { ok: true, fragment: sql`${identCol} IS NULL` };
  if (op === 'IS NOT NULL') return { ok: true, fragment: sql`${identCol} IS NOT NULL` };

  if (op === 'IN' || op === 'NOT IN') {
    if (!Array.isArray(f.value) || f.value.length === 0) {
      return { ok: false, error: `${op} 需要非空数组 value` };
    }
    const cleaned: unknown[] = [];
    for (const el of f.value) {
      const r = coerceFilterValue(el, colMeta.kind, colMeta.enumValues);
      if (!r.ok) return r;
      cleaned.push(r.value);
    }
    return {
      ok: true,
      fragment: sql`${identCol} ${sql.raw(OP_TEXT[op])} (${sql.join(
        cleaned.map((v) => sql`${v}`),
        sql.raw(','),
      )})`,
    };
  }

  if (op === 'LIKE' || op === 'NOT LIKE') {
    const pattern = likePattern(String(f.value ?? ''));
    return { ok: true, fragment: sql`${identCol} ${sql.raw(OP_TEXT[op])} ${pattern}` };
  }

  // Comparison ops: =, !=, >, >=, <, <=
  const r = coerceFilterValue(f.value, colMeta.kind, colMeta.enumValues);
  if (!r.ok) return r;
  return { ok: true, fragment: sql`${identCol} ${sql.raw(OP_TEXT[op])} ${r.value}` };
}

function parseQuerySpec(input: unknown): SpecResult {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const table = typeof o.table === 'string' ? o.table : '';
  if (!table || !TABLE_NAMES.has(table)) {
    return specError(`未知表名 '${table || '(空)'}'；可先用 list_queryable_tables 工具了解可查询的表`);
  }

  // ── joins ── build a connected table tree (FROM main → JOIN ...). Each join
  // must anchor on the main table or a previously-joined table (no cartesian
  // products). The relation itself is whitelisted via findJoinRelation — the
  // model can't pair arbitrary tables/columns even if both are individually
  // valid. Single-table mode (no joins) keeps the legacy bare-column rendering.
  const involvedTables = new Set<string>([table]);
  const joins: JoinClause[] = [];
  if (Array.isArray(o.joins)) {
    for (const jRaw of o.joins) {
      const j = jRaw && typeof jRaw === 'object' ? (jRaw as Record<string, unknown>) : {};
      const joinTable = typeof j.table === 'string' ? j.table : '';
      if (!joinTable || !TABLE_NAMES.has(joinTable)) {
        return specError(`JOIN 表名 '${joinTable || '(空)'}' 不在白名单`);
      }
      if (involvedTables.has(joinTable)) {
        return specError(`表 '${joinTable}' 已在查询中；不支持重复/自连接（self-join 需表别名，未支持）`);
      }
      const from = typeof j.from === 'string' && j.from ? j.from : table;
      if (!involvedTables.has(from)) {
        return specError(`JOIN 的 from 表 '${from}' 不在已涉及的表中（必须是主表或之前 JOIN 的表，不允许笛卡尔积）`);
      }
      const onRaw = j.on && typeof j.on === 'object' ? (j.on as Record<string, unknown>) : {};
      const leftCol = typeof onRaw.left === 'string' ? onRaw.left : '';
      const rightCol = typeof onRaw.right === 'string' ? onRaw.right : '';
      if (!leftCol || !rightCol) {
        return specError('JOIN 的 on 必须为 { left, right } 列名');
      }
      const fromCols = COLUMN_NAMES_BY_TABLE.get(from)!;
      const joinCols = COLUMN_NAMES_BY_TABLE.get(joinTable)!;
      if (!fromCols.has(leftCol)) {
        return specError(`JOIN ON 列 '${from}.${leftCol}' 不存在`);
      }
      if (!joinCols.has(rightCol)) {
        return specError(`JOIN ON 列 '${joinTable}.${rightCol}' 不存在`);
      }
      if (SENSITIVE_BY_TABLE.get(from)!.has(leftCol) || SENSITIVE_BY_TABLE.get(joinTable)!.has(rightCol)) {
        return specError('JOIN ON 列不能使用敏感字段');
      }
      const rel = findJoinRelation(from, joinTable, leftCol, rightCol);
      if (!rel) {
        return specError(`关联 '${from}.${leftCol}' ↔ '${joinTable}.${rightCol}' 不在白名单内；可用关联见 list_queryable_tables`);
      }
      const type: 'INNER' | 'LEFT' = j.type === 'LEFT' ? 'LEFT' : 'INNER';
      joins.push({
        table: joinTable,
        from,
        leftCol,
        rightCol,
        type,
        polymorphicSide: rel.polymorphicSide,
        typeColumn: rel.relation.polymorphic?.typeColumn,
        typeValue: rel.relation.polymorphic?.typeValue,
      });
      involvedTables.add(joinTable);
    }
  }
  const multiTable = joins.length > 0;

  // ── columns ──
  const selectColumns: SelectColumn[] = [];
  const declaredAliases = new Set<string>();
  const rawColumns = Array.isArray(o.columns) ? o.columns : null;
  if (!rawColumns || rawColumns.length === 0) {
    // Default `*` expansion: every non-sensitive, non-heavy column of the MAIN
    // table only. Join tables are NOT auto-pulled — with joins the model must
    // name what it wants, to avoid silent column explosion.
    for (const c of TABLE_BY_NAME.get(table)!.columns) {
      if (c.sensitive || c.heavy) continue;
      selectColumns.push({ table, column: c.name, outputKey: c.name, kind: c.kind, heavy: false });
    }
    if (selectColumns.length === 0) {
      return specError(`表 '${table}' 没有可默认查询的列（请显式指定 columns）`);
    }
  } else {
    for (const raw of rawColumns) {
      const c = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      const column = typeof c.column === 'string' ? c.column : '';
      if (c.func !== undefined && !isAggFunc(c.func)) {
        return specError(`不支持的聚合函数：${String(c.func)}（允许 SUM/COUNT/AVG/MIN/MAX）`);
      }
      const func = c.func as AggFunc | undefined;
      const alias = typeof c.alias === 'string' ? c.alias : undefined;

      if (func && !alias) {
        return specError('聚合列必须提供 alias（如 {column:"total_tokens",func:"SUM",alias:"tokens"}）');
      }
      if (alias && !ALIAS_RE.test(alias)) {
        return specError(`alias '${alias}' 非法（仅允许字母数字下划线）`);
      }
      if (alias) declaredAliases.add(alias);

      // COUNT(*) special case — no table needed.
      if (column === '*') {
        if (func !== 'COUNT') return specError('column="*" 仅在 func="COUNT" 时允许');
        selectColumns.push({
          table: '',
          column: '*',
          func: 'COUNT',
          alias: alias!,
          outputKey: alias!,
          kind: 'int',
          heavy: false,
        });
        continue;
      }
      // Resolve which table this column lives on. JOIN mode REQUIRES an explicit
      // table prefix on every non-aggregate column (two tables may share a
      // column name like `id`); single-table mode defaults to the main table.
      const colTable =
        typeof c.table === 'string' && c.table ? c.table : multiTable ? '' : table;
      if (!colTable) {
        return specError('JOIN 查询必须为每个列指定所属表 { table, column }；可用 list_queryable_tables 查看');
      }
      if (!involvedTables.has(colTable)) {
        return specError(`列的表 '${colTable}' 不在本次查询涉及的表中`);
      }
      const colNames = COLUMN_NAMES_BY_TABLE.get(colTable)!;
      const sensitive = SENSITIVE_BY_TABLE.get(colTable)!;
      if (!column || !colNames.has(column)) {
        return specError(`未知列名 '${column || '(空)'}'（表 ${colTable}）`);
      }
      if (sensitive.has(column)) {
        return specError(`列 '${colTable}.${column}' 是敏感字段，不允许查询`);
      }
      const meta = COLUMN_META_BY_TABLE.get(colTable)!.get(column)!;
      // outputKey disambiguation: alias wins; else JOIN mode prefixes table to
      // avoid same-named columns colliding in the result row; single-table mode
      // keeps the bare column name (backward compat).
      const outputKey = alias ?? (multiTable ? `${colTable}_${column}` : column);
      selectColumns.push({
        table: colTable,
        column,
        func,
        alias,
        outputKey,
        kind: func ? (func === 'COUNT' ? 'int' : 'decimal') : meta.kind,
        heavy: !!meta.heavy,
      });
    }
  }

  // ── filters ──
  const filterFrags: SQL[] = [];
  if (Array.isArray(o.filters)) {
    for (const fr of o.filters) {
      if (!fr || typeof fr !== 'object') return specError('filters 元素必须是对象');
      const r = buildFilterFragment(fr as Record<string, unknown>, table, involvedTables, multiTable);
      if (!r.ok) return specError(r.error);
      filterFrags.push(r.fragment);
    }
  }

  // ── groupBy ── (bare strings stay valid for single-table compat; JOIN mode
  // requires { table, column } so two tables' same-named columns don't collide)
  const groupByItems: { table: string; column: string }[] = [];
  if (Array.isArray(o.groupBy)) {
    for (const g of o.groupBy) {
      let gTable: string | undefined;
      let gCol = '';
      if (typeof g === 'string') {
        gCol = g;
      } else if (g && typeof g === 'object') {
        const go = g as Record<string, unknown>;
        gCol = typeof go.column === 'string' ? go.column : '';
        gTable = typeof go.table === 'string' && go.table ? go.table : undefined;
      } else {
        return specError('groupBy 元素必须是列名字符串或 { table, column }');
      }
      const resolved = gTable ?? (multiTable ? '' : table);
      if (!resolved) {
        return specError('JOIN 查询的 groupBy 必须为每项指定 { table, column }');
      }
      if (!involvedTables.has(resolved)) {
        return specError(`groupBy 的表 '${resolved}' 不在本次查询涉及的表中`);
      }
      const colNames = COLUMN_NAMES_BY_TABLE.get(resolved)!;
      const sensitive = SENSITIVE_BY_TABLE.get(resolved)!;
      if (!gCol || !colNames.has(gCol)) {
        return specError(`groupBy 未知列名 '${gCol || '(空)'}'`);
      }
      if (sensitive.has(gCol)) return specError(`groupBy 列 '${resolved}.${gCol}' 是敏感字段`);
      groupByItems.push({ table: resolved, column: gCol });
    }
  }

  // ── orderBy ── (qualify real columns under JOIN; alias or bare single-table
  // column otherwise). Allowed targets: a qualified real column on an involved
  // table, a declared aggregate alias, or (single-table only) a bare real column.
  let orderBy: SQL | undefined;
  if (o.orderBy && typeof o.orderBy === 'object') {
    const ob = o.orderBy as Record<string, unknown>;
    const obCol = typeof ob.column === 'string' ? ob.column : '';
    const obTable = typeof ob.table === 'string' && ob.table ? ob.table : undefined;
    let obIdent: SqlFragment;
    if (obTable) {
      if (!involvedTables.has(obTable)) {
        return specError(`orderBy 的表 '${obTable}' 不在本次查询涉及的表中`);
      }
      if (!obCol || !COLUMN_NAMES_BY_TABLE.get(obTable)!.has(obCol)) {
        return specError(`orderBy 未知列名 '${obCol || '(空)'}'（表 ${obTable}）`);
      }
      if (SENSITIVE_BY_TABLE.get(obTable)!.has(obCol)) {
        return specError(`orderBy 列 '${obTable}.${obCol}' 是敏感字段`);
      }
      obIdent = ident(obTable, obCol);
    } else if (obCol && declaredAliases.has(obCol)) {
      obIdent = sql.identifier(obCol);
    } else if (!multiTable && obCol && COLUMN_NAMES_BY_TABLE.get(table)!.has(obCol)) {
      obIdent = sql.identifier(obCol);
    } else {
      return specError(`orderBy 列 '${obCol || '(空)'}' 必须是 { table, column } 或已声明的聚合 alias`);
    }
    const desc = ob.desc === true || ob.desc === 1 || ob.desc === 'true';
    orderBy = sql`ORDER BY ${obIdent} ${desc ? sql.raw('DESC') : sql.raw('ASC')}`;
  }

  // ── limit ──
  const limit = Math.min(Math.max(cleanInt(o.limit) ?? QUERY_DEFAULT_LIMIT, 1), QUERY_MAX_LIMIT);

  return {
    ok: true,
    spec: {
      table,
      joins,
      involvedTables,
      selectColumns,
      where: filterFrags.length
        ? sql`WHERE ${sql.join(filterFrags, sql.raw(' AND '))}`
        : undefined,
      groupBy: groupByItems.length
        ? sql`GROUP BY ${sql.join(
            groupByItems.map((g) => colIdent(g.table, g.column, multiTable)),
            sql.raw(','),
          )}`
        : undefined,
      orderBy,
      limit,
    },
  };
}

function buildJoinClause(j: JoinClause): SQL {
  const typeText = j.type === 'LEFT' ? 'LEFT JOIN' : 'INNER JOIN';
  const onLeft = ident(j.from, j.leftCol);
  const onRight = ident(j.table, j.rightCol);
  if (j.polymorphicSide && j.typeColumn && j.typeValue) {
    // Polymorphic join (rate_limits / ua_policies): the target_type discriminator
    // lives on the polymorphic side (whichever of from/to that is). typeValue
    // originates from the whitelist constant, but is still parameter-bound
    // (never raw) as defense in depth.
    const polyTable = j.polymorphicSide === 'from' ? j.from : j.table;
    const typeCond = sql`${ident(polyTable, j.typeColumn)} = ${j.typeValue}`;
    return sql`${sql.raw(typeText)} ${ident(j.table)} ON ${typeCond} AND ${onLeft} = ${onRight}`;
  }
  return sql`${sql.raw(typeText)} ${ident(j.table)} ON ${onLeft} = ${onRight}`;
}

function buildQuerySql(spec: QuerySpec): SQL {
  const multiTable = spec.joins.length > 0;
  const selectParts = spec.selectColumns.map((c) => {
    if (c.func) {
      const inner = c.column === '*' ? sql.raw('*') : colIdent(c.table, c.column, multiTable);
      const expr = sql`${sql.raw(c.func)}(${inner})`;
      return c.alias ? sql`${expr} AS ${sql.identifier(c.alias)}` : expr;
    }
    const colSql = colIdent(c.table, c.column, multiTable);
    return c.alias ? sql`${colSql} AS ${sql.identifier(c.alias)}` : colSql;
  });
  const selectList = sql.join(selectParts, sql.raw(','));
  const joinParts = spec.joins.map(buildJoinClause);
  const joinsSql = joinParts.length ? sql.join(joinParts, sql.raw(' ')) : sql.empty();
  return sql`SELECT ${selectList} FROM ${ident(spec.table)} ${joinsSql} ${spec.where ?? sql.empty()} ${spec.groupBy ?? sql.empty()} ${spec.orderBy ?? sql.empty()} LIMIT ${spec.limit}`;
}

function stringifyVal(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

function coerceScalar(raw: unknown, kind: ColKind): unknown {
  if (raw == null) return null;
  switch (kind) {
    case 'int':
    case 'bigint':
    case 'decimal':
      return Number(raw);
    case 'datetime':
      return new Date(String(raw));
    case 'bool':
      return raw === true || raw === 1 || raw === '1' || raw === 'true';
    case 'json':
      if (typeof raw === 'string') {
        try {
          return JSON.parse(raw);
        } catch {
          return raw;
        }
      }
      return raw;
    default:
      return raw; // string/text/enum
  }
}

function coerceRows(
  rawRows: unknown[],
  spec: QuerySpec,
): { rows: Record<string, unknown>[]; truncated: boolean } {
  let heavyTruncated = false;
  const full: Record<string, unknown>[] = (rawRows as unknown[]).map((row) => {
    const r = row as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const c of spec.selectColumns) {
      const raw = r[c.outputKey];
      if (c.heavy) {
        const s = stringifyVal(raw);
        if (s.length > HEAVY_MAX_CHARS) {
          out[c.outputKey] = s.slice(0, HEAVY_MAX_CHARS) + '…[已截断]';
          heavyTruncated = true;
        } else {
          out[c.outputKey] = raw;
        }
      } else {
        out[c.outputKey] = coerceScalar(raw, c.kind);
      }
    }
    return out;
  });

  let rows = full;
  let bytesTruncated = false;
  if (JSON.stringify(full).length > MAX_RESULT_BYTES) {
    rows = full.slice();
    while (rows.length > 1 && JSON.stringify(rows).length > MAX_RESULT_BYTES) {
      rows.pop();
      bytesTruncated = true;
    }
  }
  return { rows, truncated: heavyTruncated || bytesTruncated };
}

export function buildAnalysisTools() {
  const getUsageOverviewTool = tool({
    name: 'get_usage_overview',
    description:
      '获取一段时间的用量总览：token 总量、prompt/completion/cache 各项 token、请求数、错误数。' +
      '用于回答"总共用了多少 token""多少请求""错误率多少"等汇总类问题。' +
      '时间范围与维度（用户/应用/密钥）均可选，不传则统计全部。所有金额/token 单位均为累计绝对值。',
    parameters: toJsonSchema(z.object(filterShape)),
    strict: false,
    execute: async (input) => {
      try {
        const overview = await getUsageOverview(parseFilters(input));
        return { overview };
      } catch (e) {
        return { error: describeError(e) };
      }
    },
  });

  const getUsageTrendsTool = tool({
    name: 'get_usage_trends',
    description:
      '获取用量的时间序列趋势，按粒度分桶返回每个时间段的 token / 请求数 / 错误数。' +
      '用于回答"最近 7 天的 token 消耗趋势""每小时请求量变化"等时序类问题，或为绘制趋势曲线取数。' +
      '粒度建议：≤2 天用 hour（最多约 48 桶）、≤3 个月用 day、更长用 week 或 month。' +
      '时间桶按北京时区（UTC+8）切边，返回的 timeBucket 是北京壁钟字符串。',
    parameters: toJsonSchema(
      z.object({
        ...filterShape,
        granularity: z
          .enum(GRANULARITIES)
          .optional()
          .describe('分桶粒度，默认 day'),
      }),
    ),
    strict: false,
    execute: async (input) => {
      try {
        const rows = await getUsageTrends({
          ...parseFilters(input),
          granularity: cleanGranularity(fieldOf(input, 'granularity')),
        });
        // Cap rows so a runaway hour-bucket over a wide range doesn't blow up
        // the context window; signal truncation so the model can refine.
        const MAX_ROWS = 500;
        const truncated = rows.length > MAX_ROWS;
        const data = truncated ? rows.slice(0, MAX_ROWS) : rows;
        return { data, truncated, totalBuckets: rows.length };
      } catch (e) {
        return { error: describeError(e) };
      }
    },
  });

  const getUsageByModelTool = tool({
    name: 'get_usage_by_model',
    description:
      '按模型（虚拟模型 ID）分组统计用量，返回每个模型的 token / 请求 / 错误，并按 token 总量降序排列。' +
      '用于回答"哪个模型消耗 token 最多""各模型的请求分布"等模型维度问题。' +
      '用 limit 控制返回行数（默认 10），想看全部传较大的 limit。',
    parameters: toJsonSchema(
      z.object({
        ...filterShape,
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('最多返回多少个模型，默认 10，按 token 总量降序取前 N'),
      }),
    ),
    strict: false,
    execute: async (input) => {
      try {
        const rows = await getUsageByModel(parseFilters(input));
        const sorted = [...rows].sort((a, b) => Number(b.totalTokens) - Number(a.totalTokens));
        const limit = Math.min(Math.max(cleanInt(fieldOf(input, 'limit')) ?? 10, 1), 100);
        return { models: sorted.slice(0, limit), totalModels: sorted.length };
      } catch (e) {
        return { error: describeError(e) };
      }
    },
  });

  const listDimensionsTool = tool({
    name: 'list_dimensions',
    description:
      '枚举可用于筛选/分组的维度取值：当前网关中出现过的全部模型（虚拟模型 ID）和服务商（provider）名称。' +
      '在用 get_usage_overview/by_model/trends 之前调用，了解有哪些模型/服务商可选；' +
      '也可直接回答"系统里有哪些模型/服务商在用"。无参数。',
    parameters: toJsonSchema(z.object({})),
    strict: false,
    execute: async () => {
      try {
        return await getLogFilterOptions();
      } catch (e) {
        return { error: describeError(e) };
      }
    },
  });

  // ── query_table: controlled parameterized SELECT over operational tables ──
  const queryTableTool = tool({
    name: 'query_table',
    description:
      '对网关运营数据表做受控只读查询（参数化 SQL，自动防注入、强制 LIMIT + 超时）。' +
      '适合 get_usage_overview/trends/by_model 覆盖不到的自定义查询，例如：各服务商错误率、某用户组的配额分布、active 但快过期的 key、按自定义维度聚合等。' +
      '敏感字段（key_secret/api_key_enc/请求头/IP 等）会被拒绝；时间传 ISO 8601 UTC 字符串。' +
      '返回 { rows, truncated, rowCount, sqlPreview }，失败返 { error }。\n\n' +
      buildQueryTableDescription(),
    parameters: toJsonSchema(
      z.object({
        table: z.string().describe('表名（FROM 主表），必须是上方列出的白名单表'),
        joins: z
          .array(
            z.object({
              table: z.string().describe('要 JOIN 的表（白名单）'),
              on: z.object({
                left: z.string().describe('from 表的关联列'),
                right: z.string().describe('join 表的关联列'),
              }),
              from: z
                .string()
                .optional()
                .describe('left 所属表，默认主表；链式 JOIN 时须指明（主表或之前 JOIN 的表）'),
              type: z.enum(['INNER', 'LEFT']).optional().describe('JOIN 类型，默认 INNER'),
            }),
          )
          .optional()
          .describe(
            'JOIN 列表；关联必须是 list_queryable_tables 列出的白名单路径；' +
              '一旦有 joins，每个非聚合列都要指定所属表 { table, column }',
          ),
        columns: z
          .array(
            z.object({
              table: z
                .string()
                .optional()
                .describe('列所属表；JOIN 时必填（COUNT(*) 除外）；单表时可省略'),
              column: z.string().describe('列名；COUNT(*) 时填 "*" 且必须 func=COUNT'),
              func: z
                .enum(['SUM', 'COUNT', 'AVG', 'MIN', 'MAX'])
                .optional()
                .describe('聚合函数；有 func 必须配 alias'),
              alias: z
                .string()
                .optional()
                .describe('聚合别名（字母数字下划线）；聚合时必填'),
            }),
          )
          .optional()
          .describe('要 SELECT 的列；不传则展开为主表所有非敏感非大字段列'),
        filters: z
          .array(
            z.object({
              table: z.string().optional().describe('列所属表；JOIN 时必填'),
              column: z.string(),
              op: z.enum([
                '=', '!=', '>', '>=', '<', '<=',
                'LIKE', 'NOT LIKE', 'IN', 'NOT IN', 'IS NULL', 'IS NOT NULL',
              ]),
              value: z
                .any()
                .optional()
                .describe('IN 需数组；IS NULL/IS NOT NULL 不传；日期传 ISO 8601 UTC'),
            }),
          )
          .optional()
          .describe('WHERE 条件，多个之间为 AND'),
        groupBy: z
          .array(
            z.union([
              z.string(),
              z.object({ table: z.string().optional(), column: z.string() }),
            ]),
          )
          .optional()
          .describe('GROUP BY；单表可传列名字符串数组，JOIN 时传 { table, column }'),
        orderBy: z
          .object({
            table: z.string().optional().describe('列所属表；按真实列排序时 JOIN 下必填'),
            column: z.string(),
            desc: z.boolean().optional(),
          })
          .optional()
          .describe('column 必须是真实列名或已声明的聚合 alias'),
        limit: z.number().int().min(1).max(500).optional().describe('1-500，默认 100'),
      }),
    ),
    strict: false,
    execute: async (input) => {
      try {
        const parsed = parseQuerySpec(input);
        if (!parsed.ok) return { error: parsed.error };
        const querySql = buildQuerySql(parsed.spec);

        const db = getDb();
        // SET SESSION must run on the SAME connection as the SELECT — two
        // independent db.execute calls are NOT guaranteed to share one. db.transaction
        // borrows a single connection for the whole callback (see user-groups.ts:96).
        // MAX_EXECUTION_TIME (ms) only times SELECT and assumes MySQL 5.7.4+.
        const rawRows = await db.transaction(async (tx) => {
          await tx.execute(
            sql`SET SESSION MAX_EXECUTION_TIME = ${sql.raw(String(QUERY_TIMEOUT_MS))}`,
          );
          const [rows] = await tx.execute(querySql);
          // mysql2 returns ResultSetHeader | RowDataPacket[]; coerce through unknown.
          return rows as unknown as unknown[];
        });

        const { rows, truncated } = coerceRows(rawRows, parsed.spec);
        // sqlPreview exposes the generated SQL for debugging/audit. toSQL() is
        // optional on the type surface; read defensively to avoid coupling.
        const sqlPreview =
          String(
            (querySql as { toSQL?: () => { sql?: string } }).toSQL?.()?.sql ?? '',
          ) || '';
        return { rows, truncated, rowCount: rows.length, sqlPreview };
      } catch (e) {
        return { error: describeError(e) };
      }
    },
  });

  const listQueryableTablesTool = tool({
    name: 'list_queryable_tables',
    description:
      '列出 query_table 工具可查询的全部表、各表的列与中文描述、敏感/大字段标记，以及常用关联路径。' +
      '在用 query_table 前调用以了解表结构；无参数，不查数据库。',
    parameters: toJsonSchema(z.object({})),
    strict: false,
    execute: async () => {
      try {
        return {
          tables: QUERYABLE_TABLES.map((t) => ({
            name: t.name,
            desc: t.desc,
            columns: t.columns.map((c) => ({
              name: c.name,
              kind: c.kind,
              desc: c.desc,
              sensitive: !!c.sensitive,
              heavy: !!c.heavy,
              ...(c.enumValues ? { enumValues: c.enumValues } : {}),
            })),
          })),
          // No DB-level foreign keys in this project — list the conventional
          // join paths (single source of truth: JOIN_RELATIONS) so the model
          // can stitch tables without guessing. These are exactly the relations
          // query_table's `joins` whitelist accepts.
          joinPaths: describeJoinPaths(),
        };
      } catch (e) {
        return { error: describeError(e) };
      }
    },
  });

  return [
    getUsageOverviewTool,
    getUsageTrendsTool,
    getUsageByModelTool,
    listDimensionsTool,
    queryTableTool,
    listQueryableTablesTool,
  ];
}
