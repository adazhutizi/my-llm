import { describe, it, expect } from 'vitest';
import { extractUsage, isAnthropicUsage, mergeStreamUsage } from '../src/services/usage-extract.js';

describe('isAnthropicUsage', () => {
  it('识别带 cache_read_input_tokens 的 Anthropic 形态', () => {
    expect(isAnthropicUsage({ input_tokens: 10, cache_read_input_tokens: 5 })).toBe(true);
  });
  it('识别带 cache_creation_input_tokens 的 Anthropic 形态', () => {
    expect(isAnthropicUsage({ input_tokens: 10, cache_creation_input_tokens: 3 })).toBe(true);
  });
  it('OpenAI 形态(仅 prompt_tokens)判为非 Anthropic', () => {
    expect(isAnthropicUsage({ prompt_tokens: 10, completion_tokens: 5 })).toBe(false);
  });
  it('Responses 形态(input_tokens + input_tokens_details)判为非 Anthropic', () => {
    expect(
      isAnthropicUsage({ input_tokens: 10, input_tokens_details: { cached_tokens: 4 } }),
    ).toBe(false);
  });
});

describe('extractUsage — OpenAI 系(减法拆 cache)', () => {
  it('Chat Completions:cached_tokens 从 prompt 中剥离', () => {
    // gross=100, cached=30 → prompt=70, cacheRead=30
    const r = extractUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 30 },
    });
    expect(r).toEqual({ promptTokens: 70, completionTokens: 50, cacheRead: 30, cacheCreation: 0 });
  });
  it('Responses:input_tokens_details.cached_tokens 从 input 中剥离', () => {
    const r = extractUsage({
      input_tokens: 200,
      output_tokens: 80,
      input_tokens_details: { cached_tokens: 60 },
    });
    expect(r).toEqual({ promptTokens: 140, completionTokens: 80, cacheRead: 60, cacheCreation: 0 });
  });
  it('无 cached_tokens 时 prompt=gross、cacheRead=0', () => {
    const r = extractUsage({ prompt_tokens: 100, completion_tokens: 50 });
    expect(r).toEqual({ promptTokens: 100, completionTokens: 50, cacheRead: 0, cacheCreation: 0 });
  });
  it('全 cache 命中(gross==cached)时 prompt=0、cacheRead=gross', () => {
    const r = extractUsage({
      prompt_tokens: 100,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 100 },
    });
    expect(r.promptTokens).toBe(0);
    expect(r.cacheRead).toBe(100);
  });
});

describe('extractUsage — Anthropic(直取)', () => {
  it('input_tokens 已是非缓存,cache 字段独立', () => {
    const r = extractUsage({
      input_tokens: 70,
      output_tokens: 50,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 12,
    });
    expect(r).toEqual({ promptTokens: 70, completionTokens: 50, cacheRead: 30, cacheCreation: 12 });
  });
  it('仅 cache_read(无 creation)仍判为 Anthropic 形态', () => {
    const r = extractUsage({ input_tokens: 70, output_tokens: 50, cache_read_input_tokens: 30 });
    expect(r).toEqual({ promptTokens: 70, completionTokens: 50, cacheRead: 30, cacheCreation: 0 });
  });
});

describe('extractUsage — 边界', () => {
  it('空 usage 对象返回全 0', () => {
    expect(extractUsage({})).toEqual({ promptTokens: 0, completionTokens: 0, cacheRead: 0, cacheCreation: 0 });
  });
  it('output_tokens 兜底(completion_tokens 缺失)', () => {
    const r = extractUsage({ prompt_tokens: 10, output_tokens: 7 });
    expect(r.completionTokens).toBe(7);
  });
});

describe('mergeStreamUsage — 流式累积', () => {
  it('OpenAI 单 chunk(终态 usage)直接覆盖 accum', () => {
    let accum = { promptTokens: 0, completionTokens: 0, cacheRead: 0, cacheCreation: 0 };
    accum = mergeStreamUsage(
      accum,
      extractUsage({ prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 20 } }),
    );
    expect(accum).toEqual({ promptTokens: 80, completionTokens: 50, cacheRead: 20, cacheCreation: 0 });
  });

  it('Anthropic 分散 chunk:message_start(input+cache) + message_delta(output) 正确拼合', () => {
    let accum = { promptTokens: 0, completionTokens: 0, cacheRead: 0, cacheCreation: 0 };
    // message_start: input 侧 usage
    accum = mergeStreamUsage(
      accum,
      extractUsage({ input_tokens: 70, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 }),
    );
    // message_delta: 仅 output_tokens(无 cache 字段 → 被判为 OpenAI 形态,但 prompt/cacheRead 算出 0 不覆盖)
    accum = mergeStreamUsage(accum, extractUsage({ output_tokens: 50 }));
    expect(accum).toEqual({ promptTokens: 70, completionTokens: 50, cacheRead: 30, cacheCreation: 5 });
  });

  it('0 值不覆盖已累积的非零值', () => {
    let accum = { promptTokens: 100, completionTokens: 50, cacheRead: 30, cacheCreation: 0 };
    accum = mergeStreamUsage(accum, { promptTokens: 0, completionTokens: 0, cacheRead: 0, cacheCreation: 0 });
    expect(accum).toEqual({ promptTokens: 100, completionTokens: 50, cacheRead: 30, cacheCreation: 0 });
  });
});
