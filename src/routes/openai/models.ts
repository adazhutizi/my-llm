import { Hono } from 'hono';
import { eq, and, inArray, notInArray } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { virtualModels } from '../../db/schema.js';
import { parseModelPolicy } from '../../services/model-policy.js';
import type { AuthContext } from '../../middleware/auth.js';
import { Errors, formatOpenAIError } from '../../utils/errors.js';

export const models = new Hono();

const PROVIDER_OWNED_BY: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  dashscope: 'dashscope',
};

models.get('/', async (c) => {
  try {
    const db = getDb();

    // Filter by the key's model policy so clients only see what they can
    // actually call (a listed-but-403 model in /models is a footgun for
    // SDK model-picking). Dedicated keys never reach this route — the
    // dedicated proxy transparently forwards them upstream first.
    const auth = c.get('auth') as AuthContext | undefined;
    const policy = parseModelPolicy(auth?.permissions);

    const conditions = [eq(virtualModels.isActive, true)];
    if (policy?.mode === 'allow') {
      // An empty allowlist allows nothing — skip the query entirely (an
      // IN () with zero values is invalid SQL and semantically empty here).
      if (policy.models.length === 0) {
        return c.json({ object: 'list', data: [] });
      }
      conditions.push(inArray(virtualModels.modelId, policy.models));
    } else if (policy?.mode === 'block' && policy.models.length > 0) {
      conditions.push(notInArray(virtualModels.modelId, policy.models));
    }

    const rows = await db
      .select({
        modelId: virtualModels.modelId,
        provider: virtualModels.provider,
        createdAt: virtualModels.createdAt,
      })
      .from(virtualModels)
      .where(and(...conditions))
      .orderBy(virtualModels.modelId);

    const data = rows.map((row) => ({
      id: row.modelId,
      object: 'model' as const,
      created: Math.floor(new Date(row.createdAt).getTime() / 1000),
      owned_by: PROVIDER_OWNED_BY[row.provider] ?? row.provider,
    }));

    return c.json({ object: 'list', data });
  } catch (err) {
    const error = Errors.internal(
      err instanceof Error ? err.message : 'Failed to list models',
    );
    return c.json(formatOpenAIError(error), 500);
  }
});
