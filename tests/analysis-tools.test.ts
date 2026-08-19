import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MySqlDialect } from 'drizzle-orm/mysql-core';

// Mock the four repository functions the tools wrap. Tools must translate the
// model's input (ISO date strings, ids) into repo calls and return {overview}/
// {data}/... on success or {error} on failure (never throw — a single broken
// query must degrade the answer, not abort the whole run).
//
// vi.hoisted is required because vi.mock factories are hoisted above every
// top-level statement — a plain `const x = vi.fn()` referenced inside the
// factory would be accessed before initialization. hoisted() runs at the same
// phase as the mock, so the fns exist when the factory executes.
const mocks = vi.hoisted(() => ({
  getUsageOverview: vi.fn(),
  getUsageByModel: vi.fn(),
  getUsageTrends: vi.fn(),
  getLogFilterOptions: vi.fn(),
  dbTransaction: vi.fn(),
}));

vi.mock('../src/db/repositories/usage.js', () => ({
  getUsageOverview: mocks.getUsageOverview,
  getUsageByModel: mocks.getUsageByModel,
  getUsageTrends: mocks.getUsageTrends,
}));
// Keep the real formatUtcDateTime (query_table's datetime filter uses it) while
// stubbing only getLogFilterOptions — spread importOriginal.
vi.mock('../src/db/repositories/logs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db/repositories/logs.js')>();
  return { ...actual, getLogFilterOptions: mocks.getLogFilterOptions };
});
vi.mock('../src/db/index.js', () => ({
  getDb: () => ({ transaction: mocks.dbTransaction }),
}));

import { buildAnalysisTools } from '../src/agents/analysis-tools.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// The SDK's tool() wrapper exposes `.invoke(runContext, input, details?)` — NOT
// `.execute`. The user's execute fn is closed over inside invoke, and the
// second positional arg is a JSON STRING (mimicking the model's `arguments`),
// which invoke parses then hands to execute. So to drive a tool we call
// `t.invoke({}, JSON.stringify(args))`; the return value is execute's raw
// result object (not re-stringified). runContext can be an empty object — the
// analysis tools never read it.
type InvokeFn = (ctx: unknown, input: string) => Promise<unknown>;

function toolsByName(): Record<string, { name: string; invoke: InvokeFn }> {
  const out: Record<string, { name: string; invoke: InvokeFn }> = {};
  for (const t of buildAnalysisTools()) {
    const tool = t as unknown as { name: string; invoke: InvokeFn };
    out[tool.name] = tool;
  }
  return out;
}

// Call a tool with a plain args object: stringify it and pass an empty
// runContext. This mirrors how the SDK Runner invokes tools in a real run.
async function callTool(t: { invoke: InvokeFn }, args: Record<string, unknown>): Promise<unknown> {
  return t.invoke({}, JSON.stringify(args));
}

// Configure the mocked db.transaction so the first tx.execute (SET SESSION
// MAX_EXECUTION_TIME) returns an ok packet and the second (the SELECT) returns
// `selectRows`. Returns the tx.execute mock so a test can assert on the SQL of
// each call: mock.calls[0] = SET, [1] = SELECT.
function setupDbTx(selectRows: unknown[] = []): ReturnType<typeof vi.fn> {
  const txExecute = vi.fn();
  txExecute.mockResolvedValueOnce({ affectedRows: 0 }); // SET SESSION
  txExecute.mockResolvedValueOnce([selectRows]); // SELECT → [rows, fields]
  txExecute.mockResolvedValue({ affectedRows: 0 }); // any further calls
  mocks.dbTransaction.mockImplementation(
    async (cb: (tx: { execute: typeof txExecute }) => Promise<unknown>) =>
      cb({ execute: txExecute }),
  );
  return txExecute;
}

// Render the drizzle SQL object a tool passed to tx.execute into its real SQL
// text. MySqlDialect.sqlToQuery is the same serialization path the live mysql2
// driver uses, so identifiers get backticks, bound values become ?, and
// sql.raw() interpolates — letting us assert on keywords (SUM / LIMIT 500 /
// IS NULL / MAX_EXECUTION_TIME / etc.) exactly.
const MYSQL_DIALECT = new MySqlDialect();
function sqlQuery(sqlObj: unknown): { sql: string; params: unknown[] } {
  try {
    const q = MYSQL_DIALECT.sqlToQuery(sqlObj as never);
    return { sql: q.sql ?? '', params: q.params ?? [] };
  } catch {
    return { sql: '', params: [] };
  }
}
function sqlText(sqlObj: unknown): string {
  return sqlQuery(sqlObj).sql;
}

