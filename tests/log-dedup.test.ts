import { describe, it, expect } from 'vitest';
import {
  stableStringify,
  messageFingerprint,
  fingerprintsOfRequestBody,
  getModelFromBody,
  sessionKeyOf,
  isPrefix,
  planArchive,
  stripCacheControl,
  normalizeContent,
  type ArchivePlanRow,
} from '../src/services/log-dedup.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function row(
  id: number,
  requestId: string,
  apiKeyId: number,
  messages: unknown[],
  createdAt: Date,
): ArchivePlanRow {
  return { id, requestId, apiKeyId, requestBody: { model: 'gpt-4', messages }, createdAt };
}

// Like `row` but for OpenAI Responses API bodies ({ input }) — exercises the
// input-shape fingerprint path. `input` is the Responses item array.
function rowInput(
  id: number,
  requestId: string,
  apiKeyId: number,
  input: unknown[],
  createdAt: Date,
): ArchivePlanRow {
  return { id, requestId, apiKeyId, requestBody: { model: 'gpt-4o', input }, createdAt };
}

const sys = { role: 'system', content: 's' };
const u1 = { role: 'user', content: 'u1' };
const a1 = { role: 'assistant', content: 'a1' };
const u2 = { role: 'user', content: 'u2' };
const a2 = { role: 'assistant', content: 'a2' };
const u3 = { role: 'user', content: 'u3' };

// A cumulative agentic loop: each request's messages is a strict superset.
const m1 = [sys, u1];
const m2 = [sys, u1, a1, u2];
const m3 = [sys, u1, a1, u2, a2, u3];

// ─── stableStringify ─────────────────────────────────────────────────────────

describe('stableStringify', () => {
  it('sorts object keys deterministically', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it('preserves array order', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });
});

// ─── fingerprints ────────────────────────────────────────────────────────────

