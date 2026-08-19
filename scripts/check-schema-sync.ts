/**
 * 校验 query_table 工具的列白名单(src/agents/query-table-schema.ts)与 drizzle
 * 真实 schema(src/db/schema.ts)的列名一致 —— 防「schema 加了列但忘登记进
 * query_table」导致工具静默查不到新列,或「白名单写了不存在的列」(拼写错 /
 * 引用了已删列)。
 *
 * 由 `pnpm db:gen` 在 generate + apply-comments 之后自动跑:
 *   - 硬错(白名单列不在 schema):process.exit(1),db:gen 失败。
 *   - 软警告(schema 有、白名单没登记):仅打印,可能故意不加(敏感列等)。
 *
 * 用 drizzle 运行时元数据(Columns symbol + 列 .name)读真实列名,不连库。
 */
import { Columns } from 'drizzle-orm';
import { schema } from '../src/db/schema.js';
import { QUERYABLE_TABLES } from '../src/agents/query-table-schema.js';

type ColMap = Record<string, { name: string }>;

// 派生 { DB表名 → Set<DB列名> }。drizzle 表对象经全局 symbol 暴露:Name 取 DB 表名
// (snake_case;注意 schema 的 JS 属性名是 camelCase,如 apiKeys ≠ api_keys,不能
// 直接拿 Object.entries 的键当表名),Columns 取 {属性名 → 列对象}、列对象 .name 是
// DB 列名。(已验证 Columns === Symbol.for('drizzle:Columns')。)TS 无公开类型,经 unknown 取用。
const SCHEMA_NAME = Symbol.for('drizzle:Name');
const schemaCols = new Map<string, Set<string>>();
for (const table of Object.values(schema)) {
  const dbName = (table as unknown as Record<symbol, unknown>)[SCHEMA_NAME] as string | undefined;
  const cols = (table as unknown as Record<typeof Columns, ColMap>)[Columns];
  if (!dbName || !cols) continue;
  schemaCols.set(dbName, new Set(Object.values(cols).map((c) => c.name)));
}

let hardErrors = 0;
const softWarnings: string[] = [];

for (const t of QUERYABLE_TABLES) {
  const sc = schemaCols.get(t.name);
  if (!sc) {
    console.error(`✗ query 白名单表 '${t.name}' 不在 schema.ts`);
    hardErrors++;
    continue;
  }
  for (const c of t.columns) {
    if (!sc.has(c.name)) {
      console.error(
        `✗ ${t.name}.${c.name} 在 query 白名单但不在 schema.ts(拼写错误或列已删除)`,
      );
      hardErrors++;
    }
  }
  // schema 有、白名单没登记 —— 软警告(新增列?敏感列?需人工判断)。
  const declared = new Set(t.columns.map((c) => c.name));
  for (const dbCol of sc) {
    if (!declared.has(dbCol)) softWarnings.push(`${t.name}.${dbCol}`);
  }
}

if (softWarnings.length) {
  console.warn(
    `\n⚠ 以下 schema.ts 列未登记进 query_table 白名单(新增列?若应可查请补到 query-table-schema.ts;敏感 / 无需查询则忽略):`,
  );
  for (const w of softWarnings) console.warn(`  ${w}`);
}

if (hardErrors) {
  console.error(`\n✗ 发现 ${hardErrors} 处列名不一致(hard error)`);
  process.exit(1);
}
console.log('✓ query-table-schema 列名与 schema.ts 一致');
