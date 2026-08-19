// Redis Lua 脚本（在服务端原子执行）。通过 ioredis defineCommand 注册为命名命令
// （rateLimit / quotaIncr / releaseLock），自动 evalsha + eval fallback。

// 令牌桶：一次处理 qps + rpm 两个桶（numberOfKeys=2）。原子读-改-写，避免多 pod 并发
// 丢更新。语义与原进程内 TokenBucket 一致：每桶有 capacity 上限 + 按 refill 持续补充。
// KEYS[1]=qps桶 KEYS[2]=rpm桶
// ARGV[1]=now(ms) ARGV[2]=qpsCap ARGV[3]=qpsRefill(每秒) ARGV[4]=rpmCap ARGV[5]=rpmRefill(每秒)
export const RATE_LIMIT_LUA = `
local now = tonumber(ARGV[1])
local function consume(key, capacity, refill)
  local data = redis.call('HMGET', key, 'tokens', 'last')
  local tokens = tonumber(data[1]) or capacity
  local last = tonumber(data[2]) or now
  local elapsed = math.max(0, now - last) / 1000.0
  tokens = math.min(capacity, tokens + elapsed * refill)
  if tokens < 1 then return 0 end
  tokens = tokens - 1
  redis.call('HMSET', key, 'tokens', tokens, 'last', now)
  redis.call('PEXPIRE', key, 7200000)
  return 1
end
if consume(KEYS[1], tonumber(ARGV[2]), tonumber(ARGV[3])) == 0 then return 0 end
return consume(KEYS[2], tonumber(ARGV[4]), tonumber(ARGV[5]))
`;

// 配额缓存原子累加（numberOfKeys=1）。entry 不存在则 no-op——与原进程内
// incrementQuotaCache 语义一致（仅在已有缓存项时递增，miss 时由预检侧查 DB 重建）。
// KEYS[1]=quota key ARGV[1]=tokens ARGV[2]=ttlSec
export const QUOTA_INCR_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
local obj = cjson.decode(cur)
obj.dailyUsed = obj.dailyUsed + tonumber(ARGV[1])
obj.monthlyUsed = obj.monthlyUsed + tonumber(ARGV[1])
redis.call('SET', KEYS[1], cjson.encode(obj), 'EX', tonumber(ARGV[2]))
return 1
`;

// 释放锁（numberOfKeys=1）：校验 value 再 DEL，防止误删别人的锁（锁过期后被他人获取）。
// KEYS[1]=lock key ARGV[1]=value
export const RELEASE_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;
