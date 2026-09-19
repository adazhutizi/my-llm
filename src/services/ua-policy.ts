import { z } from 'zod';
import type pino from 'pino';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { uaPolicies } from '../db/schema.js';
import { getRedis } from '../redis/index.js';
import { getConfig } from '../config/index.js';
import { createLogger } from '../utils/logger.js';

// ─── UA (User-Agent) allow/block lists ────────────────────────────────────────
//
// Four levels (global / user / app / api_key), one row each in `ua_policies`
// keyed by (target_type, target_id). Levels STACK (see evaluateUaPolicies):
//   - block: a match at ANY level denies the request;
//   - allow: a level with an allow list requires the UA to match it.
// So allow lists only tighten and block lists only add — a global allow list
// and a key-level block list can coexist.
//
// Hot-path cost contract (performance red line):
//   1 Redis MGET for all levels (5s TTL config cache, "no row" cached as a
//   null sentinel) + 1 Map lookup (compiled-regex cache) + N regex tests.
//   A deployment with no policies configured adds ~1 MGET of null sentinels.

// Lazily created: createLogger() requires loadConfig() to have run, and a
// module-level call would break tests that import this module cold (same as
// model-policy.ts).
let logger: pino.Logger | null = null;
function getLogger(): pino.Logger {
  if (!logger) logger = createLogger('ua-policy');
  return logger;
}

export type UaTargetType = 'global' | 'app' | 'user' | 'api_key';

export interface UaPolicyTarget {
  type: UaTargetType;
  id: number | null;
}

export const UaPolicySchema = z.object({
  mode: z.enum(['block', 'allow']),
  patterns: z.array(z.string().min(1).max(512)).max(100),
});

export type UaPolicy = z.infer<typeof UaPolicySchema>;

// Cached shape: just the business fields (no timestamps — Date doesn't
// round-trip through JSON and no consumer reads them), mirroring
// CachedRateLimitRow in quota-cache.ts.
export interface CachedUaPolicyRow {
  mode: 'block' | 'allow';
  patterns: string[];
}

/**
 * Parse a stored policy (DB row fields or a hand-edited value) into a
 * UaPolicy. Returns null when absent/malformed — callers treat null as
 * "no restriction" so corrupted data degrades to the previous behaviour
 * instead of 403-ing every request (fail-open, same philosophy as
 * parseModelPolicy).
 */
export function parseUaPolicy(value: unknown): UaPolicy | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = UaPolicySchema.safeParse(value);
  if (!parsed.success) {
    getLogger().warn(
      { issues: parsed.error.issues },
      'Invalid UA policy row — treating target as unrestricted (fail-open)',
    );
    return null;
  }
  return parsed.data;
}

// ─── Config cache (Redis, 5s TTL, null sentinel — mirrors quota-cache.ts) ────

const UA_CACHE_TTL_SEC = 5;

function prefixed(key: string): string {
  // Manual prefix (NOT ioredis keyPrefix) so all gateway services share one
  // namespace — same rationale as quota-cache.ts.
  return `${getConfig().redis.keyPrefix}${key}`;
}

export function uaPolicyCacheKey(type: UaTargetType, id: number | null): string {
  return `ua:cfg:${type}:${id ?? 'global'}`;
}

/**
 * Load the policies for a request's target set in ONE Redis MGET round trip.
 * Misses (and "no row" null sentinels — the overwhelmingly common case, most
 * targets have no policy) are backfilled from the DB with point queries that
 * hit the UNIQUE (target_type, target_id) index.
 *
 * Fail-open on BOTH layers:
 *   - Redis error → fall back to direct DB queries (same as getRateLimitConfigCache);
 *   - DB error → that level is treated as having no policy (logged). Unlike
 *     quotaCheck (which 500s when it can't read usage), "can't read the UA
 *     policy" means "act as if there is none" — consistent with the rate
 *     limiter's fail-open philosophy.
 *
 * Returns an array aligned with `targets` (same order): UaPolicy | null.
 */
