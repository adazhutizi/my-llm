// ─────────────────────────────────────────────────────────────────────────────
// 统一的 usage 拆 cache 工具。
//
// 跨 provider 协议族(OpenAI 系 vs Anthropic)的 token usage 字段口径不同,这里
// 按上游返回的 usage 形态分流,提取成网关记账用的四元组(promptTokens /
// completionTokens / cacheRead / cacheCreation),供 dedicated 透传与同族透传
// 旁路共用——避免三处重复实现各自漂移(原先 dedicated-proxy.ts 内联了两份,
// openai.ts splitOpenAIUsage 一份,anthropic.ts 直取一份)。
//
// 两协定差异(与 InternalResponse.usage 的注释口径一致):
// - Anthropic:cache_read/creation_input_tokens 独立于 input_tokens(input 已是
//   非缓存值),直接取。
// - OpenAI 系(Chat Completions 与 Responses):cached_tokens 是 input/prompt 的
//   子集,做减法 prompt = max(0, gross - cached)、cacheRead = cached,避免在
//   配额公式 total = prompt + completion + cacheRead + cacheCreation 下 cache
//   被算两遍。
//
// 形态判定用「usage 对象本身是否带 cache_*_input_tokens 字段」(非 provider 名
// /apiType):透传旁路绑定任意上游,流式 chunk 的 usage 形态可能逐 chunk 不同
// (Anthropic message_start 带 cache 字段、message_delta 只有 output_tokens),
// 按对象形态判定与原 dedicated-proxy 内联逻辑一致。
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtractedUsage {
  promptTokens: number;
  completionTokens: number;
  cacheRead: number;
  cacheCreation: number;
}

/** 判定 usage 是否为 Anthropic 形态(带独立的 cache_*_input_tokens 字段)。 */
export function isAnthropicUsage(usage: Record<string, unknown>): boolean {
  return (
    usage.cache_read_input_tokens !== undefined ||
    usage.cache_creation_input_tokens !== undefined
  );
}

/**
 * 从单个上游 usage 对象提取四元组(缺失字段记 0)。非流式响应直接用本函数;
 * 流式响应每个携带 usage 的 chunk 调一次,再用 {@link mergeStreamUsage} 累积。
 */
export function extractUsage(usage: Record<string, unknown>): ExtractedUsage {
  const completionTokens =
    (usage.completion_tokens ?? usage.output_tokens ?? 0) as number;

  if (isAnthropicUsage(usage)) {
    return {
      promptTokens: (usage.input_tokens ?? 0) as number,
      completionTokens,
      cacheRead: (usage.cache_read_input_tokens ?? 0) as number,
      cacheCreation: (usage.cache_creation_input_tokens ?? 0) as number,
    };
  }

  // OpenAI 系:cached_tokens 是 prompt/input 的子集,做减法拆出。
  const details = (usage.input_tokens_details ??
    usage.prompt_tokens_details) as { cached_tokens?: number } | undefined;
  const cached = details?.cached_tokens ?? 0;
  const gross = (usage.prompt_tokens ?? usage.input_tokens ?? 0) as number;
  return {
    promptTokens: Math.max(0, gross - cached),
    completionTokens,
    cacheRead: cached,
    cacheCreation: 0,
  };
}

/**
 * 流式累积:把单个 chunk 提取出的四元组合并进 accum。
 *
 * 采用「非零覆盖」语义——这与原 dedicated-proxy 流式的 `?? mergedUsage.x`(字段
 * 存在则覆盖)在实际数据流上等价:
 * - OpenAI(Responses/CC):usage 在终态事件一次性出现(单 chunk),直接覆盖。
 * - Anthropic:input 侧 usage 在 message_start、output 侧在 message_delta,分散
 *   到不同 chunk;每字段在它出现的那个 chunk 非零即覆盖,0 不覆盖(保留先前的
 *   非零值),故 input+output 能正确拼合。message_delta 的 usage 无 cache 字段
 *   会被判为 OpenAI 形态,但其 prompt/cacheRead 算出 0,不会污染已累积的 input 侧。
 */
export function mergeStreamUsage(
  accum: ExtractedUsage,
  chunk: ExtractedUsage,
): ExtractedUsage {
  if (chunk.completionTokens) accum.completionTokens = chunk.completionTokens;
  if (chunk.promptTokens) accum.promptTokens = chunk.promptTokens;
  if (chunk.cacheRead) accum.cacheRead = chunk.cacheRead;
  if (chunk.cacheCreation) accum.cacheCreation = chunk.cacheCreation;
  return accum;
}
