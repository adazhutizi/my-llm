import { z } from 'zod';
import type pino from 'pino';
import { createLogger } from '../utils/logger.js';

// Lazily created: createLogger() requires loadConfig() to have run, and a
// module-level call would break tests that import this module cold.
let logger: pino.Logger | null = null;
function getLogger(): pino.Logger {
  if (!logger) logger = createLogger('model-policy');
  return logger;
}

/**
 * Per-key model policy, stored inside `api_keys.permissions` JSON under the
 * `modelPolicy` key:
 *
 *   { "mode": "allow" | "block" | "all",
 *     "models": ["gpt-4o", ...],            // allow/block list (virtual model ids)
 *     "limits": { "gpt-4o": { "dailyTokens": 10_000_000, "monthlyTokens": null } } }
 *
 * - absent / mode "all" / unparseable  → all models allowed, no per-model limits
 *   (fail-open: malformed data must not lock keys out of the gateway)
 * - mode "allow" → only listed models callable; mode "block" → listed models rejected
 * - limits keys are virtual model ids; a null/absent field inside a limit = no cap.
 *   Limits on models outside an allow list are inert — the allowlist check runs
 *   first and rejects the model before the limit is ever consulted.
 *
 * Matching is on the REQUEST's `body.model` string (the virtual model id the
 * client asked for), not on anything resolved from virtual_models — this
 * deliberately covers the PREFIX_MAP fallback in model-router.ts, where
 * unregistered gpt- / claude- prefixed names still route without a
 * virtual_models row.
 */

const modelLimitSchema = z.object({
  dailyTokens: z.number().int().positive().nullable().optional(),
  monthlyTokens: z.number().int().positive().nullable().optional(),
});

export const ModelPolicySchema = z.object({
  mode: z.enum(['all', 'allow', 'block']),
  models: z.array(z.string().min(1)),
  limits: z.record(z.string().min(1), modelLimitSchema).optional(),
});

export type ModelLimit = z.infer<typeof modelLimitSchema>;
export type ModelPolicy = z.infer<typeof ModelPolicySchema>;

/**
 * Extract a ModelPolicy from an api_keys.permissions value.
 * Returns null when there is no modelPolicy key or the payload fails
 * validation — callers treat null as "unrestricted" so a hand-edited or
 * corrupted permissions JSON degrades to the previous behaviour instead of
 * 403-ing every request.
 */
export function parseModelPolicy(permissions: unknown): ModelPolicy | null {
  if (!permissions || typeof permissions !== 'object') return null;

  const raw = (permissions as Record<string, unknown>).modelPolicy;
  if (raw === undefined || raw === null) return null;

  const parsed = ModelPolicySchema.safeParse(raw);
  if (!parsed.success) {
    getLogger().warn(
      { issues: parsed.error.issues },
      'Invalid modelPolicy in api key permissions — treating key as unrestricted (fail-open)',
    );
    return null;
  }
  return parsed.data;
}

/**
 * Whether a model id passes the policy's allow/block list.
 * null policy and mode "all" allow everything.
 */
export function isModelAllowed(policy: ModelPolicy | null, model: string): boolean {
  if (!policy || policy.mode === 'all') return true;
  if (policy.mode === 'allow') return policy.models.includes(model);
  return !policy.models.includes(model);
}

/**
 * Per-model token limits for a model id, or null when unlimited.
 * A model absent from `limits` (or with only null/absent fields) is unlimited.
 */
export function getModelLimit(policy: ModelPolicy | null, model: string): ModelLimit | null {
  return policy?.limits?.[model] ?? null;
}
