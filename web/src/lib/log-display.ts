// 日志详情展示层的脱敏/图片提取 helper。
//
// 背景：/openai/v1/images/generations 的响应含 b64_json（单张 1~3MB base64），
// CC 请求体也可能内联 data: URI 图片。直接 JSON.stringify 塞进 <pre break-all>
// 会让浏览器对几百万字符做逐字符断行 layout，页面冻结表现为「一片空白」。
// 存储（request_details 大字段）保持完整不动 —— 这里只处理展示层。

/** 超过该长度的字符串在 <pre> 展示时替换为前缀 + 省略提示 */
const LONG_STRING_LIMIT = 4000;

/**
 * 递归替换展示 JSON 中的超长字符串（base64 图片、内联 data: URI、超大 chunk 等）。
 * 返回新对象，不修改入参。提示文案带总长度，方便判断内容规模。
 */
export function redactForDisplay(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length <= LONG_STRING_LIMIT) return value;
    return `${value.slice(0, LONG_STRING_LIMIT)}…[超长字符串已省略，共 ${value.length.toLocaleString()} 字符]`;
  }
  if (Array.isArray(value)) return value.map(redactForDisplay);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactForDisplay(v);
    }
    return out;
  }
  return value;
}

/**
 * 从 OpenAI images 响应（{ data: [{ b64_json | url }] }）提取可渲染的图片 src。
 * 命中时返回 data URI / 上游 URL 列表；非 images 结构返回 []（防御性解析，
 * 不假设字段形状）。b64_json 按魔术字节嗅探 MIME，嗅探不出默认 png
 * （浏览器图片解码器对 data URI 声明的 MIME 与实际不符时仍能 sniff，兜底安全）。
 */
export function extractImageSrcs(body: unknown): string[] {
  if (body === null || typeof body !== 'object') return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const srcs: string[] = [];
  for (const item of data) {
    if (item === null || typeof item !== 'object') continue;
    const { b64_json: b64, url } = item as { b64_json?: unknown; url?: unknown };
    if (typeof b64 === 'string' && b64.length > 0) {
      srcs.push(`data:${sniffImageMime(b64)};base64,${b64}`);
    } else if (typeof url === 'string' && url.length > 0) {
      srcs.push(url);
    }
  }
  return srcs;
}

/** base64 魔术字节嗅探：JPEG(FD8FF)→/9j/、PNG(89504E47)→iVBOR、WebP(RIFF)→UklGR */
function sniffImageMime(b64: string): string {
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('iVBOR')) return 'image/png';
  if (b64.startsWith('UklGR')) return 'image/webp';
  return 'image/png';
}
