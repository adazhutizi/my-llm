import { getRedis } from './index.js';

// 分布式锁工具。key 由调用方传入完整 key（含 keyPrefix 前缀，各 service 自行拼）。
// 用途：归档选主（当天全局一次）、迁移串行化（避免并发 DDL）。

const POLL_INTERVAL_MS = 500;

/**
 * 尝试获取锁。SET key value EX ttlSec NX —— 原子抢锁。
 * 返回 true 表示抢到，false 表示已被他人持有。
 */
export async function tryAcquireLock(
  key: string,
  value: string,
  ttlSec: number,
): Promise<boolean> {
  const r = getRedis();
  const res = await r.set(key, value, 'EX', ttlSec, 'NX');
  return res === 'OK';
}

/**
 * 释放锁。用 Lua（releaseLock defineCommand）校验 value 再 DEL——若锁已过期被他人
 * 获取，本 pod 不会误删他人的锁。value 必须与 acquire 时一致（podId）。
 */
export async function releaseLock(
  key: string,
  value: string,
): Promise<void> {
  const r = getRedis();
  await r.releaseLock(key, value);
}

/**
 * 等待锁释放（轮询 GET）。用于迁移场景：未抢到锁的 pod 等待持锁者跑完再继续启动。
 * 返回 true 表示锁已释放，false 表示超时仍被持有（调用方按 fail-open 处理）。
 */
export async function waitForLockRelease(
  key: string,
  timeoutMs: number,
): Promise<boolean> {
  const r = getRedis();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await r.get(key);
      if (v === null) return true;
    } catch {
      // Redis 断连无法判断锁状态——返回 false（与超时同处理），让调用方按 fail-open
      // 继续（迁移场景：信任持锁者已应用，drizzle migrate 幂等兜底），而非 reject
      // 冒泡到 main().catch 触发 exit(1)。
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return false;
}
