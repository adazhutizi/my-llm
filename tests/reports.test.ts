import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock DB ────────────────────────────────────────────────────────────
//
// drizzle's query builder is chainable AND thenable — `await` resolves at any
// point (after .where(), after .limit(), …). The chain mock below mirrors that:
// every method returns the same chain, and the chain itself is thenable, so
// `await db.select(shape).from(t).where(w)` and `await …limit(50)` both resolve
// to finalResult. Unlike usage-repository.test.ts (whose chains end at .offset),
// reports' chains end at .where (overview) or .limit (trends/by-*).
interface FluentChain {
  from: ReturnType<typeof vi.fn>;
  leftJoin: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  groupBy: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  offset: ReturnType<typeof vi.fn>;
  then: (resolve: (v: unknown) => unknown) => unknown;
}

function createFluentMock(finalResult: unknown): FluentChain {
  const chain = {} as FluentChain;
  for (const method of ['from', 'leftJoin', 'where', 'groupBy', 'orderBy', 'limit', 'offset'] as (keyof FluentChain)[]) {
    chain[method] = vi.fn().mockReturnValue(chain) as never;
  }
  // thenable protocol: `await chain` fulfills with finalResult at any link.
  chain.then = ((resolve: (v: unknown) => unknown) => resolve(finalResult)) as never;
  return chain;
}

const mockSelect = vi.fn();
const mockDb = { select: mockSelect };

vi.mock('../src/db/index.js', () => ({
  getDb: () => mockDb,
}));

import {
  getReportOverview,
  getReportTrends,
  getReportByModel,
  getReportByProvider,
  getReportByStatus,
} from '../src/db/repositories/reports.js';
import { adminReports } from '../src/routes/admin/reports.js';