describe('get_usage_overview', () => {
  it('passes parsed date range + scope ids to the repo and wraps the result', async () => {
    mocks.getUsageOverview.mockResolvedValue({ totalTokens: 1000, requestCount: 10, errorCount: 1 });
    const t = toolsByName()['get_usage_overview'];

    const res = await callTool(t, {
      startDate: '2025-01-01T00:00:00Z',
      endDate: '2025-02-01T00:00:00Z',
      userId: 7,
      appId: 3,
      apiKeyId: 12,
    });

    expect(mocks.getUsageOverview).toHaveBeenCalledWith({
      startDate: new Date('2025-01-01T00:00:00Z'),
      endDate: new Date('2025-02-01T00:00:00Z'),
      userId: 7,
      appId: 3,
      apiKeyId: 12,
    });
    expect(res).toEqual({ overview: { totalTokens: 1000, requestCount: 10, errorCount: 1 } });
  });

  it('returns {error} instead of throwing when the repo fails', async () => {
    mocks.getUsageOverview.mockRejectedValue(new Error('boom'));
    const t = toolsByName()['get_usage_overview'];

    const res = await callTool(t, {});
    expect(res).toEqual({ error: 'boom' });
  });

  it('cleans stringy/sentinel values from sloppy providers (regression for the InvalidToolInputError loop)', async () => {
    // DashScope/qwen send numbers as strings ("7") and fill unused ID fields
    // with "" / "None". Under the old strict-zod schema the SDK's invoke()
    // validated args BEFORE execute() and rejected these with
    // InvalidToolInputError, which it surfaced back to the model — the model
    // retried with the same stringy args and the run looped to
    // MaxTurnsExceeded. strict:false skips validation; execute() must clean
    // the raw input itself (cleanInt drops ""/"None", coerces "7"→7).
    mocks.getUsageOverview.mockResolvedValue({ totalTokens: 1 });
    const t = toolsByName()['get_usage_overview'];

    await callTool(t, {
      startDate: '2025-01-01T00:00:00Z',
      endDate: '2025-02-01T00:00:00Z',
      userId: '7', // string number → 7
      appId: '', // empty → dropped
      apiKeyId: 'None', // sentinel → dropped
    });

    expect(mocks.getUsageOverview).toHaveBeenCalledWith({
      startDate: new Date('2025-01-01T00:00:00Z'),
      endDate: new Date('2025-02-01T00:00:00Z'),
      userId: 7,
      // appId / apiKeyId absent (undefined), NOT forwarded as "" / "None"
    });
  });
});

describe('get_usage_trends', () => {
  it('forwards granularity and caps rows at MAX_ROWS, signalling truncation', async () => {
    // 501 buckets → data truncated to 500, truncated=true, totalBuckets=501
    const buckets = Array.from({ length: 501 }, (_, i) => ({ timeBucket: `b${i}`, totalTokens: i }));
    mocks.getUsageTrends.mockResolvedValue(buckets);
    const t = toolsByName()['get_usage_trends'];

    const res = (await callTool(t, { granularity: 'hour' })) as {
      data: unknown[];
      truncated: boolean;
      totalBuckets: number;
    };

    expect(mocks.getUsageTrends).toHaveBeenCalledWith(
      expect.objectContaining({ granularity: 'hour' }),
    );
    expect(res.truncated).toBe(true);
    expect(res.totalBuckets).toBe(501);
    expect(res.data).toHaveLength(500);
  });

  it('does not mark truncation when rows fit', async () => {
    mocks.getUsageTrends.mockResolvedValue([{ timeBucket: 'b0', totalTokens: 1 }]);
    const t = toolsByName()['get_usage_trends'];
    const res = (await callTool(t, {})) as { truncated: boolean; data: unknown[] };
    expect(res.truncated).toBe(false);
    expect(res.data).toHaveLength(1);
  });
});

