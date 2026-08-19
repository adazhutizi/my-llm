import { describe, it, expect } from 'vitest';
import { estimateTokens, extractTextLength, estimateTokensFromMessages, isTokenGeneratingPath, CHARS_PER_TOKEN } from '../src/utils/token-estimate.js';
import type { ContentBlock, InternalMessage } from '../src/types/internal.js';

describe('estimateTokens', () => {
  it('returns 0 for zero input', () => {
    expect(estimateTokens(0)).toBe(0);
  });

  it('returns 0 for negative input', () => {
    expect(estimateTokens(-5)).toBe(0);
  });

  it('estimates using CHARS_PER_TOKEN ratio', () => {
    expect(estimateTokens(10)).toBe(Math.ceil(10 / CHARS_PER_TOKEN));
  });

  it('returns 1 for 1 character', () => {
    expect(estimateTokens(1)).toBe(1);
  });

  it('handles large inputs', () => {
    expect(estimateTokens(10000)).toBe(Math.ceil(10000 / CHARS_PER_TOKEN));
  });
});

describe('extractTextLength', () => {
  it('returns 0 for empty array', () => {
    expect(extractTextLength([])).toBe(0);
  });

  it('sums text block lengths', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'hello' },
      { type: 'text', text: ' world' },
    ];
    expect(extractTextLength(blocks)).toBe(11);
  });

  it('ignores image blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'hello' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
    ];
    expect(extractTextLength(blocks)).toBe(5);
  });

  it('ignores tool_use blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'result' },
      { type: 'tool_use', id: '1', name: 'fn', input: { a: 1 } },
    ];
    expect(extractTextLength(blocks)).toBe(6);
  });

  it('handles tool_result with string content', () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_result', tool_use_id: '1', content: 'tool output text' },
    ];
    expect(extractTextLength(blocks)).toBe(16);
  });

  it('handles tool_result with ContentBlock[] content', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'tool_result',
        tool_use_id: '1',
        content: [
          { type: 'text', text: 'nested ' },
          { type: 'text', text: 'blocks' },
        ],
      },
    ];
    expect(extractTextLength(blocks)).toBe(13);
  });

  it('handles tool_result with empty string content', () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_result', tool_use_id: '1', content: '' },
    ];
    expect(extractTextLength(blocks)).toBe(0);
  });

  it('handles mixed block types', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'abc' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xxx' } },
      { type: 'text', text: 'def' },
      { type: 'tool_result', tool_use_id: '1', content: 'ghi' },
      { type: 'tool_use', id: '2', name: 'fn', input: {} },
    ];
    expect(extractTextLength(blocks)).toBe(9); // 3 + 3 + 3
  });
});

describe('estimateTokensFromMessages', () => {
  it('returns 0 for empty messages', () => {
    expect(estimateTokensFromMessages([])).toBe(0);
  });

  it('estimates from single user message', () => {
    const messages: InternalMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Hello, how are you?' }] },
    ];
    const chars = 'Hello, how are you?'.length;
    expect(estimateTokensFromMessages(messages)).toBe(Math.ceil(chars / CHARS_PER_TOKEN));
  });

  it('sums across multiple messages', () => {
    const messages: InternalMessage[] = [
      { role: 'system', content: [{ type: 'text', text: 'You are helpful.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Hi!' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] },
    ];
    const chars = 'You are helpful.'.length + 'Hi!'.length + 'Hello!'.length;
    expect(estimateTokensFromMessages(messages)).toBe(Math.ceil(chars / CHARS_PER_TOKEN));
  });

  it('handles messages with mixed block types', () => {
    const messages: InternalMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
        ],
      },
    ];
    const chars = 'describe this'.length;
    expect(estimateTokensFromMessages(messages)).toBe(Math.ceil(chars / CHARS_PER_TOKEN));
  });
});

describe('isTokenGeneratingPath', () => {
  // Generation endpoints → fallback estimation enabled
  it.each([
    '/v1/chat/completions',
    '/openai/v1/chat/completions',
    '/v1/messages',
    '/anthropic/v1/messages',
    '/v1/responses',
    '/openai/v1/responses',
    '/api/anthropic/v1/messages',
  ])('returns true for generation path %s', (path) => {
    expect(isTokenGeneratingPath(path)).toBe(true);
  });

  // Non-generation endpoints → no fallback (only real upstream usage, else 0)
  it.each([
    '/v1/messages/count_tokens',
    '/anthropic/v1/messages/count_tokens',
    '/v1/embeddings',
    '/openai/v1/embeddings',
    '/v1/images/generations',
    '/v1/images/edits',
    '/v1/images/variations',
    '/v1/models',
    '/v1/moderations',
    '/v1/files',
    '/v1/batches',
    '/some/unknown/path',
  ])('returns false for non-generation path %s', (path) => {
    expect(isTokenGeneratingPath(path)).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isTokenGeneratingPath('/V1/Chat/Completions')).toBe(true);
    expect(isTokenGeneratingPath('/V1/Messages/Count_Tokens')).toBe(false);
  });
});
