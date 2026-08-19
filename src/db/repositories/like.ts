/**
 * 转义 LIKE 元字符（%、_、\）为字面量，并包成 `%...%` 模糊匹配模式。
 *
 * MySQL LIKE 默认以 `\` 为转义符，无需 ESCAPE 子句。drizzle 的 like() 用参数
 * 绑定（SQL 注入安全），这里的转义只是让用户输入里的 % / _ 作为字面量而非
 * 通配符——否则搜索 "a_b" 会匹配 "a任意b"、搜索 "50%" 会匹配任意以 50 开头的串。
 */
export function likePattern(s: string): string {
  return `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}