export async function getUaPoliciesForRequest(
  targets: readonly UaPolicyTarget[],
): Promise<Array<UaPolicy | null>> {
  const keys = targets.map((t) => uaPolicyCacheKey(t.type, t.id));

  // Layer 1: one MGET for every level. On Redis failure treat ALL as misses.
  let cached: Array<string | null> = new Array(keys.length).fill(null);
  try {
    cached = await getRedis().mget(...keys.map(prefixed));
  } catch {
    // fail-open → DB below
  }

  const results: Array<UaPolicy | null> = new Array(targets.length).fill(null);
  const misses: number[] = [];

  for (let i = 0; i < keys.length; i++) {
    const raw = cached[i];
    if (raw === null || raw === undefined) {
      misses.push(i); // key absent → genuine miss → DB
      continue;
    }
    // Hit: JSON 'null' string = cached "no policy" sentinel.
    if (raw === 'null') continue;
    // Defensive light check (values were validated before caching); a
    // corrupted entry degrades to a miss instead of poisoning requests.
    try {
      const obj = JSON.parse(raw) as CachedUaPolicyRow;
      if (
        (obj.mode === 'block' || obj.mode === 'allow') &&
        Array.isArray(obj.patterns)
      ) {
        results[i] = obj as UaPolicy;
      } else {
        misses.push(i);
      }
    } catch {
      misses.push(i);
    }
  }

  if (misses.length > 0) {
    const rows = await Promise.all(
      misses.map(async (i) => {
        const t = targets[i];
        try {
          const [row] = await getDb()
            .select({ mode: uaPolicies.mode, patterns: uaPolicies.patterns })
            .from(uaPolicies)
            .where(
              t.id !== null
                ? and(eq(uaPolicies.targetType, t.type), eq(uaPolicies.targetId, t.id))
                : and(eq(uaPolicies.targetType, t.type), sql`${uaPolicies.targetId} IS NULL`),
            )
            .limit(1);
          return { index: i, row: row ?? null };
        } catch (err) {
          // DB failure → treat this level as unrestricted, but make it loud.
          getLogger().error(
            { err, type: t.type, id: t.id },
            'UA policy DB query failed — treating level as unrestricted (fail-open)',
          );
          return { index: i, row: null };
        }
      }),
    );

    await Promise.all(
      rows.map(async ({ index, row }) => {
        // parseUaPolicy fail-opens malformed rows (hand-edited DB) to null.
        const policy = row ? parseUaPolicy({ mode: row.mode, patterns: row.patterns }) : null;
        results[index] = policy;
        // Backfill the cache INCLUDING the null sentinel — "no policy" is the
        // common case and caching the absence is where the savings are.
        try {
          await getRedis().set(
            prefixed(keys[index]),
            policy ? JSON.stringify({ mode: policy.mode, patterns: policy.patterns }) : 'null',
            'EX',
            UA_CACHE_TTL_SEC,
          );
        } catch {
          // fail-open: a write failure just means the next read misses and
          // re-queries the DB. Swallow.
        }
      }),
    );
  }

  return results;
}

/**
 * Drop the cached config row so admin PUT/DELETE changes apply on the very
 * next request instead of after the 5s TTL.
 */
export async function invalidateUaPolicyConfig(
  type: UaTargetType,
  id: number | null,
): Promise<void> {
  try {
    await getRedis().del(prefixed(uaPolicyCacheKey(type, id)));
  } catch {
    // fail-open: entry self-expires via TTL anyway
  }
}

// ─── Compiled-regex cache (per-process, simple LRU) ───────────────────────────
//
// Key is the WHOLE patterns array joined with a NUL byte (String.fromCharCode(0)
// — a byte that cannot be typed into the admin textarea, so distinct arrays
// can't collide; a plain ' ' join WOULD: ['a b','c'] vs ['a','b c']), value the
// pre-compiled RegExp[] — one Map lookup per request instead of one compile
// per pattern. Entry count is bounded by the number of distinct policies
// (global 1 + one per user/app/key), so a 4096 cap is effectively
// unreachable; on hit we delete+set to approximate LRU.

const REGEX_CACHE_LIMIT = 4096;
const regexCache = new Map<string, RegExp[]>();

export function compilePolicyRegexes(patterns: readonly string[]): RegExp[] {
  const key = patterns.join(String.fromCharCode(0));
  const hit = regexCache.get(key);
  if (hit) {
    // refresh recency
    regexCache.delete(key);
    regexCache.set(key, hit);
    return hit;
  }

  const compiled: RegExp[] = [];
  for (const p of patterns) {
    try {
      // 'i' only: UA matching is case-insensitive (design decision). No 'g'
      // flag → no lastIndex state, safe to reuse across requests.
      compiled.push(new RegExp(p, 'i'));
    } catch {
      getLogger().warn({ pattern: p }, 'Uncompilable UA pattern skipped (fail-open)');
    }
  }

  if (regexCache.size >= REGEX_CACHE_LIMIT) {
    // evict the oldest insertion (Map preserves insertion order)
    const oldest = regexCache.keys().next().value;
    if (oldest !== undefined) regexCache.delete(oldest);
  }
  regexCache.set(key, compiled);
  return compiled;
}

