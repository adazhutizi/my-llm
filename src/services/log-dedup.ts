import { createHash } from 'node:crypto';

// ─── Log archive dedup primitives ────────────────────────────────────────────
//
// Agentic tools (Claude Code / Cursor) drive a conversation in a loop: each
// request's `messages` array accumulates the prior turns, so request N's body
// is a strict superset of request 1..N-1. We detect that "superset" relation
// via a fingerprint sequence prefix check, then keep only the tail (most
// complete) request_details row per session and null the big fields of the
// superseded prefixes. These are pure, DB-free helpers so the logic is unit
// testable in isolation. See plans/fizzy-painting-rabin.md.

/** Deterministic JSON: object keys sorted, arrays ordered. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') +
    '}'
  );
}

/** sha256 hex digest of a string. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export interface MessageLike {
  role?: unknown;
  content?: unknown;
}

/**
 * Fingerprint a single message from its `{ role, content }` pair. Both string
 * content (OpenAI) and content-block arrays (Anthropic) hash stably because
 * stableStringify recurses deterministically.
 */
/**
 * Recursively drop `cache_control` keys. Anthropic prompt-caching breakpoints
 * (`cache_control: { type: "ephemeral" }`) attach to content blocks (and
 * sometimes the message itself), and the client rebalances their position on
 * every request as the conversation grows. They carry no semantic content, so
 * the archive fingerprint ignores them — otherwise the same message hashes
 * differently across requests and the strict-prefix check stops merging the
 * whole chain (observed: a 35-step agentic chain merged 0 rows with the marker
 * vs 34 once stripped).
 */
export function stripCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCacheControl);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src)) {
      if (k === 'cache_control') continue;
      out[k] = stripCacheControl(src[k]);
    }
    return out;
  }
  return value;
}

/**
 * Collapse a single-element `[{ type: "text", text: T }]` content-block array
 * to the bare string `T`. Anthropic's Messages API accepts a message's
 * `content` as either a string or an array of content blocks, and the two
 * forms are semantically identical. Clients/translation layers in the wild
 * emit both inconsistently within one conversation (observed: the same user
 * turn serialized as a string in one request and a single-block array in the
 * next), which otherwise breaks the strict-prefix check. Multi-block arrays
 * and non-text blocks (tool_use/tool_result) pass through unchanged.
 */
export function normalizeContent(content: unknown): unknown {
  if (Array.isArray(content) && content.length === 1) {
    const b = content[0];
    if (
      b !== null &&
      typeof b === 'object' &&
      !Array.isArray(b) &&
      (b as { type?: unknown }).type === 'text' &&
      typeof (b as { text?: unknown }).text === 'string'
    ) {
      return (b as { text: string }).text;
    }
  }
  return content;
}

export function messageFingerprint(msg: MessageLike): string {
  const stripped = stripCacheControl({ role: msg.role, content: msg.content }) as MessageLike;
  return sha256Hex(stableStringify({ role: stripped.role, content: normalizeContent(stripped.content) }));
}

/** Extract the model string from a parsed request body, if present. */
export function getModelFromBody(body: unknown): string | null {
  if (body && typeof body === 'object') {
    const m = (body as { model?: unknown }).model;
    if (typeof m === 'string') return m;
  }
  return null;
}

/**
 * Fingerprint sequence for a request body's conversation. Recognizes two shapes:
 *   • Chat Completions / Anthropic Messages → body.messages
 *   • OpenAI Responses API                  → body.input (item array)
 * Returns [] for anything else (embeddings/images, bare-string input) — such
 * rows never participate in merging and are kept as-is.
 *
 * Detection is by content, not request path: the dedicated proxy lets a key
 * send a Responses-shaped body to any URL, and the merge scan only ever sees
 * the stored request_body. The Embeddings API also uses { input }, but its
 * input is a bare string / string[] of texts to vectorize, never item-shaped;
 * fingerprintsOfResponsesItems skips non-item elements, so embeddings input
 * yields [] and never participates in merging (and couldn't form a cumulative
 * prefix chain regardless).
 */
export function fingerprintsOfRequestBody(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];

  const messages = (body as { messages?: unknown }).messages;
  if (Array.isArray(messages)) {
    return messages.map((m) => messageFingerprint(m as MessageLike));
  }

  const input = (body as { input?: unknown }).input;
  if (Array.isArray(input)) {
    return fingerprintsOfResponsesItems(input);
  }

  return [];
}

/**
 * Fingerprint an OpenAI Responses API `input` item array. Each item becomes one
 * fingerprint so the existing strict-prefix check (isPrefix) collapses an
 * agentic loop's resent history exactly like a `messages` chain.
 *
 * Volatile identifiers a client may regenerate per request (call_id on
 * function_call / function_call_output; id/seq on reasoning items) are stripped
 * — same rationale as stripCacheControl for Anthropic: without it the same
 * logical turn hashes differently across requests and the prefix chain breaks.
 */
