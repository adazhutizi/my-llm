import { getConfig } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import { runLogArchive } from '../db/repositories/logs.js';
import { tryAcquireLock, releaseLock } from '../redis/lock.js';
import { getRedis, podId } from '../redis/index.js';

// ─── Daily log archive scheduler ──────────────────────────────────────────────
//
// Merges agentic loop sessions once a day: keeps only the tail (most complete)
// request_details row per conversation and nulls the superseded prefixes' big
// fields. Modeled on rate-limiter.ts / quota-cache.ts (setInterval + unref so
// the timer never blocks process exit). The hourly tick is cheap; the actual
// run is gated by `enabled`, the target `runHour`, a same-day guard, and a
// Redis leader-election lock so that under multi-pod horizontal scaling only
// one pod runs the archive per day (previously every pod ran it → N× DB load
// and concurrent DELETE/scan lock contention).

const TICK_INTERVAL_MS = 60 * 60 * 1000; // check every hour

// Execution lock: short TTL covering ONE run. The holder releases it in a
// `finally` after the run, so if it dies mid-run (pod OOM, rolling eviction,
// node drain) the lock still expires within EXEC_LOCK_TTL_SEC and another pod
// picks up the same day's archive on a later tick. The previous design held one
// lock for a flat 24h with no release AND used it as the "ran today" marker — so
// a mid-run crash or a thrown runLogArchive left the lock occupying the whole
// day and the archive simply didn't run that day (an acknowledged trade-off that
// hurts most in multi-pod deployments, where rolling updates / evictions are
// routine). Splitting "concurrent execution" (this short lock) from "ran today"
// (the done marker below) is what makes crashes recoverable.
const EXEC_LOCK_TTL_SEC = 3600; // 1h comfortably covers a run. If a run ever
// exceeds it the worst case is two pods briefly scanning concurrently — harmless,
// runLogArchive is idempotent (archived_at IS NULL guard, no double-processing).

// Seconds from `d` to the start of the next UTC day. Used as the TTL for the
// "done today" marker so it is gone well before the next day's runHour window —
// a flat 24h TTL set at, say, 20:01 expires at 20:01 the next day, exactly when
// the next day's tick fires, letting it lose the SET NX race and slip a day.
function secondsToEndOfUtcDay(d: Date): number {
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0);
  return Math.max(1, Math.ceil((end - d.getTime()) / 1000));
}

let timer: ReturnType<typeof setInterval> | null = null;
// UTC date string (YYYY-MM-DD) of the last SUCCESSFUL run in this process —
// cheap in-process short-circuit before hitting Redis. Only set on success, so
// a failed run is retried by the next tick (the cross-pod "ran today" signal is
// the Redis done marker, which is also only set on success).
let lastRunDate = '';

// Lock key and runHour MUST use UTC. Pods in different container timezones would
// otherwise compute different "today" / "current hour" values, splitting the
// leader lock across keys and letting the archive run repeatedly within one UTC
// day. UTC makes it consistent across pods regardless of container TZ.
function utcTodayStr(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

async function tick(): Promise<void> {
  try {
    const cfg = getConfig().log.archive;
    if (!cfg.enabled) return;

    const now = new Date();
    const today = utcTodayStr(now);
    if (today === lastRunDate) return; // already ran today (this process)
    if (now.getUTCHours() < cfg.runHour) return; // before scheduled hour (UTC)

    const prefix = getConfig().redis.keyPrefix;
    const r = getRedis();

    // Cross-pod "ran today" check. The done marker — not the execution lock —
    // is what stops other pods from re-running the same day, which is what lets
    // the execution lock be short-lived and releasable (recoverable on crash).
    if (await r.get(`${prefix}logarchive:done:${today}`)) return;

    // Leader election: only one pod runs the archive at a time. Short TTL: if the
    // holder crashes mid-run the lock auto-expires and another pod takes over.
    const runKey = `${prefix}logarchive:run:${today}`;
    const got = await tryAcquireLock(runKey, podId, EXEC_LOCK_TTL_SEC);
    if (!got) return;

    try {
      const stats = await runLogArchive({
        retentionDays: cfg.retentionDays,
        sessionTimeoutMin: cfg.sessionTimeoutMin,
        batchSize: cfg.batchSize,
      });
      // Mark done + lastRunDate ONLY on success, so a failed or crashed run is
      // retried by the next hourly tick (this pod or another) instead of losing
      // the day.
      await r.set(`${prefix}logarchive:done:${today}`, podId, 'EX', secondsToEndOfUtcDay(now));
      lastRunDate = today;
      getLogger().info(stats, 'Log archive completed');
    } finally {
      // Release so the next tick's SET NX isn't blocked by a stale lock from
      // this pod's own completed run. Swallow release errors (the short TTL
      // backstops a failed release) — never let masking them hide a run exception.
      await releaseLock(runKey, podId).catch(() => {});
    }
  } catch (err) {
    // Swallow — a failed archive run (incl. Redis errors) must not crash the
    // gateway. Logs the error; the next hourly tick retries (same day, since no
    // done marker is set on failure).
    getLogger().error({ err }, 'Log archive run failed');
  }
}

export function startLogArchiveCleanup(): void {
  if (!timer) {
    // Tick once immediately on startup instead of waiting a full TICK_INTERVAL_MS.
    // Without this, a restart (dev hot-reload, rolling update) delays the first
    // check by up to 1h — and once runHour has passed, the archive would run "1h
    // after boot" at an arbitrary wall-clock time instead of near runHour. The
    // immediate tick obeys the same enabled/runHour/same-day/lock gates, so it
    // runs only when the day actually owes a run; otherwise it's a cheap no-op.
    void tick();
    timer = setInterval(() => {
      void tick();
    }, TICK_INTERVAL_MS);
    // Allow the Node process to exit even if the timer is running.
    if (timer.unref) {
      timer.unref();
    }
  }
}

export function stopLogArchiveCleanup(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
