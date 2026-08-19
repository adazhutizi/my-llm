import { Redis, type RedisOptions } from 'ioredis';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { getConfig } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import { RATE_LIMIT_LUA, QUOTA_INCR_LUA, RELEASE_LOCK_LUA } from './scripts.js';

// defineCommand 在运行时给 client 实例添加命名命令，但 TypeScript 静态类型不感知——
// 用 module augmentation 给 Redis 接口补这三个方法的签名，使调用处类型安全。
declare module 'ioredis' {
  interface Redis {
    rateLimit(
      qpsKey: string,
      rpmKey: string,
      now: number,
      qpsCap: number,
      qpsRefill: number,
      rpmCap: number,
      rpmRefill: number,
    ): Promise<number>;
    quotaIncr(key: string, tokens: number, ttlSec: number): Promise<number>;
    releaseLock(key: string, value: string): Promise<number>;
  }
}

let client: Redis | null = null;

// 锁 value：迁移锁必须唯一（release 时 Lua 校验防误删）；归档锁不释放、仅诊断用。
export const podId = `${hostname()}:${randomBytes(6).toString('hex')}`;

// Redis 客户端单例，生命周期仿 src/db/index.ts（initDatabase/getDb/closeDatabase）。
// 强依赖：initRedis 启动即 ping，连不上 process.exit(1)（多实例共享状态的前提）。
export async function initRedis(): Promise<Redis> {
  if (client) return client;

  const cfg = getConfig().redis;
  const log = createLogger('redis');
  const options: RedisOptions = {
    maxRetriesPerRequest: cfg.maxRetriesPerRequest, // 断连排队命令快速失败
    commandTimeout: cfg.commandTimeoutMs, // 已发命令超时（fail-open 关键，maxRetriesPerRequest 不覆盖此项）
    connectTimeout: cfg.connectTimeoutMs,
    enableReadyCheck: true,
    retryStrategy: (t) => Math.min(t * 200, 2000), // 有界退避，勿返回 0/null（会停连或 busy-loop）
    lazyConnect: false,
    // 认证：仅非空时传。username 留空→经典 AUTH；非空→Redis 6+ ACL。
    // 不传空串以避免覆盖 url 内嵌凭证 / 触发旧版 Redis 的 ACL 报错。
    ...(cfg.username ? { username: cfg.username } : {}),
    ...(cfg.password ? { password: cfg.password } : {}),
    // 不用 ioredis keyPrefix —— 它不会作用于 Lua 内 redis.call，会造成普通命令与
    // Lua 命令前缀不一致。前缀在各 service 用 cfg.keyPrefix 手动拼。TLS 由 url 用
    // rediss:// scheme 触发（ioredis 自动）。
  };

  client = new Redis(cfg.url, options);
  client.on('error', (e) => log.error({ err: e.message }, 'redis error'));

  // 注册 Lua 命令（ioredis 自动 evalsha + eval fallback，限流热点必备）
  client.defineCommand('rateLimit', { numberOfKeys: 2, lua: RATE_LIMIT_LUA });
  client.defineCommand('quotaIncr', { numberOfKeys: 1, lua: QUOTA_INCR_LUA });
  client.defineCommand('releaseLock', { numberOfKeys: 1, lua: RELEASE_LOCK_LUA });

  try {
    await client.ping(); // 强依赖：启动即验，连不上退出
  } catch (e) {
    log.error({ err: (e as Error).message }, 'redis unreachable at startup');
    process.exit(1);
  }
  return client;
}

export function getRedis(): Redis {
  if (!client) {
    throw new Error('Redis not initialized. Call initRedis() first.');
  }
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