function fingerprintsOfResponsesItems(items: unknown[]): string[] {
  const fps: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue; // strings = embeddings texts
    const it = item as Record<string, unknown>;

    // Message: {role, content} (EasyInputMessage) or {type:'message', role, content}
    if (it.role !== undefined && it.content !== undefined) {
      fps.push(messageFingerprint({ role: it.role, content: it.content }));
      continue;
    }
    // function_call: {type:'function_call', name, arguments} — strip call_id,
    // normalize arguments (JSON string vs object, key-order churn).
    if (it.type === 'function_call') {
      fps.push(sha256Hex(stableStringify({
        type: 'function_call',
        name: it.name,
        arguments: normalizeJsonLike(it.arguments),
      })));
      continue;
    }
    // function_call_output: {type:'function_call_output', output} — strip call_id.
    if (it.type === 'function_call_output') {
      fps.push(sha256Hex(stableStringify({
        type: 'function_call_output',
        output: normalizeJsonLike(it.output),
      })));
      continue;
    }
    // Other typed items (reasoning, computer_call, …): whole-item fingerprint
    // minus volatile ids so a resent turn matches itself.
    if (typeof it.type === 'string') {
      fps.push(sha256Hex(stableStringify(stripVolatileIds(it))));
    }
    // Unknown object shape — skip rather than risk an unstable fingerprint.
  }
  return fps;
}

/** Parse a JSON string so stableStringify normalizes key order; pass through anything else. */
function normalizeJsonLike(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value; // plain text (not JSON) — keep verbatim
    }
  }
  return value;
}

const VOLATILE_ID_KEYS = new Set(['call_id', 'id', 'seq']);
/** Drop top-level volatile identifiers (call_id/id/seq) from a Responses item. */
function stripVolatileIds(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(item)) {
    if (!VOLATILE_ID_KEYS.has(k)) out[k] = item[k];
  }
  return out;
}

/**
 * Session cluster key isolates parallel loops on the same key+model so the
 * O(n²) prefix scan stays within a single conversation. The first two
 * messages are the stable session anchor (OpenAI: system + first user;
 * Anthropic: first two users) — different parallel loops differ there and
 * land in different groups. Correctness does NOT depend on clustering: even
 * if two sessions collide into one group, isPrefix() compares actual content
 * and will not merge them unless one is a true prefix of the other.
 */
export function sessionKeyOf(
  apiKeyId: number | null | undefined,
  model: string | null | undefined,
  fps: string[],
): string {
  const fp0 = fps[0] ?? '';
  const fp1 = fps[1] ?? '';
  return `${apiKeyId ?? ''}|${model ?? ''}|${fp0}|${fp1}`;
}

/**
 * Strict prefix: `a` is a non-empty strict prefix of `b` (a shorter than b,
 * every element matching). Equal-length sequences are NOT prefixes — a
 * request never supersedes an identical-length peer.
 */
export function isPrefix(a: string[], b: string[]): boolean {
  if (a.length === 0 || a.length >= b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ─── Session merge planning ───────────────────────────────────────────────────
//
// Pure core of the archive run: given a batch of request_details rows, decide
// which are superseded (their big fields should be nulled) and which successor
// each points at. Extracted from runLogArchive so the merge logic is unit
// testable without a database. See plans/fizzy-painting-rabin.md.

export interface ArchivePlanRow {
  id: number;
  requestId: string;
  apiKeyId: number;
  requestBody: unknown;
  createdAt: Date;
}

export interface ArchiveCleanTarget {
  id: number;
  requestId: string;
  mergedInto: string;
}

/**
 * Cluster rows by session (apiKey + model + first-two-message fingerprints),
 * then within each cluster mark a row X as superseded when a strictly-later
 * row Y within the session-timeout window has X's fingerprint sequence as a
 * strict prefix. X points at the earliest such Y. Rows without messages are
 * ignored (kept as-is).
 */
export function planArchive(
  rows: ArchivePlanRow[],
  sessionTimeoutMs: number,
): ArchiveCleanTarget[] {
  type Prepared = ArchivePlanRow & { fps: string[]; sessionKey: string };
  const prepared: Prepared[] = [];
  for (const row of rows) {
    const fps = fingerprintsOfRequestBody(row.requestBody);
    if (fps.length === 0) continue;
    const model = getModelFromBody(row.requestBody);
    prepared.push({ ...row, fps, sessionKey: sessionKeyOf(row.apiKeyId, model, fps) });
  }

  const groups = new Map<string, Prepared[]>();
  for (const row of prepared) {
    const arr = groups.get(row.sessionKey);
    if (arr) arr.push(row);
    else groups.set(row.sessionKey, [row]);
  }

  const toClean: ArchiveCleanTarget[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (let i = 0; i < group.length; i++) {
      const x = group[i];
      const xTime = x.createdAt.getTime();
      for (let j = i + 1; j < group.length; j++) {
        const y = group[j];
        if (y.createdAt.getTime() - xTime > sessionTimeoutMs) break; // past window; later rows are later still
        if (isPrefix(x.fps, y.fps)) {
          toClean.push({ id: x.id, requestId: x.requestId, mergedInto: y.requestId });
          break; // earliest successor wins; x is settled
        }
      }
    }
  }
  return toClean;
}