describe('messageFingerprint', () => {
  it('is stable for identical role+content', () => {
    expect(messageFingerprint({ role: 'user', content: 'hi' }))
      .toBe(messageFingerprint({ role: 'user', content: 'hi' }));
  });
  it('differs when content differs', () => {
    expect(messageFingerprint({ role: 'user', content: 'hi' }))
      .not.toBe(messageFingerprint({ role: 'user', content: 'bye' }));
  });
  it('is stable across key-order churn inside content-block arrays (Anthropic shape)', () => {
    const blkA = messageFingerprint({ role: 'assistant', content: [{ type: 'text', text: 'hello' }] });
    const blkB = messageFingerprint({ role: 'assistant', content: [{ text: 'hello', type: 'text' }] });
    expect(blkA).toBe(blkB);
  });
  it('ignores cache_control breakpoints inside content blocks (Anthropic prompt cache)', () => {
    const withCache = messageFingerprint({
      role: 'user',
      content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
    });
    const noCache = messageFingerprint({
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    });
    expect(withCache).toBe(noCache);
  });
  it('treats a bare-string content and a single text-block array as equal', () => {
    // Anthropic allows content as "s" OR [{type:"text",text:"s"}] — semantically
    // identical. Clients emit both inconsistently within one conversation.
    const asString = messageFingerprint({ role: 'user', content: 'hello' });
    const asBlock = messageFingerprint({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
    expect(asString).toBe(asBlock);
  });
});

describe('fingerprintsOfRequestBody', () => {
  it('returns one fingerprint per message', () => {
    const fps = fingerprintsOfRequestBody({ model: 'gpt-4', messages: m1 });
    expect(fps).toHaveLength(2);
    expect(fps[0]).toBe(messageFingerprint(sys));
  });
  it('returns [] for bodies with no recognizable conversation (embeddings/images/bare-string input)', () => {
    // The Embeddings API also uses { input }, but as bare text / string[] —
    // never item-shaped — so it yields [] and never participates in merging.
    expect(fingerprintsOfRequestBody({ input: 'a plain string' })).toEqual([]);
    expect(fingerprintsOfRequestBody({ input: ['text1', 'text2'] })).toEqual([]);
    expect(fingerprintsOfRequestBody(null)).toEqual([]);
    expect(fingerprintsOfRequestBody('str')).toEqual([]);
    expect(fingerprintsOfRequestBody({})).toEqual([]);
  });
  it('fingerprints an OpenAI Responses API input conversation (path-agnostic)', () => {
    const fps = fingerprintsOfRequestBody({
      model: 'gpt-4o',
      input: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
    });
    expect(fps).toHaveLength(2);
    expect(fps[0]).toBe(messageFingerprint({ role: 'user', content: 'hi' }));
  });
  it('strips call_id and normalizes argument encoding for function_call / function_call_output items', () => {
    // Same logical turn resent with a fresh call_id and arguments flipped
    // between JSON-string and object form must fingerprint identically.
    const a = fingerprintsOfRequestBody({ input: [
      { type: 'function_call', call_id: 'aa', name: 'get_weather', arguments: '{"city":"NYC"}' },
      { type: 'function_call_output', call_id: 'aa', output: 'sunny' },
    ]});
    const b = fingerprintsOfRequestBody({ input: [
      { type: 'function_call', call_id: 'bb', name: 'get_weather', arguments: { city: 'NYC' } },
      { type: 'function_call_output', call_id: 'bb', output: 'sunny' },
    ]});
    expect(a).toEqual(b);
  });
});

describe('stripCacheControl', () => {
  it('removes cache_control at every depth, keeps everything else', () => {
    const input = {
      cache_control: { type: 'ephemeral' },
      keep: 'x',
      nested: [{ cache_control: { type: 'ephemeral' }, v: 1 }],
    };
    expect(stripCacheControl(input)).toEqual({ keep: 'x', nested: [{ v: 1 }] });
  });
  it('leaves primitives and arrays without the key untouched', () => {
    expect(stripCacheControl('s')).toBe('s');
    expect(stripCacheControl(42)).toBe(42);
    expect(stripCacheControl([1, 2])).toEqual([1, 2]);
  });
});

describe('normalizeContent', () => {
  it('collapses a single text-block array to the bare string', () => {
    expect(normalizeContent([{ type: 'text', text: 'hi' }])).toBe('hi');
  });
  it('leaves multi-block arrays unchanged (tool_use/tool_result pairs)', () => {
    const blocks = [
      { type: 'tool_result', tool_use_id: 'x', content: 'r' },
      { type: 'text', text: 't' },
    ];
    expect(normalizeContent(blocks)).toBe(blocks);
  });
  it('passes strings and non-text single blocks through', () => {
    expect(normalizeContent('s')).toBe('s');
    expect(normalizeContent([{ type: 'tool_result', tool_use_id: 'x', content: 'r' }])).toEqual([
      { type: 'tool_result', tool_use_id: 'x', content: 'r' },
    ]);
  });
});

describe('getModelFromBody', () => {
  it('reads the model string when present', () => {
    expect(getModelFromBody({ model: 'gpt-4', messages: [] })).toBe('gpt-4');
  });
  it('returns null when absent or non-string', () => {
    expect(getModelFromBody({ input: 'x' })).toBeNull();
    expect(getModelFromBody({ model: 123 })).toBeNull();
  });
});

// ─── isPrefix ────────────────────────────────────────────────────────────────

describe('isPrefix', () => {
  it('true for a strict prefix', () => {
    expect(isPrefix(['a', 'b'], ['a', 'b', 'c'])).toBe(true);
  });
  it('false when equal length (strict — identical-length peers never supersede)', () => {
    expect(isPrefix(['a', 'b'], ['a', 'b'])).toBe(false);
  });
  it('false when the prefix diverges', () => {
    expect(isPrefix(['a', 'b'], ['a', 'x', 'c'])).toBe(false);
  });
  it('false when a is empty', () => {
    expect(isPrefix([], ['a'])).toBe(false);
  });
  it('false when a is longer than b', () => {
    expect(isPrefix(['a', 'b', 'c'], ['a', 'b'])).toBe(false);
  });
});

// ─── sessionKeyOf ────────────────────────────────────────────────────────────

describe('sessionKeyOf', () => {
  it('encodes apiKey + model + first two fingerprints', () => {
    expect(sessionKeyOf(7, 'gpt-4', ['h1', 'h2', 'h3'])).toBe('7|gpt-4|h1|h2');
  });
  it('pads missing fingerprints with empty string', () => {
    expect(sessionKeyOf(1, 'm', ['h1'])).toBe('1|m|h1|');
    expect(sessionKeyOf(1, 'm', [])).toBe('1|m||');
  });
});

// ─── planArchive ─────────────────────────────────────────────────────────────

describe('planArchive', () => {
  const T30 = 30 * 60_000;

  it('cleans superseded prefixes in a single chain, keeps the tail', () => {
    const rows = [
      row(1, 'r1', 5, m1, new Date(0)),
      row(2, 'r2', 5, m2, new Date(60_000)),
      row(3, 'r3', 5, m3, new Date(120_000)),
    ];
    const clean = planArchive(rows, T30);
    expect(clean).toEqual([
      { id: 1, requestId: 'r1', mergedInto: 'r2' },
      { id: 2, requestId: 'r2', mergedInto: 'r3' },
    ]);
  });

  it('cleans superseded prefixes in a Responses API input chain', () => {
    // The session key anchors on the first two items (developer + first user),
    // so every request in the chain shares it — same rule as `messages` chains
    // anchoring on system + first user. A single-item opener would land in its
    // own cluster and stay unmerged, identical to a single-message Chat
    // Completions opener.
    const dev = { role: 'developer', content: 'sys' };
    const i1 = [dev, { role: 'user', content: 'u1' }];
    const i2 = [dev, { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'u2' }];
    const i3 = [...i2, { role: 'assistant', content: 'a2' }, { role: 'user', content: 'u3' }];
    const rows = [
      rowInput(1, 'p1', 5, i1, new Date(0)),
      rowInput(2, 'p2', 5, i2, new Date(60_000)),
      rowInput(3, 'p3', 5, i3, new Date(120_000)),
    ];
    expect(planArchive(rows, T30)).toEqual([
      { id: 1, requestId: 'p1', mergedInto: 'p2' },
      { id: 2, requestId: 'p2', mergedInto: 'p3' },
    ]);
  });

  it('merges a Responses tool-call chain even when call_id differs per request', () => {
    // The same logical history is resent with a fresh call_id on each turn.
    // Stripping call_id keeps the strict-prefix relation intact.
    const turn = (callId: string) => [
      { role: 'user', content: 'get weather' },
      { type: 'function_call', call_id: callId, name: 'get_weather', arguments: '{"city":"NYC"}' },
      { type: 'function_call_output', call_id: callId, output: 'sunny' },
      { role: 'assistant', content: 'it is sunny' },
    ];
    const rows = [
      rowInput(1, 't1', 5, turn('aa'), new Date(0)),
      rowInput(2, 't2', 5, [...turn('bb'), { role: 'user', content: 'thanks' }], new Date(60_000)),
    ];
    expect(planArchive(rows, T30)).toEqual([{ id: 1, requestId: 't1', mergedInto: 't2' }]);
  });

  it('merges a chain even when cache_control breakpoints hop between requests', () => {
    // Anthropic prompt-cache: the client moves the cache_control marker onto the
    // latest blocks on each request, so the SAME historical message carries the
    // marker in one request and not the next. Without stripping, every prior
    // message would hash differently and merging would collapse to zero
    // (observed on real Claude Code traffic: 0 merged -> 34).
    const text = (t: string, cached = false) =>
      cached
        ? { type: 'text', text: t, cache_control: { type: 'ephemeral' } }
        : { type: 'text', text: t };
    const sysC = { role: 'system', content: 's' };
    const rows = [
      // req1: cache on u1
      row(1, 'c1', 5, [sysC, { role: 'user', content: [text('u1', true)] }], new Date(0)),
      // req2: cache moved to u2; u1 no longer carries the marker
      row(
        2,
        'c2',
        5,
        [sysC, { role: 'user', content: [text('u1')] }, { role: 'assistant', content: 'a1' }, { role: 'user', content: [text('u2', true)] }],
        new Date(60_000),
      ),
      // req3: cache moved to u3
      row(
        3,
        'c3',
        5,
        [
          sysC,
          { role: 'user', content: [text('u1')] },
          { role: 'assistant', content: 'a1' },
          { role: 'user', content: [text('u2')] },
          { role: 'assistant', content: 'a2' },
          { role: 'user', content: [text('u3', true)] },
        ],
        new Date(120_000),
      ),
    ];
    const clean = planArchive(rows, T30);
    expect(clean).toEqual([
      { id: 1, requestId: 'c1', mergedInto: 'c2' },
      { id: 2, requestId: 'c2', mergedInto: 'c3' },
    ]);
  });

  it('merges a chain when the same user turn flips between string and block content', () => {
    // The same user message is sent as a bare string in one request and a
    // single text-block array in the next — a real inconsistency in the wild
    // (Anthropic permits both forms). Normalization must treat them as equal.
    const rows = [
      row(1, 's1', 5, [sys, { role: 'user', content: 'do it' }], new Date(0)),
      row(
        2,
        's2',
        5,
        [
          sys,
          { role: 'user', content: [{ type: 'text', text: 'do it' }] },
          { role: 'assistant', content: 'ok' },
        ],
        new Date(60_000),
      ),
    ];
    expect(planArchive(rows, T30)).toEqual([{ id: 1, requestId: 's1', mergedInto: 's2' }]);
  });

  it('keeps an independent request whose prefix does not match', () => {
    const mIndep = [sys, { role: 'user', content: 'totally-different' }];
    const rows = [
      row(1, 'r1', 5, m1, new Date(0)),
      row(2, 'r2', 5, m2, new Date(60_000)),
      row(3, 'r3', 5, m3, new Date(120_000)),
      row(4, 'r4', 5, mIndep, new Date(180_000)),
    ];
    const clean = planArchive(rows, T30);
    expect(clean.map((c) => c.id).sort()).toEqual([1, 2]);
    expect(clean.find((c) => c.id === 4)).toBeUndefined();
  });

  it('isolates parallel loops on the same key+model (interleaved in time)', () => {
    // Two independent sessions A and B; their first two messages differ.
    const aSys = { role: 'system', content: 'a-sys' };
    const aU1 = { role: 'user', content: 'a-u1' };
    const aA1 = { role: 'assistant', content: 'a-a1' };
    const aU2 = { role: 'user', content: 'a-u2' };
    const bSys = { role: 'system', content: 'b-sys' };
    const bU1 = { role: 'user', content: 'b-u1' };
    const bA1 = { role: 'assistant', content: 'b-a1' };
    const mA1 = [aSys, aU1];
    const mA2 = [aSys, aU1, aA1, aU2];
    const mA3 = [aSys, aU1, aA1, aU2, { role: 'assistant', content: 'a-a2' }, { role: 'user', content: 'a-u3' }];
    const mB1 = [bSys, bU1];
    const mB2 = [bSys, bU1, bA1, { role: 'user', content: 'b-u2' }];

    // Times interleaved across the two sessions.
    const rows = [
      row(1, 'A1', 9, mA1, new Date(0)),
      row(2, 'B1', 9, mB1, new Date(60_000)),
      row(3, 'A2', 9, mA2, new Date(120_000)),
      row(4, 'B2', 9, mB2, new Date(180_000)),
      row(5, 'A3', 9, mA3, new Date(240_000)),
    ];
    const clean = planArchive(rows, T30);

    // A merges within itself, B merges within itself.
    const cleanMap = new Map(clean.map((c) => [c.id, c.mergedInto]));
    expect(cleanMap.get(1)).toBe('A2'); // A1 → A2
    expect(cleanMap.get(3)).toBe('A3'); // A2 → A3
    expect(cleanMap.get(2)).toBe('B2'); // B1 → B2
    expect(cleanMap.has(5)).toBe(false); // A3 tail kept
    expect(cleanMap.has(4)).toBe(false); // B2 tail kept

    // No cross-session merge: every A target is an A requestId and vice versa.
    const aIds = new Set(['A1', 'A2', 'A3']);
    const bIds = new Set(['B1', 'B2']);
    for (const c of clean) {
      const srcIsA = aIds.has(c.requestId);
      const dstIsA = aIds.has(c.mergedInto);
      expect(srcIsA).toBe(dstIsA); // never crosses
      expect(bIds.has(c.requestId)).toBe(bIds.has(c.mergedInto));
    }
  });

  it('does NOT merge when sessions collide on the first two messages but diverge later', () => {
    // Degenerate: same system + same first user, but the assistant turns differ.
    // They land in the same cluster (identical session key) yet neither is a
    // prefix of the other (equal length, divergent content).
    const sharedSys = { role: 'system', content: 'shared' };
    const sharedU1 = { role: 'user', content: 'first' };
    const rows = [
      row(1, 'X1', 5, [sharedSys, sharedU1, { role: 'assistant', content: 'turn-A' }], new Date(0)),
      row(2, 'Y1', 5, [sharedSys, sharedU1, { role: 'assistant', content: 'turn-B' }], new Date(60_000)),
    ];
    const clean = planArchive(rows, T30);
    expect(clean).toEqual([]);
  });

  it('still cleans a true prefix even when a divergent peer shares the cluster', () => {
    // X1 and Y1 share the first two messages (same cluster key) and are the
    // same length, so neither is a prefix of the other — they diverge at the
    // 3rd message. X1 is nonetheless a true prefix of X2 and must be cleaned.
    const sharedSys = { role: 'system', content: 'shared' };
    const sharedU1 = { role: 'user', content: 'first' };
    const rows = [
      row(1, 'X1', 5, [sharedSys, sharedU1, { role: 'assistant', content: 'x-a1' }], new Date(0)),
      row(2, 'Y1', 5, [sharedSys, sharedU1, { role: 'assistant', content: 'other' }], new Date(60_000)),
      row(3, 'X2', 5, [sharedSys, sharedU1, { role: 'assistant', content: 'x-a1' }, { role: 'user', content: 'x-u2' }], new Date(120_000)),
    ];
    const clean = planArchive(rows, T30);
    // X1 → X2 (true prefix); Y1 diverges at index 2, so it is neither a prefix
    // of X2 nor superseded by X1 — it is kept.
    expect(clean).toEqual([{ id: 1, requestId: 'X1', mergedInto: 'X2' }]);
  });

  it('does not merge across the session-timeout window', () => {
    const rows = [
      row(1, 'r1', 5, m1, new Date(0)),
      row(2, 'r2', 5, m2, new Date(40 * 60_000)), // 40min > 30min window
    ];
    expect(planArchive(rows, T30)).toEqual([]);
  });

  it('ignores rows without messages', () => {
    const rows: ArchivePlanRow[] = [
      { id: 1, requestId: 'e1', apiKeyId: 5, requestBody: { input: 'vec' }, createdAt: new Date(0) },
      row(2, 'r2', 5, m2, new Date(60_000)),
    ];
    expect(planArchive(rows, T30)).toEqual([]);
  });
});
