import { serve } from '@hono/node-server';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config/index.js';
import { createLogger } from './utils/logger.js';
import { initDatabase, closeDatabase } from './db/index.js';
import { initRedis, closeRedis, podId } from './redis/index.js';
import { tryAcquireLock, releaseLock, waitForLockRelease } from './redis/lock.js';
import { bootstrapDefaultAdmin } from './services/admin-auth.js';
import app, {
  startRateLimiterCleanup,
  stopRateLimiterCleanup,
  startQuotaCleanup,
  stopQuotaCleanup,
  startLogArchive,
  stopLogArchive,
} from './app.js';

// 迁移锁 TTL / 等待上限。多 pod 并发启动时只有一个 pod 抢到锁跑 migrate，避免并发
// DDL；持锁者跑完在 finally 释放（value=podId，release 时 Lua 校验防误删）。未抢到的
// pod 等待持锁者跑完再继续启动（不重跑——drizzle migrate 幂等，信任持锁者已应用迁移）。
const MIGRATION_LOCK_TTL_SEC = 300;
const MIGRATION_WAIT_MS = 120_000;

async function main() {
  // ── Bootstrap ────────────────────────────────────────────────────────
  const config = loadConfig();
  const logger = createLogger('gateway');
  const db = initDatabase();
  // Redis 必须在 migrate 之前就绪：迁移锁依赖它。强依赖——initRedis 启动即 ping，
  // 连不上 process.exit(1)。
  await initRedis();

  // Auto-run migrations on startup. Drizzle's migrator is idempotent
  // (tracks applied migrations in __drizzle_migrations), so re-running on
  // every boot is safe and removes the manual `pnpm db:migrate` step. A Redis
  // leader lock serializes migrations across concurrent pods so two pods never
  // run DDL at the same time.
  const migrationsFolder = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    'db/migrations',
  );
  logger.info({ migrationsFolder }, 'Running database migrations');
  const prefix = config.redis.keyPrefix;
  const got = await tryAcquireLock(`${prefix}migration:lock`, podId, MIGRATION_LOCK_TTL_SEC);
  if (got) {
    try {
      await migrate(db, { migrationsFolder });
    } catch (err) {
      // 脏库兜底:`__drizzle_migrations` 被清空但业务表已存在时,drizzle
      // migrate 会因 CREATE TABLE 撞已存在表(ER_TABLE_EXISTS_ERROR / 1050)
      // 而回滚并抛错。此时表实际可用,记录警告并继续启动,避免 pod 陷入
      // CrashLoopBackOff。其他迁移错误仍视为致命,照常抛出。
      const code = (err as { code?: string })?.code;
      if (code === 'ER_TABLE_EXISTS_ERROR') {
        logger.warn(
          { err: (err as Error).message },
          'Migration hit a pre-existing table — likely __drizzle_migrations was reset while tables persist. Continuing startup.',
        );
      } else {
        throw err;
      }
    } finally {
      // 释放包 try/catch：Redis 抖动导致释放失败时仅记录、不抛——否则会掩盖
      // catch 分支 throw 的 migrate 原始异常（丢失真实错误堆栈，仅留下 release 错误）。
      try {
        await releaseLock(`${prefix}migration:lock`, podId);
      } catch (releaseErr) {
        logger.warn(
          { err: (releaseErr as Error).message },
          'Failed to release migration lock',
        );
      }
    }
  } else {
    // 另一个 pod 持有迁移锁,等它跑完。等待结束不重抢不重跑——drizzle migrate
    // 幂等,持锁者已应用迁移。超时仍持锁则 fail-open 继续(幂等兜底)。
    logger.info('Another pod holds the migration lock; waiting for it to finish');
    const released = await waitForLockRelease(`${prefix}migration:lock`, MIGRATION_WAIT_MS);
    if (!released) {
      logger.warn(
        { waitMs: MIGRATION_WAIT_MS },
        'Migration lock wait timed out, continuing startup (drizzle migrate is idempotent).',
      );
    }
  }

  await bootstrapDefaultAdmin();
  startRateLimiterCleanup();
  startQuotaCleanup();
  startLogArchive();

  logger.info({ port: config.port, env: config.nodeEnv }, 'Starting LLM Gateway');

  // ── HTTP server ──────────────────────────────────────────────────────
  const server = serve({
    fetch: app.fetch,
    port: config.port,
  });

  // ── Graceful shutdown ────────────────────────────────────────────────
  // Reverse of startup: timers → HTTP → Redis → DB. Redis closes before DB so
  // no in-flight request finds DB still open but Redis gone.
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal');
    stopRateLimiterCleanup();
    stopQuotaCleanup();
    stopLogArchive();

    server.close(() => {
      logger.info('HTTP server closed');
    });

    try {
      await closeRedis();
      logger.info('Redis connection closed');
    } catch (err) {
      logger.error({ err }, 'Error closing Redis');
    }

    try {
      await closeDatabase();
      logger.info('Database connection closed');
    } catch (err) {
      logger.error({ err }, 'Error closing database');
    }

    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
