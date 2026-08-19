import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock the repository
vi.mock('../src/db/repositories/usage.js', () => ({
  getUsageByAppUser: vi.fn(),
  getUsageByFeature: vi.fn(),
  getUsageOverview: vi.fn(),
  getUsageByKey: vi.fn(),
  getUsageByApp: vi.fn(),
  getUsageByUser: vi.fn(),
  getUsageByModel: vi.fn(),
  getUsageTrends: vi.fn(),
}));

import { adminUsage } from '../src/routes/admin/usage.js';
import { getUsageByAppUser, getUsageByFeature } from '../src/db/repositories/usage.js';

const mockedGetUsageByAppUser = vi.mocked(getUsageByAppUser);
const mockedGetUsageByFeature = vi.mocked(getUsageByFeature);

const defaultSummary = {
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  totalTokens: 0,
  totalRequests: 0,
};

describe('GET /admin/usage/by-app-user', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/', adminUsage);
  });

  it('should work without appId (all apps)', async () => {
    const mockResult = {
      data: [],
      summary: defaultSummary,
      total: 0,
      page: 1,
      pageSize: 20,
    };

    mockedGetUsageByAppUser.mockResolvedValue(mockResult);

    const res = await app.request('/by-app-user');

    expect(res.status).toBe(200);
    expect(mockedGetUsageByAppUser).toHaveBeenCalledWith({
      appId: undefined,
      featureId: undefined,
      search: undefined,
      startDate: undefined,
      endDate: undefined,
      page: undefined,
      pageSize: undefined,
    });
  });

  it('should return paginated usage data for app users', async () => {
    const mockResult = {
      data: [
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
      ],
      summary: {
        totalPromptTokens: 3000,
        totalCompletionTokens: 1500,
        totalTokens: 4500,
        totalRequests: 30,
      },
      total: 2,
      page: 1,
      pageSize: 20,
    };

    mockedGetUsageByAppUser.mockResolvedValue(mockResult);

    const res = await app.request('/by-app-user?appId=1');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      data: mockResult.data,
      summary: mockResult.summary,
      pagination: {
        page: 1,
        pageSize: 20,
        total: 2,
      },
    });
  });

  it('should pass date filters to the repository', async () => {
    const mockResult = {
      data: [],
      summary: defaultSummary,
      total: 0,
      page: 1,
      pageSize: 20,
    };

    mockedGetUsageByAppUser.mockResolvedValue(mockResult);

    const startDate = '2024-01-01T00:00:00.000Z';
    const endDate = '2024-12-31T23:59:59.999Z';

    const res = await app.request(
      `/by-app-user?appId=5&startDate=${startDate}&endDate=${endDate}`
    );

    expect(res.status).toBe(200);
    expect(mockedGetUsageByAppUser).toHaveBeenCalledWith({
      appId: 5,
      featureId: undefined,
      search: undefined,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      page: undefined,
      pageSize: undefined,
    });
  });

  it('should pass pagination parameters to the repository', async () => {
    const mockResult = {
      data: [],
      summary: defaultSummary,
      total: 50,
      page: 3,
      pageSize: 10,
    };

    mockedGetUsageByAppUser.mockResolvedValue(mockResult);

    const res = await app.request('/by-app-user?appId=1&page=3&pageSize=10');

    expect(res.status).toBe(200);
    expect(mockedGetUsageByAppUser).toHaveBeenCalledWith({
      appId: 1,
      featureId: undefined,
      search: undefined,
      startDate: undefined,
      endDate: undefined,
      page: 3,
      pageSize: 10,
    });

    const body = await res.json();
    expect(body.pagination).toEqual({
      page: 3,
      pageSize: 10,
      total: 50,
    });
  });

  it('should pass a trimmed search filter to the repository', async () => {
    const mockResult = {
      data: [],
      summary: defaultSummary,
      total: 0,
      page: 1,
      pageSize: 20,
    };

    mockedGetUsageByAppUser.mockResolvedValue(mockResult);

    const res = await app.request('/by-app-user?appId=1&search=alice');

    expect(res.status).toBe(200);
    expect(mockedGetUsageByAppUser).toHaveBeenCalledWith({
      appId: 1,
      featureId: undefined,
      search: 'alice',
      startDate: undefined,
      endDate: undefined,
      page: undefined,
      pageSize: undefined,
    });
  });

  it('should treat whitespace-only search as undefined', async () => {
    const mockResult = {
      data: [],
      summary: defaultSummary,
      total: 0,
      page: 1,
      pageSize: 20,
    };

    mockedGetUsageByAppUser.mockResolvedValue(mockResult);

    // "%20%20" decodes to two spaces, which trims to empty → undefined
    const res = await app.request('/by-app-user?search=%20%20');

    expect(res.status).toBe(200);
    expect(mockedGetUsageByAppUser).toHaveBeenCalledWith({
      appId: undefined,
      featureId: undefined,
      search: undefined,
      startDate: undefined,
      endDate: undefined,
      page: undefined,
      pageSize: undefined,
    });
  });

  it('should handle empty results', async () => {
    const mockResult = {
      data: [],
      summary: defaultSummary,
      total: 0,
      page: 1,
      pageSize: 20,
    };

    mockedGetUsageByAppUser.mockResolvedValue(mockResult);

    const res = await app.request('/by-app-user?appId=999');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      data: [],
      summary: defaultSummary,
      pagination: {
        page: 1,
        pageSize: 20,
        total: 0,
      },
    });
  });

  it('should handle repository errors gracefully', async () => {
    mockedGetUsageByAppUser.mockRejectedValue(new Error('Database connection failed'));

    const res = await app.request('/by-app-user?appId=1');

    expect(res.status).toBe(500);
  });
});

