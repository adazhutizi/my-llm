import type { Context } from 'hono';

// ─── 上游请求头大小写保留 helper ─────────────────────────────────────────────
//
// WHATWG Headers(c.req.raw.headers.entries())会把 header 名小写规范化,丢失客户端
// 原始大小写。dedicated 透传与同族 passthrough 发往上游的 header 需保留客户端原始
// 大小写(与 request_details.request_headers 日志存储一致),改写(凭证值 / content-type
// 值)只换值不改 key。三个纯函数:dedicated-proxy.ts 与 passthrough.ts 共用,消除两处
// 漂移——复刻 sse-parse.ts 当初为消除 passthrough/dedicated 两处各自 SSE 解析漂移而
// 抽出的同一模式。

/**
 * 读客户端请求头的 [name, value] 对,保留原始字节大小写。
 *
 * 生产(@hono/node-server):c.env.incoming.rawHeaders(Node IncomingMessage 成对数组,
 * 按字节保留客户端发来的原始大小写)。回退(无 incoming.rawHeaders,如单测 app.request
 * 不注入 c.env.incoming):c.req.raw.headers.entries()(WHATWG Headers,小写)——故单测
 * 里看到小写、生产看到原始大小写是预期。
 */
export function rawHeaderPairs(c: Context): Array<[string, string]> {
  const raw = (c.env as { incoming?: { rawHeaders?: unknown } })?.incoming?.rawHeaders;
  if (Array.isArray(raw)) {
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < raw.length; i += 2) {
      pairs.push([String(raw[i]), String(raw[i + 1])]);
    }
    return pairs;
  }
  return Array.from(c.req.raw.headers.entries());
}

/**
 * 探测客户端凭证 header 的**原样名**:Authorization 优先,无则 x-api-key,都没有返回 null。
 * 返回客户端发来的原样大小写名(如 'Authorization' / 'authorization' / 'X-Api-Key')。
 * 优先级对齐 authMiddleware:同时发 Authorization 与 x-api-key 时 Authorization 赢。
 */
export function detectCredentialName(pairs: Array<[string, string]>): string | null {
  let xApiKey: string | null = null;
  for (const [name] of pairs) {
    const lower = name.toLowerCase();
    if (lower === 'authorization') return name;
    if (lower === 'x-api-key' && xApiKey === null) xApiKey = name;
  }
  return xApiKey;
}

/**
 * 从 header 对构建上游请求头对象:
 * - **保留客户端原始 key 大小写**(pairs 里的 name 原样作 key);
 * - **rewrites 优先于 strip**:rewrites(lowerName → 新 value)命中的 header **只换值,
 *   不改 key**(也不剥离)——凭证(authorization/x-api-key)虽也在 stripNames 里,但应换值
 *   保留客户端原样名,而非剥离;
 * - 未命中 rewrites 但命中 stripNames(小写集合)的 header 剥离(代理 fingerprint /
 *   hop-by-hop / host);
 * - 其余 header 原样保留;
 * - 同名(原样 key 相同)重复时按 ", " append(对齐 WHATWG Headers 语义)。
 *
 * 注:同 header 名、不同大小写重复(如 'Content-Type' 与 'content-type')属病态输入,按
 * 各自原样 key 独立保留——客户端正常不会这么发。
 */
export function buildUpstreamHeaders(
  pairs: Array<[string, string]>,
  stripNames: Set<string>,
  rewrites: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of pairs) {
    const lower = name.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(rewrites, lower)) {
      const rv = rewrites[lower];
      out[name] = name in out ? `${out[name]}, ${rv}` : rv;
    } else if (stripNames.has(lower)) {
      continue;
    } else {
      out[name] = name in out ? `${out[name]}, ${value}` : value;
    }
  }
  return out;
}
