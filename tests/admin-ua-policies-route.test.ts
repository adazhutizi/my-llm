import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// getDb returns a chainable mock; invalidateUaPolicyConfig is spied so the
// "config changes apply immediately" contract can be asserted. The domain
// logic itself (Zod, checkUaPatternSafety) runs REAL — these tests also pin
// the validation surface.

const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn(),
}));

const invalidate = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('../src/db/index.js', () => ({ getDb: () => mockDb }));
vi.mock('../src/services/ua-policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/ua-policy.js')>();
  return { ...actual, invalidateUaPolicyConfig: invalidate };
});

import { adminUaPolicies } from '../src/routes/admin/ua-policies.js';

function makeApp() {
  const app = new Hono();
  app.route('/admin/ua-policies', adminUaPolicies);
  return app;
}

// select chain helpers: the route awaits select().from().where(...) for GET
// (thenable where) and select().from().where().limit(1) for the upsert
// existing-check / final read-back.
function selectReturning(rows: unknown[], { withLimit }: { withLimit: boolean }) {
  const where = vi.fn();
  if (withLimit) {
    where.mockReturnValue({ limit: vi.fn(async () => rows) });
  } else {
    where.mockResolvedValue(rows);
  }
  return vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where }) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /admin/ua-policies', () => {
  it('returns the {data} envelope with filter results', async () => {
    mockDb.select.mockImplementation(selectReturning(
      [{ id: 1, targetType: 'global', targetId: null, mode: 'block', patterns: ['^curl'] }],
      { withLimit: false },
    ));

    const res = await makeApp().request('/admin/ua-policies?targetType=global');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].mode).toBe('block');
  });
});

describe('PUT /admin/ua-policies', () => {
  const validBody = {
    targetType: 'global',
    mode: 'block',
    patterns: ['^curl'],
  };

  it('updates an existing row (200) and invalidates the cache', async () => {
    // 1st select: existing-check finds a row → update branch.
    mockDb.select.mockImplementationOnce(selectReturning([{ id: 5 }], { withLimit: true }));
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    });
    // 2nd select: final read-back.
    mockDb.select.mockImplementationOnce(selectReturning(
      [{ id: 5, targetType: 'global', targetId: null, mode: 'block', patterns: ['^curl'] }],
      { withLimit: true },
    ));

    const res = await makeApp().request('/admin/ua-policies', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(200);
    expect(mockDb.update).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith('global', null);
  });

  it('inserts when absent (201) and invalidates (a cached null sentinel must go too)', async () => {
    mockDb.select.mockImplementationOnce(selectReturning([], { withLimit: true }));
    mockDb.insert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    mockDb.select.mockImplementationOnce(selectReturning(
      [{ id: 9, targetType: 'global', targetId: null, mode: 'block', patterns: ['^curl'] }],
      { withLimit: true },
    ));

    const res = await makeApp().request('/admin/ua-policies', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(201);
    expect(mockDb.insert).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith('global', null);
  });

  it('requires targetId for non-global targets', async () => {
    const res = await makeApp().request('/admin/ua-policies', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetType: 'user', mode: 'block', patterns: ['^curl'] }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an empty allow list (would deny everything)', async () => {
    const res = await makeApp().request('/admin/ua-policies', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetType: 'global', mode: 'allow', patterns: [] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/白名单/);
  });

  it('rejects uncompilable regexes with the entry index', async () => {
    const res = await makeApp().request('/admin/ua-policies', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetType: 'global', mode: 'block', patterns: ['^ok', '(unclosed'] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/patterns\[1\]/);
  });

  it('rejects catastrophic-backtracking shapes (nested quantifiers)', async () => {
    const res = await makeApp().request('/admin/ua-policies', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetType: 'global', mode: 'block', patterns: ['(a+)+'] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/嵌套量词/);
  });

  it('rejects empty-string and oversize patterns, and too many patterns', async () => {
    const app = makeApp();
    const put = (patterns: string[]) =>
      app.request('/admin/ua-policies', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetType: 'global', mode: 'block', patterns }),
      });

    expect((await put([''])).status).toBe(400);
    expect((await put(['a'.repeat(513)])).status).toBe(400);
    expect((await put(Array.from({ length: 101 }, () => 'x'))).status).toBe(400);
  });
});

describe('DELETE /admin/ua-policies', () => {
  it('deletes the row, invalidates, and is idempotent', async () => {
    mockDb.delete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });

    const res = await makeApp().request('/admin/ua-policies?targetType=global', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { success: boolean }).success).toBe(true);
    expect(mockDb.delete).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith('global', null);
  });

  it('requires targetId for non-global targets', async () => {
    const res = await makeApp().request('/admin/ua-policies?targetType=api_key', { method: 'DELETE' });
    expect(res.status).toBe(400);
  });
});
