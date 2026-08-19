import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/db/repositories/apps.js', () => ({
  listApps: vi.fn(),
  getAppById: vi.fn(),
  createApp: vi.fn(),
  updateApp: vi.fn(),
  deleteApp: vi.fn(),
  listAppUsers: vi.fn(),
  addAppUser: vi.fn(),
  removeAppUser: vi.fn(),
  updateAppUser: vi.fn(),
  listFeatures: vi.fn(),
  removeFeature: vi.fn(),
  updateFeature: vi.fn(),
}));

vi.mock('../src/db/repositories/usage.js', () => ({
  getUsageOverview: vi.fn(),
}));

import { adminApps } from '../src/routes/admin/apps.js';
import { updateAppUser, listAppUsers, getAppById } from '../src/db/repositories/apps.js';

const mockedUpdateAppUser = vi.mocked(updateAppUser);
const mockedListAppUsers = vi.mocked(listAppUsers);
const mockedGetAppById = vi.mocked(getAppById);

const appRow = { id: 1, name: 'App1', description: null, ownerId: null, status: 'active' };

describe('PATCH /admin/apps/:id/users/:uid', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/', adminApps);
  });

  it('should update the app user display name and return the updated row', async () => {
    mockedGetAppById.mockResolvedValue(appRow as never);
    const updated = { id: 7, appId: 1, externalUid: 'u1', displayName: 'Alice', createdAt: '2024-01-01' };
    mockedListAppUsers.mockResolvedValue([updated] as never);

    const res = await app.request('/1/users/u1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Alice' }),
    });

    expect(res.status).toBe(200);
    expect(mockedUpdateAppUser).toHaveBeenCalledWith(1, 'u1', 'Alice');
    const body = await res.json();
    expect(body).toEqual({ data: updated });
  });

  it('should allow null displayName to clear the remark', async () => {
    mockedGetAppById.mockResolvedValue(appRow as never);
    mockedListAppUsers.mockResolvedValue([
      { id: 7, appId: 1, externalUid: 'u1', displayName: null, createdAt: '2024-01-01' },
    ] as never);

    const res = await app.request('/1/users/u1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: null }),
    });

    expect(res.status).toBe(200);
    expect(mockedUpdateAppUser).toHaveBeenCalledWith(1, 'u1', null);
  });

  it('should reject with 400 when displayName is missing', async () => {
    mockedGetAppById.mockResolvedValue(appRow as never);

    const res = await app.request('/1/users/u1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(mockedUpdateAppUser).not.toHaveBeenCalled();
  });

  it('should reject with 400 when JSON body is invalid', async () => {
    mockedGetAppById.mockResolvedValue(appRow as never);

    const res = await app.request('/1/users/u1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });

    expect(res.status).toBe(400);
    expect(mockedUpdateAppUser).not.toHaveBeenCalled();
  });

  it('should return 400 for an invalid app id', async () => {
    const res = await app.request('/abc/users/u1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'x' }),
    });

    expect(res.status).toBe(400);
    expect(mockedUpdateAppUser).not.toHaveBeenCalled();
  });

  it('should return 404 when the app does not exist', async () => {
    mockedGetAppById.mockResolvedValue(null as never);

    const res = await app.request('/999/users/u1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'x' }),
    });

    expect(res.status).toBe(404);
    expect(mockedUpdateAppUser).not.toHaveBeenCalled();
  });
});