describe('get_usage_by_model', () => {
  it('sorts by totalTokens descending (numeric, DECIMAL-safe) and applies limit', async () => {
    // totalTokens may arrive as DECIMAL string from mysql2 — the tool uses
    // Number() before comparing, so order must be numeric not lexical.
    mocks.getUsageByModel.mockResolvedValue([
      { model: 'a', totalTokens: '50' },
      { model: 'b', totalTokens: '100' },
      { model: 'c', totalTokens: '200' },
    ]);
    const t = toolsByName()['get_usage_by_model'];

    const res = (await callTool(t, { limit: 2 })) as { models: { model: string }[]; totalModels: number };
    expect(res.totalModels).toBe(3);
    expect(res.models.map((m) => m.model)).toEqual(['c', 'b']); // 200, 100 → top 2
  });

  it('defaults limit to 10', async () => {
    mocks.getUsageByModel.mockResolvedValue([{ model: 'a', totalTokens: 1 }]);
    const t = toolsByName()['get_usage_by_model'];
    await callTool(t, {});
    // No assertion on result shape beyond not throwing; default path coverage.
    expect(mocks.getUsageByModel).toHaveBeenCalled();
  });

  it('cleans a stringy limit and clamps to [1,100]', async () => {
    // Same sloppy-provider fix as the overview test: limit arrives as "3".
    mocks.getUsageByModel.mockResolvedValue([
      { model: 'a', totalTokens: 3 },
      { model: 'b', totalTokens: 2 },
      { model: 'c', totalTokens: 1 },
    ]);
    const t = toolsByName()['get_usage_by_model'];
    const res = (await callTool(t, { limit: '3' })) as { models: { model: string }[] };
    expect(res.models.map((m) => m.model)).toEqual(['a', 'b', 'c']); // "3" → 3, all 3 kept
  });
});

