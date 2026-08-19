// DB 列中文注释,供 scripts/apply-comments.ts 注入迁移 SQL 的 COMMENT。
//
// 13 张可查表的列 desc 从 src/agents/query-table-schema.ts 派生 —— 后者是
// query_table 工具与 DB COMMENT 的「共同真相源」(描述最完整、面向分析)。这样
// 「模型在 query_table 里看到的列含义」与「数据库 COMMENT」永远同源:改一处
// (query-table-schema 的 ColumnMeta.desc),工具描述与 DB 注释两处同步。
//
// admin_users 不进查询白名单(password_hash 无分析价值,整表排除更安全),但
// DB 仍需 COMMENT,故在此单独手维护(ADMIN_USER_COMMENTS)。
//
// 维护方式:
//   - 可查表的列 desc → 改 src/agents/query-table-schema.ts 的 ColumnMeta.desc。
//   - admin_users 的列  → 改下方 ADMIN_USER_COMMENTS。
//   - 新增列 → 先改 src/db/schema.ts,再到 query-table-schema.ts 补 ColumnMeta;
//     `pnpm db:gen` 会跑 scripts/check-schema-sync.ts 兜底校验列名一致。
import { QUERYABLE_TABLES } from '../agents/query-table-schema.js';

// 13 张可查表:取 query-table-schema 的 desc(table → {col → desc})。
const derived: Record<string, Record<string, string>> = {};
for (const t of QUERYABLE_TABLES) {
  const cols: Record<string, string> = {};
  for (const c of t.columns) cols[c.name] = c.desc;
  derived[t.name] = cols;
}

// admin_users:不进查询白名单,DB COMMENT 专用。
const ADMIN_USER_COMMENTS: Record<string, string> = {
  id: '主键 ID',
  username: '管理员用户名(唯一)',
  password_hash: '密码哈希(bcrypt)',
  role: '角色(admin / super_admin)',
  status: '状态(active / disabled)',
  last_login_at: '最后登录时间,可空',
  created_at: '创建时间',
  updated_at: '更新时间',
};

export const columnComments: Record<string, Record<string, string>> = {
  ...derived,
  admin_users: ADMIN_USER_COMMENTS,
};
