import { describe, it, expect, vi, beforeEach } from 'vitest';

// Build a fluent mock that supports chaining: select().from().where().groupBy().orderBy().limit().offset()
function createFluentMock(finalResult: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ['from', 'where', 'groupBy', 'orderBy', 'limit', 'offset'];
  for (const method of methods) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  // The last method in the chain resolves the promise
  chain.offset = vi.fn().mockResolvedValue(finalResult);
  return chain;
}

// Mock the database module — drizzle-orm functions (eq, and, sql, etc.) work normally
const mockSelect = vi.fn();
const mockDb = {
  select: mockSelect,
};

vi.mock('../src/db/index.js', () => ({
  getDb: () => mockDb,
}));

import { getUsageByAppUser, getUsageByFeature } from '../src/db/repositories/usage.js';

/** Helper: set up 3 select mocks (count, summary, data) */
function mockThreeSelects(countResult: unknown[], summaryResult: unknown[], dataResult: unknown[]) {
  const countChain = createFluentMock(countResult);
  countChain.where = vi.fn().mockResolvedValue(countResult);

  const summaryChain = createFluentMock(summaryResult);
  summaryChain.where = vi.fn().mockResolvedValue(summaryResult);

  const dataChain = createFluentMock(dataResult);

  mockSelect
    .mockReturnValueOnce(countChain)
    .mockReturnValueOnce(summaryChain)
    .mockReturnValueOnce(dataChain);

  return { countChain, summaryChain, dataChain };
}

describe('getUsageByAppUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return paginated usage data for app users', async () => {
    const mockCountResult = [{ total: 2 }];
    const mockSummaryResult = [{
      totalPromptTokens: 3000,
      totalCompletionTokens: 1500,
      totalTokens: 4500,
      totalRequests: 30,
    }];
    const mockUsageData = [
      {
        appId: 1,
        appUserId: 'user_001',
        totalPromptTokens: 1000,
        totalCompletionTokens: 500,
        totalTokens: 1500,
        totalRequests: 10,
      },
      {
        appId: 1,
        appUserId: 'user_002',
        totalPromptTokens: 2000,
        totalCompletionTokens: 1000,
        totalTokens: 3000,
        totalRequests: 20,
      },
    ];

    mockThreeSelects(mockCountResult, mockSummaryResult, mockUsageData);

    const result = await getUsageByAppUser({
      appId: 1,
      page: 1,
      pageSize: 20,
    });

    expect(result).toEqual({
      data: [
        {
          appId: 1,
          appUserId: 'user_001',
          totalPromptTokens: 1000,
          totalCompletionTokens: 500,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
          totalTokens: 1500,
          totalRequests: 10,
        },
        {
          appId: 1,
          appUserId: 'user_002',
          totalPromptTokens: 2000,
          totalCompletionTokens: 1000,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
          totalTokens: 3000,
          totalRequests: 20,
        },
      ],
      summary: {
        totalPromptTokens: 3000,
        totalCompletionTokens: 1500,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalTokens: 4500,
        totalRequests: 30,
      },
      total: 2,
      page: 1,
      pageSize: 20,
    });
  });

  it('should handle empty results', async () => {
    const mockCountResult = [{ total: 0 }];
    const mockSummaryResult = [{
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      totalRequests: 0,
    }];

    mockThreeSelects(mockCountResult, mockSummaryResult, []);

    const result = await getUsageByAppUser({
      appId: 1,
      page: 1,
      pageSize: 20,
    });

    expect(result).toEqual({
      data: [],
      summary: {
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalTokens: 0,
        totalRequests: 0,
      },
      total: 0,
      page: 1,
      pageSize: 20,
    });
  });

  it('should use default pagination values when not provided', async () => {
    const mockCountResult = [{ total: 1 }];
    const mockSummaryResult = [{
      totalPromptTokens: 100,
      totalCompletionTokens: 50,
      totalTokens: 150,
      totalRequests: 1,
    }];
    const mockUsageData = [
      {
        appId: 1,
        appUserId: 'user_001',
        totalPromptTokens: 100,
        totalCompletionTokens: 50,
        totalTokens: 150,
        totalRequests: 1,
      },
    ];

    mockThreeSelects(mockCountResult, mockSummaryResult, mockUsageData);

    const result = await getUsageByAppUser({ appId: 1 });

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.data).toHaveLength(1);
  });

  it('should calculate offset correctly for pagination', async () => {
    const mockCountResult = [{ total: 50 }];
    const mockSummaryResult = [{ totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0, totalRequests: 0 }];

    const { dataChain } = mockThreeSelects(mockCountResult, mockSummaryResult, []);

    await getUsageByAppUser({
      appId: 1,
      page: 3,
      pageSize: 10,
    });

    // Page 3, pageSize 10 → offset = (3-1) * 10 = 20
    expect(dataChain.offset).toHaveBeenCalledWith(20);
  });

  it('should handle date filters', async () => {
    const mockCountResult = [{ total: 1 }];
    const mockSummaryResult = [{
      totalPromptTokens: 500,
      totalCompletionTokens: 250,
      totalTokens: 750,
      totalRequests: 5,
    }];
    const mockUsageData = [
      {
        appId: 1,
        appUserId: 'user_001',
        totalPromptTokens: 500,
        totalCompletionTokens: 250,
        totalTokens: 750,
        totalRequests: 5,
      },
    ];

    const { countChain, dataChain } = mockThreeSelects(mockCountResult, mockSummaryResult, mockUsageData);

    const startDate = new Date('2024-01-01');
    const endDate = new Date('2024-12-31');

    const result = await getUsageByAppUser({
      appId: 1,
      startDate,
      endDate,
      page: 1,
      pageSize: 20,
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].appUserId).toBe('user_001');
    // Verify where was called (date filters add extra conditions)
    expect(countChain.where).toHaveBeenCalled();
    expect(dataChain.where).toHaveBeenCalled();
  });

  it('should accept a search filter without breaking the query chain', async () => {
    const mockCountResult = [{ total: 1 }];
    const mockSummaryResult = [{
      totalPromptTokens: 100,
      totalCompletionTokens: 50,
      totalTokens: 150,
      totalRequests: 1,
    }];
    const mockUsageData = [
      {
        appId: 1,
        appUserId: 'alice',
        totalPromptTokens: 100,
        totalCompletionTokens: 50,
        totalTokens: 150,
        totalRequests: 1,
      },
    ];

    const { countChain, dataChain } = mockThreeSelects(mockCountResult, mockSummaryResult, mockUsageData);

    const result = await getUsageByAppUser({
      appId: 1,
      search: 'ali',
      page: 1,
      pageSize: 20,
    });

    // search adds an extra OR/EXISTS condition; both the count and data queries
    // still call .where() and return the aggregated rows unchanged.
    expect(result.data).toHaveLength(1);
    expect(result.data[0].appUserId).toBe('alice');
    expect(countChain.where).toHaveBeenCalled();
    expect(dataChain.where).toHaveBeenCalled();
  });

  it('should convert string numbers to Number type', async () => {
    const mockCountResult = [{ total: '3' }];
    const mockSummaryResult = [{
      totalPromptTokens: '1000',
      totalCompletionTokens: '500',
      totalTokens: '1500',
      totalRequests: '10',
    }];
    const mockUsageData = [
      {
        appId: 1,
        appUserId: 'user_001',
        totalPromptTokens: '1000',
        totalCompletionTokens: '500',
        totalTokens: '1500',
        totalRequests: '10',
      },
    ];

    mockThreeSelects(mockCountResult, mockSummaryResult, mockUsageData);

    const result = await getUsageByAppUser({
      appId: 1,
      page: 1,
      pageSize: 20,
    });

    // MySQL sometimes returns numbers as strings — should be coerced
    expect(result.total).toBe(3);
    expect(result.data[0].totalPromptTokens).toBe(1000);
    expect(result.data[0].totalCompletionTokens).toBe(500);
    expect(result.data[0].totalTokens).toBe(1500);
    expect(result.data[0].totalRequests).toBe(10);
  });
});