/** Wire one select to return finalResult and hand back the chain for assertions. */
function setupSelect(finalResult: unknown) {
  const chain = createFluentMock(finalResult);
  mockSelect.mockReturnValueOnce(chain);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Repository: overview (KPI, single row) ─────────────────────────────

describe('getReportOverview', () => {
  it('把 DECIMAL 字符串聚合映射为 Number，并计算 errorRate', async () => {
    // mysql2 经 SUM() 返 DECIMAL 字符串；cache_* 在 OpenAI 流量上为 NULL。
    setupSelect([{
      totalRequests: '100',
      totalErrors: '5',
      totalPromptTokens: '1000',
      totalCompletionTokens: '500',
      totalCacheReadTokens: null,
      totalCacheCreationTokens: null,
      totalTokens: '1500',
      avgLatencyMs: '234.5',
    }]);

    const result = await getReportOverview({});

    expect(result).toEqual({
      totalRequests: 100,
      totalErrors: 5,
      errorRate: 0.05, // 5/100
      avgLatencyMs: 234.5,
      totalTokens: 1500,
      totalPromptTokens: 1000,
      totalCompletionTokens: 500,
      totalCacheReadTokens: 0, // NULL → 0（Number(x ?? 0) 兜底）
      totalCacheCreationTokens: 0,
    });
  });

  it('totalRequests=0 时 errorRate=0，不除零；全 NULL 聚合归 0', async () => {
    setupSelect([{
      totalRequests: '0',
      totalErrors: '0',
      totalPromptTokens: null,
      totalCompletionTokens: null,
      totalCacheReadTokens: null,
      totalCacheCreationTokens: null,
      totalTokens: null,
      avgLatencyMs: null,
    }]);

    const result = await getReportOverview({});

    expect(result.errorRate).toBe(0);
    expect(result.totalRequests).toBe(0);
    expect(result.totalTokens).toBe(0);
    expect(result.avgLatencyMs).toBe(0);
  });

  it('无 details 过滤时不 LEFT JOIN request_details', async () => {
    const chain = setupSelect([{ totalRequests: '0', totalErrors: '0', totalPromptTokens: null, totalCompletionTokens: null, totalCacheReadTokens: null, totalCacheCreationTokens: null, totalTokens: null, avgLatencyMs: null }]);

    await getReportOverview({ model: 'gpt-4' });

    // model 过滤在 request_logs 上，不需要 details → 不该 JOIN 重表。
    expect(chain.from).toHaveBeenCalled();
    expect(chain.leftJoin).not.toHaveBeenCalled();
  });

  it('含 hideArchived 时 LEFT JOIN request_details（logFilterNeedsDetails 分支）', async () => {
    const chain = setupSelect([{ totalRequests: '0', totalErrors: '0', totalPromptTokens: null, totalCompletionTokens: null, totalCacheReadTokens: null, totalCacheCreationTokens: null, totalTokens: null, avgLatencyMs: null }]);

    await getReportOverview({ hideArchived: true });

    expect(chain.leftJoin).toHaveBeenCalledTimes(1);
  });
});

// ── Repository: by-status ──────────────────────────────────────────────

describe('getReportByStatus', () => {
  it('statusClass NULL 保留为 null（→ 前端「未知」），数值映射、LIMIT 50', async () => {
    const chain = setupSelect([
      { statusClass: '200', totalRequests: '80', totalTokens: '8000' },
      { statusClass: '500', totalRequests: '4', totalTokens: '0' },
      { statusClass: null, totalRequests: '3', totalTokens: '0' },
    ]);

    const result = await getReportByStatus({});

    expect(result).toEqual([
      { statusClass: 200, totalRequests: 80, totalTokens: 8000 },
      { statusClass: 500, totalRequests: 4, totalTokens: 0 },
      { statusClass: null, totalRequests: 3, totalTokens: 0 },
    ]);
    expect(chain.limit).toHaveBeenCalledWith(50);
  });
});

// ── Repository: by-model / by-provider ─────────────────────────────────

describe('getReportByModel', () => {
  it('key 取 model，cache_* NULL 归 0，按 totalTokens 排序 LIMIT 50', async () => {
    const chain = setupSelect([{
      key: 'gpt-4',
      totalRequests: '10',
      totalErrors: '1',
      totalTokens: '100',
      totalPromptTokens: '60',
      totalCompletionTokens: '40',
      totalCacheReadTokens: null,
      totalCacheCreationTokens: null,
    }]);

    const result = await getReportByModel({});

    expect(result).toEqual([{
      key: 'gpt-4',
      totalRequests: 10,
      totalErrors: 1,
      totalTokens: 100,
      totalPromptTokens: 60,
      totalCompletionTokens: 40,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    }]);
    expect(chain.groupBy).toHaveBeenCalled();
    expect(chain.orderBy).toHaveBeenCalled();
    expect(chain.limit).toHaveBeenCalledWith(50);
  });

  it('key 为 NULL 时保留 null（→ 前端「未知」组）', async () => {
    setupSelect([{ key: null, totalRequests: '2', totalErrors: '0', totalTokens: '0', totalPromptTokens: null, totalCompletionTokens: null, totalCacheReadTokens: null, totalCacheCreationTokens: null }]);

    const result = await getReportByModel({});

    expect(result[0].key).toBeNull();
  });
});

describe('getReportByProvider', () => {
  it('key 取 provider', async () => {
    setupSelect([{ key: 'openai', totalRequests: '7', totalErrors: '0', totalTokens: '70', totalPromptTokens: '40', totalCompletionTokens: '30', totalCacheReadTokens: null, totalCacheCreationTokens: null }]);

    const result = await getReportByProvider({});

    expect(result[0].key).toBe('openai');
    expect(result[0].totalTokens).toBe(70);
  });
});

// ── Repository: trends (time series) ───────────────────────────────────

describe('getReportTrends', () => {
  it('按时间桶分组、排序、LIMIT 100000，字段 Number 映射', async () => {
    const chain = setupSelect([{
      timeBucket: '2024-01-01',
      totalRequests: '5',
      totalErrors: '0',
      totalTokens: '500',
      totalPromptTokens: '300',
      totalCompletionTokens: '200',
      totalCacheReadTokens: null,
      totalCacheCreationTokens: null,
    }]);

    const result = await getReportTrends({ granularity: 'day' });

    expect(result).toEqual([{
      timeBucket: '2024-01-01',
      totalRequests: 5,
      totalErrors: 0,
      totalTokens: 500,
      totalPromptTokens: 300,
      totalCompletionTokens: 200,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    }]);
    expect(chain.groupBy).toHaveBeenCalled();
    expect(chain.orderBy).toHaveBeenCalled();
    expect(chain.limit).toHaveBeenCalledWith(100_000);
  });

  it('granularity=hour 走小时桶（groupBy 仍被调用）', async () => {
    const chain = setupSelect([]);

    await getReportTrends({ granularity: 'hour' });

    expect(chain.groupBy).toHaveBeenCalled();
  });

  it('未指定 granularity 默认按天', async () => {
    const chain = setupSelect([]);

    await getReportTrends({});

    expect(chain.groupBy).toHaveBeenCalled();
  });
});

// ── Routes: query parsing + {data} envelope ────────────────────────────

describe('reports routes', () => {
  const emptyOverviewRow = {
    totalRequests: '0', totalErrors: '0', totalPromptTokens: null,
    totalCompletionTokens: null, totalCacheReadTokens: null,
    totalCacheCreationTokens: null, totalTokens: null, avgLatencyMs: null,
  };

  it('GET /overview 返回 {data} 信封', async () => {
    setupSelect([{
      totalRequests: '1', totalErrors: '0', totalPromptTokens: '10',
      totalCompletionTokens: '5', totalCacheReadTokens: null,
      totalCacheCreationTokens: null, totalTokens: '15', avgLatencyMs: '100',
    }]);

    const res = await adminReports.request('/overview');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeDefined();
    expect(body.data.totalRequests).toBe(1);
    expect(body.data.errorRate).toBe(0);
  });

  it('GET /overview?model=gpt-4 解析 model 过滤（WHERE 非空）', async () => {
    const chain = setupSelect([emptyOverviewRow]);

    await adminReports.request('/overview?model=gpt-4');

    // buildRequestLogConditions 返回非空 → reportWhere 返回 and(...)（defined）。
    expect(chain.where).toHaveBeenCalledTimes(1);
    expect(chain.where.mock.calls[0][0]).toBeDefined();
  });

  it('GET /overview 无过滤时 WHERE 为 undefined（不过滤）', async () => {
    const chain = setupSelect([emptyOverviewRow]);

    await adminReports.request('/overview');

    // conditions 为空 → reportWhere 返回 undefined → db.select().where(undefined)。
    expect(chain.where).toHaveBeenCalledTimes(1);
    expect(chain.where.mock.calls[0][0]).toBeUndefined();
  });

  it('GET /trends?granularity=hour 透传粒度并返回 {data}', async () => {
    const chain = setupSelect([]);

    const res = await adminReports.request('/trends?granularity=hour');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(chain.groupBy).toHaveBeenCalled();
  });

  it('GET /trends 非法 granularity 回退为 day', async () => {
    const chain = setupSelect([]);

    await adminReports.request('/trends?granularity=bogus');

    // 仍正常分组（day 默认），不抛错。
    expect(chain.groupBy).toHaveBeenCalled();
  });

  it('GET /by-model 返回 {data} 数组', async () => {
    setupSelect([{ key: 'gpt-4', totalRequests: '1', totalErrors: '0', totalTokens: '1', totalPromptTokens: '1', totalCompletionTokens: '0', totalCacheReadTokens: null, totalCacheCreationTokens: null }]);

    const res = await adminReports.request('/by-model');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].key).toBe('gpt-4');
  });

  it('GET /by-provider 返回 {data} 数组', async () => {
    setupSelect([{ key: 'openai', totalRequests: '1', totalErrors: '0', totalTokens: '1', totalPromptTokens: '1', totalCompletionTokens: '0', totalCacheReadTokens: null, totalCacheCreationTokens: null }]);

    const res = await adminReports.request('/by-provider');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].key).toBe('openai');
  });

  it('GET /by-status 返回 {data} 数组', async () => {
    setupSelect([{ statusClass: '200', totalRequests: '1', totalTokens: '1' }]);

    const res = await adminReports.request('/by-status');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].statusClass).toBe(200);
  });

  it('GET /by-status?statusCode=500 解析数字过滤', async () => {
    const chain = setupSelect([]);

    await adminReports.request('/by-status?statusCode=500');

    expect(chain.where.mock.calls[0][0]).toBeDefined();
  });
});
