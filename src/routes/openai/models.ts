import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { virtualModels } from '../../db/schema.js';
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

    const rows = await db
      .select({
        modelId: virtualModels.modelId,
        provider: virtualModels.provider,
        createdAt: virtualModels.createdAt,
      })
      .from(virtualModels)
      .where(eq(virtualModels.isActive, true))
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
