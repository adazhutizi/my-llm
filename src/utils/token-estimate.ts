import type { ContentBlock, InternalMessage } from '../types/internal.js';

/** 中文 ~1.5 字符/token，英文 ~4 字符/token，取中间值 2 */
export const CHARS_PER_TOKEN = 2;

/** 字符数 → 近似 token 数 */
export function estimateTokens(charLength: number): number {
  return charLength > 0 ? Math.ceil(charLength / CHARS_PER_TOKEN) : 0;
}

/** 从 ContentBlock[] 中提取文本字符总长度 */
export function extractTextLength(blocks: ContentBlock[]): number {
  let total = 0;
  for (const block of blocks) {
    if (block.type === 'text') {
      total += block.text.length;
    } else if (block.type === 'tool_result') {
      if (typeof block.content === 'string') {
        total += block.content.length;
      } else if (Array.isArray(block.content)) {
        total += extractTextLength(block.content);
      }
    }
  }
  return total;
}

/** 从请求 messages 中估算 prompt tokens */
export function estimateTokensFromMessages(messages: InternalMessage[]): number {
  let totalChars = 0;
  for (const msg of messages) {
    totalChars += extractTextLength(msg.content);
  }
  return estimateTokens(totalChars);
}

/**
 * 从任意请求/响应体估算 token 数 —— dedicated 透传专用 fallback。
 * dedicated 收到的是上游原始格式（Chat Completions `messages` / Responses
 * `input` / Anthropic `messages` / 裸字符串 / embeddings 文本等），无法用固定
 * schema 提取，故递归遍历所有字符串值累加长度。会包含少量非内容字符串
 * （model / role / tool name 等），作为"上游不返回 usage"时的粗估可接受。
 */
export function estimateTokensFromUnknownBody(body: unknown): number {
  if (body == null) return 0;
  let totalChars = 0;
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      totalChars += v.length;
    } else if (Array.isArray(v)) {
      for (const item of v) visit(item);
    } else if (typeof v === 'object') {
      for (const val of Object.values(v as Record<string, unknown>)) visit(val);
    }
  };
  visit(body);
  return estimateTokens(totalChars);
}

/**
 * dedicated 透传可走任意上游路径。token fallback 估算只对"生成类"接口启用；
 * 其余接口（count_tokens / embeddings / images / models / moderations / files /
 * batches …）不参与估算——只取上游真实 usage，无则记 0，避免把请求体/响应体
 * （图片 base64、向量、count_tokens 的 input_tokens 等）错误估算成 token。
 *
 * 白名单策略：只有明确生成类路径才返回 true。dedicated 绑定的小众/变体生成
 * 路径若不在白名单会被记 0（已知 trade-off，换取"非生成类绝不误估"）。匹配
 * 用 includes（非精确等于），兼容 dedicated 的任意路径前缀（/openai/v1/…、
 * /anthropic/v1/…、/v1/…、/api/anthropic/v1/… 等）。
 */
export function isTokenGeneratingPath(path: string): boolean {
  const p = path.toLowerCase();
  // count_tokens 是 Anthropic 预估工具（请求体含 messages 但不生成），优先排除，
  // 否则会被下面的 /messages 分支命中
  if (p.includes('count_tokens')) return false;
  // 生成类：OpenAI Chat Completions / Anthropic Messages / OpenAI Responses
  return (
    p.includes('chat/completions') ||
    p.includes('/messages') || // /v1/messages、/anthropic/v1/messages（count_tokens 已排除）
    p.includes('/responses') // /v1/responses、/openai/v1/responses
  );
}
