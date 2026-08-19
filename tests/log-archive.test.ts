import { describe, it, expect, vi, beforeEach } from 'vitest';

// runLogArchive now does two things per run: (1) physically DELETE rows older
// than maxAgeDays in batched DELETE ... LIMIT, then (2) scan the merge window
// [now-maxAgeDays, now-retentionDays] via raw `db.execute()` — the FORCE INDEX
// (PRIMARY) hint can't be expressed through drizzle's builder. execute()
// returns `[rows]` (mysql2 shape); the mock distinguishes DELETE from SELECT
// by the raw SQL text (drizzle's sql template exposes a `.sql` getter) and
// pulls from the matching queue. SELECT pages come from `pageResults` (a page
// of [] terminates the merge loop); DELETE affected-rows come from
// `deleteAffected` (a batch < batchSize terminates the delete loop). UPDATEs
// still flow through `mockDb.update` and are captured in `updateSets`.

const pageResults: unknown[][] = [];
const deleteAffected: number[] = [];
const updateSets: { set: Record<string, unknown> }[] = [];

// runLogArchive runs the batched DELETE purge BEFORE the merge SELECT scan
// (see logs.ts). The mock exploits that fixed call order: the first run of
// execute calls serve DELETEs (draining `deleteAffected`; a batch below
// DELETE_BATCH flips the phase), then subsequent calls serve SELECT pages
// (draining `pageResults`). This avoids depending on drizzle SQL object
// internals. DELETE_BATCH must equal the batchSize in the mock config below.
const DELETE_BATCH = 5000;
let phase = 0;

const mockDb = {
  // runLogArchive reads runtime retention via getNumberSetting → db.select.
  // Return no rows so both retention values fall back to the config defaults
  // below (the retention-DB interaction is not what these tests exercise).
  select: vi.fn(() => {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.limit = async () => [];
    return chain;
  }),
  execute: vi.fn(async () => {
    // Three sequential phases match runLogArchive's fixed call order: details
    // DELETE purge -> logs DELETE purge -> details SELECT merge scan. A DELETE
    // batch whose affected-rows fall below DELETE_BATCH ends that purge and
    // advances the phase; an empty SELECT page ends the scan. (Phasing by call
    // order, not by inspecting the SQL object - drizzle's execute arg does not
    // expose a usable .sql string here.)
    if (phase === 0) {
      const affected = deleteAffected.shift() ?? 0;
      if (affected < DELETE_BATCH) phase = 1;
      return [{ affectedRows: affected }];
    }
    if (phase === 1) {
      // request_logs purge is not under test here - terminate it at once.
      phase = 2;
      return [{ affectedRows: 0 }];
    }
    return [pageResults.shift() ?? []];
  }),
  update: vi.fn(() => {
    const u: Record<string, unknown> = {};
    let captured: Record<string, unknown> = {};
    u.set = vi.fn((s: Record<string, unknown>) => {
      captured = s;
      return u;
    });
    u.where = vi.fn(async () => {
      updateSets.push({ set: captured });
    });
    return u;
  }),
};

vi.mock('../src/db/index.js', () => ({
  getDb: () => mockDb,
}));

vi.mock('../src/config/index.js', () => ({
  getConfig: () => ({
    log: {
      archive: {
        enabled: true,
        retentionDays: 1,
        sessionTimeoutMin: 10080,
        runHour: 3,
        batchSize: 5000,
        maxAgeDays: 30,
        logsRetentionDays: 180,
      },
    },
  }),
}));

import { runLogArchive } from '../src/db/repositories/logs.js';

// A cumulative loop: m1 ⊂ m2 ⊂ m3, plus an independent request mIndep.
const sys = { role: 'system', content: 's' };
const u1 = { role: 'user', content: 'u1' };
const a1 = { role: 'assistant', content: 'a1' };
const u2 = { role: 'user', content: 'u2' };
const a2 = { role: 'assistant', content: 'a2' };
const u3 = { role: 'user', content: 'u3' };
const m1 = [sys, u1];
const m2 = [sys, u1, a1, u2];
const m3 = [sys, u1, a1, u2, a2, u3];
const mIndep = [sys, { role: 'user', content: 'different' }];

