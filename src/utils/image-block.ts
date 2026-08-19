import type { ImageBlock } from '../types/internal.js';

/**
 * 图片跨族归一化 helper(复刻 sse-parse.ts / headers.ts 抽共享 util 的同款模式)。
 *
 * 客户端三种协议的图片 part 形态各异:
 * - OpenAI Chat Completions: {type:'image_url', image_url:{url}}(url = http 或 data:base64)
 * - OpenAI Responses:        {type:'input_image', image_url:'<string>'}
 * - Anthropic Messages:      {type:'image', source:{type:'base64'|'url', ...}}
 *
 * Internal 用 Anthropic 风格的 {type:'image', source} 承载。此处负责「客户端 URL
 * 字符串 ↔ Internal source」的双向转换,供两路由输入侧(CC/Responses → Internal)
 * 与 OpenAIProvider 输出侧(Internal → Responses input_image)共用,消除三处漂移。
 *
 * 不下载 http URL:网关侧 fetch 成本/失败/阻塞/隐私,且 Anthropic source.type:'url'
 * 与 OpenAI Responses input_image 的 http URL 均由上游原生支持。
 */

const DATA_URL_RE = /^data:([^;]+);base64,(.+)$/;

/** data: URI → {media_type, data};非 base64 data: URI 或非 data: URI 返 null。 */
export function parseDataUrl(url: string): { media_type: string; data: string } | null {
  const m = DATA_URL_RE.exec(url);
  if (!m) return null;
  return { media_type: m[1], data: m[2] };
}

/** 客户端图片 URL(http 或 data:)→ Internal image source。data: 拆 base64,否则 url 形态。 */
export function imageUrlToSource(url: string): ImageBlock['source'] {
  const parsed = parseDataUrl(url);
  if (parsed) return { type: 'base64', media_type: parsed.media_type, data: parsed.data };
  return { type: 'url', url };
}

/** Internal image source → OpenAI input_image 的 image_url 字符串。base64 合 data: URI,url 原样。 */
export function sourceToImageUrl(source: ImageBlock['source']): string {
  if (source.type === 'base64') return `data:${source.media_type};base64,${source.data}`;
  return source.url;
}
