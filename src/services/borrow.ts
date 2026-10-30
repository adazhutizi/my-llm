/**
 * 上游借调（dedicated key 专用）领域逻辑。
 *
 * 场景：某一对一 key 的上游凭证额度耗尽，管理员临时把别的上游 key 借过来用。
 * 借用是 api_keys 上的旁路字段组（borrowed_upstream_key / borrowed_provider_id /
 * borrow_start_at / borrow_expires_at / ...），原 upstream_api_key_enc 永不被
 * 覆盖——到期或手动还原只是清空旁路字段，原凭证零丢失风险。
 *
 * 借用可预约（start_at 在未来）：未到开始时间时请求继续走原凭证；跨过开始
 * 时间自动切到借用；跨过到期时间惰性恢复回原凭证。全程无定时器（多实例下
 * 定时器要抢锁、还有空窗期），生效判定在 authMiddleware 的 dedicated 分支
 * 按请求时刻计算。管理列表展示与 auth 共用同一组纯函数，口径一致。
 */

/** 判定借调状态所需的字段（查询方没有明文 key 时可用布尔哨兵）。 */
export interface BorrowStateFields {
  /** borrowed_upstream_key 是否非空（有明文时传 !!key，列表查询只有布尔时直接传）。 */
  hasBorrowedKey: boolean;
  borrowedProviderId: number | null;
  /** 借用开始时间（null = 立即开始）。 */
  borrowStartAt: Date | null;
  borrowExpiresAt: Date | null;
}

/**
 * 借用生效判定（auth 路由与 admin 列表展示共用的单一真相源）：
 * 有借来的 key + 有借调服务商 + 已到开始时间 + 未到期。
 * start/expires 为 NULL 分别表示「立即开始」与「不限期（直到手动还原）」。
 *
 * 开始时间带 1s 容差：立即开始的借调写入用 DB 的 UTC_TIMESTAMP()，判定用
 * Node 时钟，两者亚秒偏差会让刚设置的借调瞬间显示为「未开始」——1s 内的
 * 未来开始视同已开始（提前 1s 生效无害，本就该生效了）。
 */
export function isBorrowActive(fields: BorrowStateFields, now: Date = new Date()): boolean {
  if (!fields.hasBorrowedKey || fields.borrowedProviderId == null) return false;
  if (fields.borrowStartAt && fields.borrowStartAt.getTime() > now.getTime() + 1000) return false;
  if (fields.borrowExpiresAt && fields.borrowExpiresAt.getTime() <= now.getTime()) return false;
  return true;
}

/**
 * 借用窗口是否已整体过去（到期时间已过）——auth 惰性恢复的清除条件。
 * 刻意与 isBorrowActive 互补区分「未开始」（scheduled）：
 * 未到开始时间的借用**不能**被惰性清除（它还没生效过），请求照常走原凭证。
 */
export function isBorrowExpired(fields: BorrowStateFields, now: Date = new Date()): boolean {
  if (!fields.hasBorrowedKey) return false;
  return fields.borrowExpiresAt != null && fields.borrowExpiresAt.getTime() <= now.getTime();
}
