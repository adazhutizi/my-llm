// ─────────────────────────────────────────────────────────────────────────────
// SSE `data:` 行解析(宽松 + 逐行容错)。
//
// 与 BaseProvider.stream() 的行解析口径一致:兼容 `data:` 与 `data: `(带/不带
// 空格——部分兼容服务商如阿里云 DashScope 用无空格 `data:`),逐行 try/catch
// (单行畸形 JSON 不影响其他行;原先外层 catch 会让任一畸形行中断整个循环,
// 漏掉其后的终态 usage 事件),跳过 `[DONE]`。passthrough 与 dedicated 透传的
// finally 全量解析共用本函数——避免各自漂移(原先两者都用严格的
// `startsWith('data: ')`,对无空格上游会漏掉终态 usage → 记账 token 全 0)。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从一段完整 SSE 文本中解析所有 `data:` 行的 JSON payload。
 *
 * 宽松匹配行首(兼容无空格 `data:`);逐行 try/catch(单行畸形 JSON 不阻断后续
 * 行,如终态 usage 事件);跳过 `[DONE]` 与无法解析的行。返回值顺序为文本顺序。
 */
export function parseSSEDataLines(fullText: string): unknown[] {
  const out: unknown[] = [];
  for (const line of fullText.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.startsWith('data: ') ? line.slice(6) : line.slice(5);
    if (data === '[DONE]') continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      // 逐行容错:单行畸形 JSON 不阻断后续行(如终态 usage 事件)。
    }
  }
  return out;
}
