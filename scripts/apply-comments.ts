/**
 * 把 column-comments.ts 里的中文注释,自动注入到 drizzle-kit 刚生成的迁移 SQL。
 *
 * 为什么需要它:drizzle-orm 不支持声明式 column comment(issue #5203),generate
 * 产出的 CREATE TABLE / ALTER 都不带 COMMENT。本脚本在 generate 之后跑一遍,
 * 把 COMMENT 补进去——这样「改 schema.ts + column-comments.ts → db:gen → migrate」
 * 三步就能让新字段自动带中文注释,无需手写 SQL。
 *
 * 覆盖的语句:
 *   - CREATE TABLE `t` (...)                 → 括号内每个列定义注入 COMMENT
 *   - ALTER TABLE `t` ADD|MODIFY `c` ...;    → 列定义末尾注入
 *   - ALTER TABLE `t` CHANGE `o` `n` ...;    → 用新列名查注释后注入
 *   DROP COLUMN / CREATE INDEX / DROP INDEX 等不处理。
 *
 * 解析策略:括号感知(正确处理 enum('a','b')、varchar(100)、decimal(10,2) 内的
 * 逗号与括号)。缺注释的列会报警,便于补齐 column-comments.ts。
 *
 * 用法:
 *   pnpm exec tsx scripts/apply-comments.ts          → 处理 journal 最新迁移并写回
 *   pnpm exec tsx scripts/apply-comments.ts <file>   → dry-run:只打印不写(测试用)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { columnComments } from '../src/db/column-comments.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

interface Report {
  injected: string[];
  missing: string[];
}

/** 从 openPos(指向 `(`) 起扫描,返回匹配的 `)` 位置(平衡括号)。 */
function findMatchingParen(sql: string, openPos: number): number {
  let depth = 0;
  for (let i = openPos; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 按深度 0 的逗号分割(忽略括号内逗号,如 PRIMARY KEY(`a`,`b`))。 */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

/** 处理 CREATE TABLE 括号内的列列表:对每个列定义注入 COMMENT。 */
function injectIntoColsList(
  colsBody: string,
  table: string,
  tableComments: Record<string, string>,
  report: Report,
): string {
  return splitTopLevel(colsBody)
    .map((part) => {
      const m = part.match(/^\s*`(\w+)`/);
      if (!m) return part; // 非列定义(CONSTRAINT/PRIMARY/UNIQUE/KEY/CHECK 等),原样保留
      const col = m[1];
      const c = tableComments[col];
      if (!c) {
        report.missing.push(`${table}.${col}`);
        return part;
      }
      if (/\bCOMMENT\b/i.test(part)) return part; // 已有 COMMENT
      report.injected.push(`${table}.${col}`);
      return part.replace(/\s*$/, '') + ` COMMENT '${c}'`;
    })
    .join(',');
}

function injectComments(sql: string, comments: typeof columnComments, report: Report): string {
  const edits: Array<{ start: number; end: number; replacement: string }> = [];

  // 1) CREATE TABLE `t` ( ... );  —— 平衡括号定位列列表
  const createRe = /CREATE TABLE `(\w+)`\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = createRe.exec(sql)) !== null) {
    const table = m[1];
    const openParen = m.index + m[0].length - 1; // 指向 `(`
    const closeParen = findMatchingParen(sql, openParen);
    if (closeParen === -1) continue;
    const colsBody = sql.slice(openParen + 1, closeParen);
    const newBody = injectIntoColsList(colsBody, table, comments[table] || {}, report);
    if (newBody !== colsBody) {
      edits.push({ start: openParen + 1, end: closeParen, replacement: newBody });
    }
  }

  // 2) ALTER TABLE `t` ADD|MODIFY [`COLUMN`] `c` <def>;
  const alterRe = /ALTER TABLE `(\w+)`\s+(ADD|MODIFY)(?:\s+COLUMN)?\s+`(\w+)`([^;]*);/g;
  while ((m = alterRe.exec(sql)) !== null) {
    const [full, table, kw, col, rest] = m;
    const c = (comments[table] || {})[col];
    if (!c) {
      report.missing.push(`${table}.${col}`);
      continue;
    }
    if (/\bCOMMENT\b/i.test(rest)) continue;
    report.injected.push(`${table}.${col}`);
    edits.push({
      start: m.index,
      end: m.index + full.length,
      replacement: `ALTER TABLE \`${table}\` ${kw} \`${col}\`${rest} COMMENT '${c}';`,
    });
  }

  // 3) ALTER TABLE `t` CHANGE [`COLUMN`] `old` `new` <def>;  —— 用新列名查注释
  const changeRe = /ALTER TABLE `(\w+)`\s+CHANGE(?:\s+COLUMN)?\s+`(\w+)`\s+`(\w+)`([^;]*);/g;
  while ((m = changeRe.exec(sql)) !== null) {
    const [full, table, oldCol, newCol, rest] = m;
    const c = (comments[table] || {})[newCol];
    if (!c) {
      report.missing.push(`${table}.${newCol}`);
      continue;
    }
    if (/\bCOMMENT\b/i.test(rest)) continue;
    report.injected.push(`${table}.${newCol}`);
    edits.push({
      start: m.index,
      end: m.index + full.length,
      replacement: `ALTER TABLE \`${table}\` CHANGE \`${oldCol}\` \`${newCol}\`${rest} COMMENT '${c}';`,
    });
  }

  // 从后往前应用,避免位置偏移
  edits.sort((a, b) => b.start - a.start);
  let result = sql;
  for (const e of edits) {
    result = result.slice(0, e.start) + e.replacement + result.slice(e.end);
  }
  return result;
}

async function main() {
  const arg = process.argv[2];
  const dryRun = Boolean(arg);

  let migrationPath: string;
  if (arg) {
    migrationPath = path.isAbsolute(arg) ? arg : path.resolve(root, arg);
  } else {
    const journalPath = path.join(root, 'src/db/migrations/meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    const latest = journal.entries[journal.entries.length - 1];
    migrationPath = path.join(root, 'src/db/migrations', `${latest.tag}.sql`);
  }

  const sql = readFileSync(migrationPath, 'utf8');
  const report: Report = { injected: [], missing: [] };
  const result = injectComments(sql, columnComments, report);

  if (dryRun) {
    console.log(`[dry-run] ${path.relative(root, migrationPath)} — 注入 ${report.injected.length} 条 COMMENT\n`);
    console.log(result);
  } else {
    writeFileSync(migrationPath, result);
    console.log(`已处理 ${path.relative(root, migrationPath)} — 注入 ${report.injected.length} 条 COMMENT`);
  }
  if (report.missing.length) {
    console.warn(`\n⚠ column-comments.ts 缺以下列的注释(${report.missing.length} 条):`);
    for (const x of report.missing) console.warn(`  ${x}`);
  }
}

main();