describe('getUsageByFeature', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return paginated usage data grouped by feature', async () => {
    const mockCountResult = [{ total: 1 }];
    const mockSummaryResult = [{
      totalPromptTokens: 100,
      totalCompletionTokens: 50,
      totalTokens: 150,
      totalRequests: 5,
    }];
    const mockUsageData = [
      {
        appId: 1,
        featureId: 'chat',
        totalPromptTokens: 100,
        totalCompletionTokens: 50,
        totalTokens: 150,
        totalRequests: 5,
      },
    ];

    mockThreeSelects(mockCountResult, mockSummaryResult, mockUsageData);

    const result = await getUsageByFeature({
      appId: 1,
      page: 1,
      pageSize: 20,
    });

    expect(result).toEqual({
      data: [
        {
          appId: 1,
          featureId: 'chat',
          totalPromptTokens: 100,
          totalCompletionTokens: 50,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
          totalTokens: 150,
          totalRequests: 5,
        },
      ],
      summary: {
        totalPromptTokens: 100,
        totalCompletionTokens: 50,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalTokens: 150,
        totalRequests: 5,
      },
      total: 1,
      page: 1,
      pageSize: 20,
    });
  });

  it('should handle empty results', async () => {
    const mockCountResult = [{ total: 0 }];
    const mockSummaryResult = [{
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      totalRequests: 0,
    }];

    mockThreeSelects(mockCountResult, mockSummaryResult, []);

    const result = await getUsageByFeature({ appId: 1 });

    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('should accept a search filter without breaking the query chain', async () => {
    const mockCountResult = [{ total: 1 }];
    const mockSummaryResult = [{
      totalPromptTokens: 100,
      totalCompletionTokens: 50,
      totalTokens: 150,
      totalRequests: 5,
    }];
    const mockUsageData = [
      {
        appId: 1,
        featureId: 'chat',
        totalPromptTokens: 100,
        totalCompletionTokens: 50,
        totalTokens: 150,
        totalRequests: 5,
      },
    ];

    const { countChain, dataChain } = mockThreeSelects(mockCountResult, mockSummaryResult, mockUsageData);

    const result = await getUsageByFeature({
      appId: 1,
      search: 'cha',
      page: 1,
      pageSize: 20,
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].featureId).toBe('chat');
    expect(countChain.where).toHaveBeenCalled();
    expect(dataChain.where).toHaveBeenCalled();
  });
});