// mysql2 raw row shape (snake_case). created_at as a Date exercises the same
// `new Date(value)` mapping path planArchive consumes via .getTime().
function detail(id: number, requestId: string, messages: unknown[], createdAtMs: number) {
  return {
    id,
    request_id: requestId,
    api_key_id: 5,
    request_body: { model: 'gpt-4', messages },
    created_at: new Date(createdAtMs),
  };
}

describe('runLogArchive', () => {
  beforeEach(() => {
    pageResults.length = 0;
    deleteAffected.length = 0;
    updateSets.length = 0;
    phase = 0;
    mockDb.execute.mockClear();
    mockDb.update.mockClear();
  });

  it('nulls superseded prefixes, batches one UPDATE per successor, reports stats', async () => {
    // 2 days ago — inside the [now-30d, now-1d] merge window, outside the
    // delete zone. No rows are old enough to purge, so deleteAffected stays
    // empty and the DELETE loop exits on its first 0-affected batch.
    const base = Date.now() - 2 * 86_400_000;
    // One page holds the whole window (default batchSize=5000), then [] ends.
    pageResults.push(
      [
        detail(1, 'r1', m1, base),
        detail(2, 'r2', m2, base + 60_000),
        detail(3, 'r3', m3, base + 120_000),
        detail(4, 'r4', mIndep, base + 180_000),
      ],
      [],
    );

    const stats = await runLogArchive();

    expect(stats.deleted).toBe(0); // nothing old enough to purge
    expect(stats.scanned).toBe(4);
    expect(stats.cleaned).toBe(2); // r1, r2 superseded
    expect(stats.kept).toBe(2); // r3 (tail) + r4 (independent)

    // Two successors (r2, r3) → two grouped UPDATE statements.
    expect(updateSets).toHaveLength(2);
    const mergedInto = updateSets.map((u) => u.set.mergedInto).sort();
    expect(mergedInto).toEqual(['r2', 'r3']);
    for (const u of updateSets) {
      expect(u.set.requestBody).toBeNull();
      expect(u.set.requestHeaders).toBeNull();
      expect(u.set.responseBody).toBeNull();
      expect(u.set.streamChunks).toBeNull();
      // archivedAt is a raw SQL literal (sql`formatUtcDateTime(...)`) emitting
      // a UTC wall-clock string, so assert it's set to a non-null value rather
      // than a Date instance.
      expect(u.set.archivedAt).toBeTruthy();
    }
  });

  it('is a no-op on an empty window (idempotent re-run after the first pass)', async () => {
    const stats = await runLogArchive();
    expect(stats.deleted).toBe(0);
    expect(stats.scanned).toBe(0);
    expect(stats.cleaned).toBe(0);
    expect(stats.kept).toBe(0);
    expect(updateSets).toHaveLength(0);
  });

  it('physically deletes rows older than maxAgeDays in batches without merging them', async () => {
    // 1970-era timestamps (createdAtMs=0) are far older than now-30d, so these
    // rows land in the purge zone, NOT the merge window. They must be DELETEd
    // and never reach planArchive — the merge SELECT's `created_at >=
    // maxAgeCutoff` upper bound excludes them (and the purge already removed
    // them anyway). deleteAffected drives three batches: two full (5000 each)
    // then one under-full (200) which terminates the loop.
    pageResults.push([]); // SELECT finds nothing in the merge window
    deleteAffected.push(5000, 5000, 200);

    const stats = await runLogArchive();

    expect(stats.deleted).toBe(10_200);
    expect(stats.scanned).toBe(0);
    expect(stats.cleaned).toBe(0);
    expect(updateSets).toHaveLength(0);
  });
});