describe('list_dimensions', () => {
  it('calls getLogFilterOptions with no arguments and returns it verbatim', async () => {
    mocks.getLogFilterOptions.mockResolvedValue({ models: ['gpt-4o'], providers: ['openai'] });
    const t = toolsByName()['list_dimensions'];

    const res = await callTool(t, {});
    expect(mocks.getLogFilterOptions).toHaveBeenCalledWith();
    expect(res).toEqual({ models: ['gpt-4o'], providers: ['openai'] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// query_table — controlled parameterized SELECT. The whitelist IS the
// SQL-injection boundary (sql.identifier does NOT escape backticks), so these
// tests pin every rejection path + the rendered SQL shape + deterministic
// coercion. See plan calm-purring-bachman.md.
// ─────────────────────────────────────────────────────────────────────────────
describe('query_table', () => {
  // ── 1. table whitelist ──
  it('rejects unknown table names without touching the DB', async () => {
    const t = toolsByName()['query_table'];
    for (const table of ['admin_users', 'usage_records; DROP TABLE x', 'nope', '']) {
      const res = await callTool(t, { table });
      expect(res).toEqual({ error: expect.stringMatching(/未知表名/) });
    }
    expect(mocks.dbTransaction).not.toHaveBeenCalled();
  });

  // ── 2. sensitive columns ──
  it('default * expansion omits sensitive AND heavy columns', async () => {
    const txExecute = setupDbTx([]);
    const t = toolsByName()['query_table'];
    await callTool(t, { table: 'api_keys' });
    const selectSql = sqlText(txExecute.mock.calls[1][0]);
    expect(selectSql).not.toContain('key_secret');
    expect(selectSql).not.toContain('upstream_api_key_enc');

    // request_details: both sensitive (headers/client_ip) and heavy (bodies) drop out
    const tx2 = setupDbTx([]);
    await callTool(t, { table: 'request_details' });
    const selectSql2 = sqlText(tx2.mock.calls[1][0]);
    for (const bad of ['request_headers', 'response_headers', 'client_ip', 'request_body', 'response_body', 'stream_chunks']) {
      expect(selectSql2).not.toContain(bad);
    }
  });

  it('rejects explicitly selecting a sensitive column', async () => {
    const t = toolsByName()['query_table'];
    const res = await callTool(t, {
      table: 'api_keys',
      columns: [{ column: 'key_secret' }],
    });
    expect(res).toEqual({ error: expect.stringMatching(/敏感字段.*不允许查询/) });
    expect(mocks.dbTransaction).not.toHaveBeenCalled();
  });

  it('rejects filtering on a sensitive column (no bypass via WHERE)', async () => {
    const t = toolsByName()['query_table'];
    const res = await callTool(t, {
      table: 'providers',
      columns: [{ column: 'id' }],
      filters: [{ column: 'api_key_enc', op: '=', value: 'x' }],
    });
    expect(res).toEqual({ error: expect.stringMatching(/敏感字段.*筛选/) });
    expect(mocks.dbTransaction).not.toHaveBeenCalled();
  });

  // ── 3. aggregates + alias ──
  it('renders SUM() AS alias + GROUP BY + ORDER BY DESC + LIMIT in the SQL', async () => {
    const txExecute = setupDbTx([]);
    const t = toolsByName()['query_table'];
    await callTool(t, {
      table: 'usage_records',
      columns: [{ column: 'model' }, { column: 'total_tokens', func: 'SUM', alias: 'tokens' }],
      groupBy: ['model'],
      orderBy: { column: 'tokens', desc: true },
      limit: 20,
    });
    const selectSql = sqlText(txExecute.mock.calls[1][0]);
    expect(selectSql).toContain('SUM');
    expect(selectSql).toContain('AS');
    expect(selectSql).toContain('GROUP BY');
    expect(selectSql).toContain('ORDER BY');
    expect(selectSql).toContain('DESC');
    // LIMIT value is parameter-bound (LIMIT ?), so assert on params, not text.
    expect(sqlQuery(txExecute.mock.calls[1][0]).params).toContain(20);
  });

  it('rejects an invalid aggregate function', async () => {
    const t = toolsByName()['query_table'];
    const res = await callTool(t, {
      table: 'usage_records',
      columns: [{ column: 'total_tokens', func: 'CUSTOM', alias: 'c' }],
    });
    expect(res).toEqual({ error: expect.stringMatching(/聚合函数/) });
  });

  it('rejects an aggregate column missing an alias', async () => {
    const t = toolsByName()['query_table'];
    const res = await callTool(t, {
      table: 'usage_records',
      columns: [{ column: 'total_tokens', func: 'SUM' }],
    });
    expect(res).toEqual({ error: expect.stringMatching(/alias/) });
  });

  it('rejects an alias containing punctuation (injection guard)', async () => {
    const t = toolsByName()['query_table'];
    for (const alias of ['a;b', 'a`b', 'a.b', '1abc', 'a-b']) {
      const res = await callTool(t, {
        table: 'usage_records',
        columns: [{ column: 'total_tokens', func: 'SUM', alias }],
      });
      expect(res).toEqual({ error: expect.stringMatching(/alias.*非法/) });
    }
  });

  it('COUNT(*) requires func=COUNT (rejects bare *)', async () => {
    const t = toolsByName()['query_table'];
    const bare = await callTool(t, { table: 'apps', columns: [{ column: '*' }] });
    expect(bare).toEqual({ error: expect.stringMatching(/func="COUNT"/) });
    setupDbTx([]); // COUNT(*) reaches the DB (bare-* rejection does not)
    const ok = await callTool(t, { table: 'apps', columns: [{ column: '*', func: 'COUNT', alias: 'n' }] });
    expect(ok).toHaveProperty('rowCount');
  });

  // ── 4. filters ──
  it('binds a comparison filter as a parameter placeholder', async () => {
    const txExecute = setupDbTx([]);
    const t = toolsByName()['query_table'];
    await callTool(t, {
      table: 'usage_records',
      columns: [{ column: 'total_tokens' }],
      filters: [{ column: 'record_time', op: '>=', value: '2026-06-01T00:00:00Z' }],
    });
    const selectSql = sqlText(txExecute.mock.calls[1][0]);
    expect(selectSql).toContain('record_time');
    expect(selectSql).toContain('>=');
    expect(selectSql).toContain('?'); // value is parameter-bound, not interpolated
  });

  it('IS NULL / IS NOT NULL add no value placeholder', async () => {
    const txExecute = setupDbTx([]);
    const t = toolsByName()['query_table'];
    await callTool(t, {
      table: 'request_logs',
      columns: [{ column: 'error_message' }],
      filters: [{ column: 'error_message', op: 'IS NULL' }],
    });
    expect(sqlText(txExecute.mock.calls[1][0])).toContain('IS NULL');
  });

  it('IN renders placeholders per element and rejects a non-array value', async () => {
    const txExecute = setupDbTx([]);
    const t = toolsByName()['query_table'];
    await callTool(t, {
      table: 'usage_records',
      columns: [{ column: 'total_tokens' }],
      filters: [{ column: 'model', op: 'IN', value: ['gpt-4o', 'claude-3'] }],
    });
    expect(sqlText(txExecute.mock.calls[1][0])).toContain('IN');

    const bad = await callTool(t, {
      table: 'usage_records',
      columns: [{ column: 'total_tokens' }],
      filters: [{ column: 'model', op: 'IN', value: 'gpt-4o' }],
    });
    expect(bad).toEqual({ error: expect.stringMatching(/非空数组/) });
  });

  it('rejects an unknown operator', async () => {
    const t = toolsByName()['query_table'];
    const res = await callTool(t, {
      table: 'usage_records',
      columns: [{ column: 'total_tokens' }],
      filters: [{ column: 'model', op: '<>', value: 'x' }],
    });
    expect(res).toEqual({ error: expect.stringMatching(/操作符/) });
  });

  // ── 5. limit clamping ──
  it('clamps limit to [1, 500] and defaults to 100', async () => {
    const t = toolsByName()['query_table'];
    const hi = setupDbTx([]);
    await callTool(t, { table: 'apps', limit: 99999 });
    expect(sqlQuery(hi.mock.calls[1][0]).params).toContain(500); // 99999 → 500

    const def = setupDbTx([]);
    await callTool(t, { table: 'apps' });
    expect(sqlQuery(def.mock.calls[1][0]).params).toContain(100); // default 100
  });

  // ── 6. orderBy alias validation ──
  it('rejects orderBy on a column that is neither real nor a declared alias', async () => {
    const t = toolsByName()['query_table'];
    const res = await callTool(t, {
      table: 'usage_records',
      columns: [{ column: 'total_tokens', func: 'SUM', alias: 'tokens' }],
      orderBy: { column: 'other' },
    });
    expect(res).toEqual({ error: expect.stringMatching(/orderBy/) });
    expect(mocks.dbTransaction).not.toHaveBeenCalled();
  });

  // ── 7. timeout transaction ──
  it('runs SET SESSION MAX_EXECUTION_TIME on the same connection as the SELECT', async () => {
    const txExecute = setupDbTx([]);
    const t = toolsByName()['query_table'];
    await callTool(t, { table: 'apps' });
    expect(mocks.dbTransaction).toHaveBeenCalledTimes(1);
    expect(txExecute).toHaveBeenCalledTimes(2); // SET then SELECT
    expect(sqlText(txExecute.mock.calls[0][0])).toContain('MAX_EXECUTION_TIME');
    expect(sqlText(txExecute.mock.calls[1][0])).toMatch(/^SELECT/);
  });

  // ── 8. deterministic result coercion by declared kind ──
  it('coerces DECIMAL/bigint → number, datetime → Date, string as-is', async () => {
    setupDbTx([
      { id: '1', total_tokens: '12345', record_time: '2026-06-01 00:00:00', model: 'gpt-4o' },
    ]);
    const t = toolsByName()['query_table'];
    const res = (await callTool(t, {
      table: 'usage_records',
      columns: ['id', 'total_tokens', 'record_time', 'model'].map((column) => ({ column })),
      limit: 1,
    })) as { rows: Record<string, unknown>[] };
    const row = res.rows[0];
    expect(row.id).toBe(1); // bigint string → number
    expect(row.total_tokens).toBe(12345); // bigint string → number
    expect(row.record_time).toEqual(new Date('2026-06-01 00:00:00')); // → Date
    expect(row.model).toBe('gpt-4o'); // string passthrough
  });

  // ── 9. heavy column truncation ──
  it('truncates heavy columns past 1000 chars and signals truncated=true', async () => {
    const big = 'x'.repeat(5000);
    setupDbTx([{ request_id: 'abc', request_body: big }]);
    const t = toolsByName()['query_table'];
    const res = (await callTool(t, {
      table: 'request_details',
      columns: [{ column: 'request_id' }, { column: 'request_body' }],
      limit: 1,
    })) as { rows: Record<string, unknown>[]; truncated: boolean };
    expect(String(res.rows[0].request_body).length).toBeLessThanOrEqual(1010); // 1000 + '…[已截断]'
    expect(res.truncated).toBe(true);
  });

  // ── 10. total-byte budget ──
  it('drops rows to keep the serialized result under the 30KB budget', async () => {
    // 600 rows × ~100-char user_agent ≈ 60KB > 30KB → rows get popped.
    const many = Array.from({ length: 600 }, (_, i) => ({
      user_agent: 'a'.repeat(100) + i,
    }));
    setupDbTx(many);
    const t = toolsByName()['query_table'];
    const res = (await callTool(t, {
      table: 'request_details',
      columns: [{ column: 'user_agent' }],
    })) as { rows: unknown[]; truncated: boolean };
    expect(res.rows.length).toBeLessThan(600);
    expect(res.truncated).toBe(true);
  });

  // ── 11. errors never throw ──
  it('returns {error} instead of throwing when the DB transaction fails', async () => {
    mocks.dbTransaction.mockRejectedValueOnce(new Error('connection lost'));
    const t = toolsByName()['query_table'];
    const res = await callTool(t, { table: 'apps' });
    expect(res).toEqual({ error: 'connection lost' });
  });

  // ── 12. strict:false sloppy-input regression ──
  it('tolerates stringy / null / sentinel inputs from sloppy providers', async () => {
    const t = toolsByName()['query_table'];
    // limit:'' → default 100; columns:null → default expansion; no throw.
    const tx = setupDbTx([]);
    await callTool(t, { table: 'apps', limit: '', columns: null });
    expect(sqlQuery(tx.mock.calls[1][0]).params).toContain(100); // '' → default

    // stringy limit '50' → 50
    const tx2 = setupDbTx([]);
    await callTool(t, { table: 'apps', limit: '50' });
    expect(sqlQuery(tx2.mock.calls[1][0]).params).toContain(50); // '50' → 50
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// query_table — JOIN support (INNER/LEFT, whitelisted relations only). The
// relation whitelist IS the boundary: even two individually-valid tables/columns
// can't be paired unless JOIN_RELATIONS declares the edge. Polymorphic
// rate_limits rows pin target_type on the rate_limits side with the typeValue
// parameter-bound (never raw). Single-table calls (no joins) keep the legacy
// bare-column rendering — covered by every test above.
// ─────────────────────────────────────────────────────────────────────────────
describe('query_table — JOIN', () => {
  // ── 1. basic 2-table INNER JOIN ──
  it('renders a 2-table INNER JOIN with qualified ON + SELECT columns', async () => {
    const txExecute = setupDbTx([]);
    const t = toolsByName()['query_table'];
    await callTool(t, {
      table: 'request_logs',
      joins: [{ table: 'api_keys', on: { left: 'api_key_id', right: 'id' } }],
      columns: [
        { table: 'request_logs', column: 'model' },
        { table: 'api_keys', column: 'name' },
      ],
      limit: 10,
    });
    const selectSql = sqlText(txExecute.mock.calls[1][0]);
    expect(selectSql).toContain('INNER JOIN');
    expect(selectSql).toContain('`api_keys`');
    expect(selectSql).toContain('`request_logs`.`api_key_id`');
    expect(selectSql).toContain('`api_keys`.`id`');
    // SELECT columns are qualified under JOIN
    expect(selectSql).toContain('`request_logs`.`model`');
    expect(selectSql).toContain('`api_keys`.`name`');
    // LIMIT is parameter-bound
    expect(sqlQuery(txExecute.mock.calls[1][0]).params).toContain(10);
  });

  // ── 2. default INNER, explicit LEFT ──
  it('defaults to INNER when type omitted, renders LEFT when requested', async () => {
    const t = toolsByName()['query_table'];
    const txInner = setupDbTx([]);
    await callTool(t, {
      table: 'request_logs',
      joins: [{ table: 'api_keys', on: { left: 'api_key_id', right: 'id' } }],
      columns: [{ table: 'request_logs', column: 'model' }],
    });
    expect(sqlText(txInner.mock.calls[1][0])).toContain('INNER JOIN');
    expect(sqlText(txInner.mock.calls[1][0])).not.toContain('LEFT JOIN');

    const txLeft = setupDbTx([]);
    await callTool(t, {
      table: 'request_logs',
      joins: [{ table: 'api_keys', on: { left: 'api_key_id', right: 'id' }, type: 'LEFT' }],
      columns: [{ table: 'request_logs', column: 'model' }],
    });
    expect(sqlText(txLeft.mock.calls[1][0])).toContain('LEFT JOIN');
  });

  // ── 3. chained 3-table join ──
  it('chains joins, anchoring each ON on a previously-joined table', async () => {
    const txExecute = setupDbTx([]);
    const t = toolsByName()['query_table'];
    await callTool(t, {
      table: 'request_logs',
      joins: [
        { table: 'api_keys', on: { left: 'api_key_id', right: 'id' } }, // from main
        { table: 'users', from: 'api_keys', on: { left: 'user_id', right: 'id' }, type: 'LEFT' },
      ],
      columns: [
        { table: 'request_logs', column: 'model' },
        { table: 'users', column: 'username' },
      ],
    });
    const selectSql = sqlText(txExecute.mock.calls[1][0]);
    // first join: main → api_keys (INNER)
    expect(selectSql).toContain('INNER JOIN');
    expect(selectSql).toContain('`request_logs`.`api_key_id` = `api_keys`.`id`');
    // second join: api_keys → users (LEFT), ON anchored on api_keys.user_id
    expect(selectSql).toContain('LEFT JOIN');
    expect(selectSql).toContain('`api_keys`.`user_id` = `users`.`id`');
  });

  // ── 4. string-name association (provider name, not id) ──
  it('joins on a string-name association (provider name)', async () => {
    const txExecute = setupDbTx([]);
    const t = toolsByName()['query_table'];
    await callTool(t, {
      table: 'usage_records',
      joins: [{ table: 'providers', on: { left: 'provider', right: 'name' } }],
      columns: [
        { table: 'usage_records', column: 'model' },
        { table: 'providers', column: 'name' },
      ],
    });
    const selectSql = sqlText(txExecute.mock.calls[1][0]);
    expect(selectSql).toContain('`usage_records`.`provider` = `providers`.`name`');
  });

  // ── 5. polymorphic rate_limits → api_keys (forward) ──
  it('pins target_type on rate_limits and binds the typeValue (forward)', async () => {
    const txExecute = setupDbTx([]);
    const t = toolsByName()['query_table'];
    await callTool(t, {
      table: 'rate_limits',
      joins: [{ table: 'api_keys', on: { left: 'target_id', right: 'id' } }],
      columns: [
        { table: 'rate_limits', column: 'id' },
        { table: 'api_keys', column: 'name' },
      ],
    });
    const { sql: selectSql, params } = sqlQuery(txExecute.mock.calls[1][0]);
    expect(selectSql).toContain('`rate_limits`.`target_type` = ?');
    expect(selectSql).toContain('`rate_limits`.`target_id` = `api_keys`.`id`');
    expect(params).toContain('api_key'); // typeValue bound, not raw-interpolated
    expect(selectSql).not.toContain("'api_key'"); // never a raw SQL string literal
  });

  // ── 6. polymorphic reverse: api_keys → rate_limits ──
  it('keeps target_type on rate_limits when joined from the other side', async () => {
    const txExecute = setupDbTx([]);
    const t = toolsByName()['query_table'];
    await callTool(t, {
      table: 'api_keys',
      joins: [{ table: 'rate_limits', on: { left: 'id', right: 'target_id' } }],
      columns: [
        { table: 'api_keys', column: 'name' },
        { table: 'rate_limits', column: 'id' },
      ],
    });
    const { sql: selectSql, params } = sqlQuery(txExecute.mock.calls[1][0]);
    expect(selectSql).toContain('`rate_limits`.`target_type` = ?');
    expect(selectSql).toContain('`api_keys`.`id` = `rate_limits`.`target_id`');
    expect(params).toContain('api_key');
  });

  // ── 7. outputKey disambiguation under JOIN ──
  it('prefixes outputKey as table_column under JOIN when no alias given', async () => {
    setupDbTx([{ users_username: 'alice' }]);
    const t = toolsByName()['query_table'];
    const res = (await callTool(t, {
      table: 'request_logs',
      joins: [{ table: 'users', on: { left: 'user_id', right: 'id' } }],
      columns: [{ table: 'users', column: 'username' }], // no alias → key users_username
      limit: 1,
    })) as { rows: Record<string, unknown>[] };
    expect(res.rows[0]).toHaveProperty('users_username', 'alice');
  });

  // ── rejections (none reach the DB) ──
  it('rejects an ON pair that is not a whitelisted relation', async () => {
    const t = toolsByName()['query_table'];
    const res = await callTool(t, {
      table: 'request_logs',
      joins: [{ table: 'api_keys', on: { left: 'user_id', right: 'id' } }], // user_id→api_keys.id not whitelisted
      columns: [{ table: 'request_logs', column: 'model' }],
    });
    expect(res).toEqual({ error: expect.stringMatching(/不在白名单/) });
    expect(mocks.dbTransaction).not.toHaveBeenCalled();
  });

  it('rejects joining the same table twice (no self-join/aliases)', async () => {
    const t = toolsByName()['query_table'];
    const res = await callTool(t, {
      table: 'request_logs',
      joins: [
        { table: 'api_keys', on: { left: 'api_key_id', right: 'id' } },
        { table: 'api_keys', on: { left: 'app_id', right: 'id' } },
      ],
      columns: [{ table: 'request_logs', column: 'model' }],
    });
    expect(res).toEqual({ error: expect.stringMatching(/已在查询中|重复|自连接/) });
    expect(mocks.dbTransaction).not.toHaveBeenCalled();
  });

  it('rejects a JOIN whose from table is not yet involved (no cartesian product)', async () => {
    const t = toolsByName()['query_table'];
    const res = await callTool(t, {
      table: 'request_logs',
      joins: [{ table: 'users', from: 'api_keys', on: { left: 'user_id', right: 'id' } }],
      columns: [{ table: 'request_logs', column: 'model' }],
    });
    expect(res).toEqual({ error: expect.stringMatching(/不在已涉及|笛卡尔积/) });
    expect(mocks.dbTransaction).not.toHaveBeenCalled();
  });

  it('rejects a JOIN-mode column missing its table prefix', async () => {
    const t = toolsByName()['query_table'];
    const res = await callTool(t, {
      table: 'request_logs',
      joins: [{ table: 'api_keys', on: { left: 'api_key_id', right: 'id' } }],
      columns: [{ column: 'model' }], // no table under JOIN
    });
    expect(res).toEqual({ error: expect.stringMatching(/必须为每个列指定所属表/) });
    expect(mocks.dbTransaction).not.toHaveBeenCalled();
  });

  it('rejects a column whose table is not involved in the query', async () => {
    const t = toolsByName()['query_table'];
    const res = await callTool(t, {
      table: 'request_logs',
      joins: [{ table: 'api_keys', on: { left: 'api_key_id', right: 'id' } }],
      columns: [{ table: 'users', column: 'username' }], // users not joined
    });
    expect(res).toEqual({ error: expect.stringMatching(/不在本次查询涉及/) });
    expect(mocks.dbTransaction).not.toHaveBeenCalled();
  });

  it('rejects selecting a sensitive column through a JOIN', async () => {
    const t = toolsByName()['query_table'];
    const res = await callTool(t, {
      table: 'request_logs',
      joins: [{ table: 'api_keys', on: { left: 'api_key_id', right: 'id' } }],
      columns: [{ table: 'api_keys', column: 'key_secret' }],
    });
    expect(res).toEqual({ error: expect.stringMatching(/敏感字段.*不允许查询/) });
    expect(mocks.dbTransaction).not.toHaveBeenCalled();
  });

  it('rejects a sensitive column used in the ON clause', async () => {
    const t = toolsByName()['query_table'];
    const res = await callTool(t, {
      table: 'request_logs',
      joins: [{ table: 'api_keys', on: { left: 'api_key_id', right: 'key_secret' } }],
      columns: [{ table: 'request_logs', column: 'model' }],
    });
    expect(res).toEqual({ error: expect.stringMatching(/ON.*敏感字段|敏感字段.*ON/) });
    expect(mocks.dbTransaction).not.toHaveBeenCalled();
  });
});

describe('list_queryable_tables', () => {
  it('returns all whitelisted tables with column metadata and no DB call', async () => {
    const t = toolsByName()['list_queryable_tables'];
    const res = (await callTool(t, {})) as {
      tables: { name: string; columns: { name: string; sensitive?: boolean }[] }[];
      joinPaths: string[];
    };
    const names = res.tables.map((x) => x.name);
    expect(names).not.toContain('admin_users'); // whole table excluded
    expect(names).toContain('usage_records');
    expect(names).toContain('api_keys');
    expect(names).toHaveLength(13);

    const apiKeys = res.tables.find((x) => x.name === 'api_keys')!;
    expect(apiKeys.columns.find((c) => c.name === 'key_secret')?.sensitive).toBe(true);

    expect(Array.isArray(res.joinPaths)).toBe(true);
    expect(res.joinPaths.length).toBeGreaterThan(0);
    expect(mocks.dbTransaction).not.toHaveBeenCalled();
  });
});