describe('GET /admin/usage/by-feature', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/', adminUsage);
  });

  it('should call getUsageByFeature with defaults when no params', async () => {
    const mockResult = {
      data: [],
      summary: defaultSummary,
      total: 0,
      page: 1,
      pageSize: 20,
    };

    mockedGetUsageByFeature.mockResolvedValue(mockResult);

    const res = await app.request('/by-feature');

    expect(res.status).toBe(200);
    expect(mockedGetUsageByFeature).toHaveBeenCalledWith({
      appId: undefined,
      appUserId: undefined,
      search: undefined,
      startDate: undefined,
      endDate: undefined,
      page: undefined,
      pageSize: undefined,
    });
  });

  it('should pass appId, appUserId and search to the repository', async () => {
    const mockResult = {
      data: [],
      summary: defaultSummary,
      total: 0,
      page: 1,
      pageSize: 20,
    };

    mockedGetUsageByFeature.mockResolvedValue(mockResult);

    const res = await app.request('/by-feature?appId=2&appUserId=u1&search=chat');

    expect(res.status).toBe(200);
    expect(mockedGetUsageByFeature).toHaveBeenCalledWith({
      appId: 2,
      appUserId: 'u1',
      search: 'chat',
      startDate: undefined,
      endDate: undefined,
      page: undefined,
      pageSize: undefined,
    });
  });

  it('should return paginated feature usage', async () => {
    const mockResult = {
      data: [
        {
          appId: 1,
          featureId: 'chat',
          totalPromptTokens: 100,
          totalCompletionTokens: 50,
          totalTokens: 150,
          totalRequests: 5,
        },
      ],
      summary: {
        totalPromptTokens: 100,
        totalCompletionTokens: 50,
        totalTokens: 150,
        totalRequests: 5,
      },
      total: 1,
      page: 1,
      pageSize: 20,
    };

    mockedGetUsageByFeature.mockResolvedValue(mockResult);

    const res = await app.request('/by-feature?appId=1');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pagination).toEqual({
      page: 1,
      pageSize: 20,
      total: 1,
    });
  });
});