// ─── Evaluation (pure functions — the stacked semantics table) ────────────────
//
// Per level:  'deny'    → this level rejects the request
//             'pass'    → this level explicitly accepts it
//             'neutral' → this level doesn't care
// | level state                | block (deny-list) | allow (allow-list) |
// | no row / malformed         | neutral           | neutral           |
// | patterns = []              | neutral           | deny (all)        |
// | UA matches some pattern    | deny              | pass              |
// | UA matches none            | neutral           | deny              |
//
// Composition: ANY deny → reject. (Deny is checked first at every level, so
// evaluation order doesn't matter; we short-circuit on the first deny.)

export interface UaDenyReason {
  level: UaTargetType;
  mode: 'block' | 'allow';
  pattern?: string; // the matched pattern (block mode only)
}

export function evaluateUaPolicies(
  levels: ReadonlyArray<{ target: UaPolicyTarget; policy: UaPolicy | null }>,
  ua: string,
): { allowed: boolean; reason?: UaDenyReason } {
  for (const { target, policy } of levels) {
    if (!policy) continue; // neutral: no row / malformed (fail-open)

    if (policy.patterns.length === 0) {
      // block + empty = denies nothing; allow + empty = allows nothing.
      // (Write-side PUT rejects allow+empty, so this is only reachable via
      // direct DB edits — keep the defensive semantics anyway.)
      if (policy.mode === 'allow') {
        return { allowed: false, reason: { level: target.type, mode: 'allow' } };
      }
      continue;
    }

    const regexes = compilePolicyRegexes(policy.patterns);
    const matchedIdx = regexes.findIndex((r) => r.test(ua));

    if (policy.mode === 'block') {
      if (matchedIdx >= 0) {
        return {
          allowed: false,
          reason: { level: target.type, mode: 'block', pattern: policy.patterns[matchedIdx] },
        };
      }
      continue; // neutral
    }

    // allow: must match
    if (matchedIdx < 0) {
      return { allowed: false, reason: { level: target.type, mode: 'allow' } };
    }
    // matched → this level passes; other levels still get a say
  }
  return { allowed: true };
}

// ─── Pattern safety check (ReDoS guard, enforced on the admin PUT path) ───────
//
// The main defense runs at SAVE time — runtime only truncates the UA to 512
// chars to bound backtracking input. Heuristics prefer false rejects over
// catastrophic backtracking (`(a+)+` class): a nested quantifier (a group
// followed by a quantifier whose body itself contains a quantifier) is
// rejected. Deliberately conservative for an admin-only config surface.

const MAX_PATTERN_LENGTH = 512;
const MAX_PATTERN_COUNT = 100;
const MAX_GROUP_DEPTH = 10;
const MAX_QUANTIFIER_CHARS = 32;

/**
 * Validate one pattern. Returns an error message (Chinese, surfaced verbatim
 * to the admin) or null when acceptable.
 */
export function checkUaPatternSafety(pattern: string): string | null {
  if (pattern.length === 0) return '正则为空字符串（匹配一切，禁止配置）';
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return `正则长度 ${pattern.length} 超过上限 ${MAX_PATTERN_LENGTH} 字符`;
  }
  try {
    new RegExp(pattern, 'i');
  } catch (err) {
    return `正则语法错误: ${(err as Error).message}`;
  }

  // Single scan: track group depth, quantifier count, character classes
  // (brackets don't open groups), and group bodies containing quantifiers.
  let depth = 0;
  let quantifiers = 0;
  let inClass = false; // inside [...]
  // Stack per open group: whether its body contains a quantifier char.
  const groupHasQuantifier: boolean[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      i++; // skip the escaped character
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue; // chars inside a class never open groups or count as quantifiers
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '(') {
      depth++;
      groupHasQuantifier.push(false);
      if (depth > MAX_GROUP_DEPTH) {
        return `括号嵌套深度超过 ${MAX_GROUP_DEPTH}`;
      }
      continue;
    }
    if (ch === ')') {
      const hadQuantifier = groupHasQuantifier.pop() ?? false;
      depth--;
      // Is this closing group immediately followed by a quantifier?
      const next = pattern[i + 1];
      if (hadQuantifier && next !== undefined && (next === '*' || next === '+' || next === '{')) {
        return '嵌套量词（分组内含量词且分组本身带量词，存在灾难性回溯风险，请改写）';
      }
      continue;
    }
    if (ch === '*' || ch === '+' || ch === '{') {
      quantifiers++;
      if (quantifiers > MAX_QUANTIFIER_CHARS) {
        return `量词数量 ${quantifiers} 超过上限 ${MAX_QUANTIFIER_CHARS}`;
      }
      if (groupHasQuantifier.length > 0) {
        groupHasQuantifier[groupHasQuantifier.length - 1] = true;
      }
    }
  }
  return null;
}

export const UA_LIMITS = {
  maxPatternLength: MAX_PATTERN_LENGTH,
  maxPatternCount: MAX_PATTERN_COUNT,
} as const;
