import { configSchema, type Config } from './schema.js';

let config: Config | null = null;

export function loadConfig(): Config {
  if (config) return config;

  const raw = {
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',

    db: {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '3306', 10),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'llm_gateway',
    },

    log: {
      level: process.env.LOG_LEVEL || 'info',
      // Archive params are internal defaults declared in config/schema.ts
      // (log.archive.*) — deliberately not exposed as env vars, so the merge
      // behavior is identical across deployments. Tuning them needs a code
      // change + redeploy.
      archive: {},
    },

    jwt: {
      secret: process.env.JWT_SECRET || '',
      expiresIn: parseInt(process.env.JWT_EXPIRES_IN || '86400', 10),
      renewThreshold: parseInt(process.env.JWT_RENEW_THRESHOLD || '28800', 10),
    },

    redis: {
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      username: process.env.REDIS_USERNAME || '',
      password: process.env.REDIS_PASSWORD || '',
      keyPrefix: process.env.REDIS_KEY_PREFIX || 'llmgw:',
      maxRetriesPerRequest: parseInt(process.env.REDIS_MAX_RETRIES || '1', 10),
      commandTimeoutMs: parseInt(process.env.REDIS_COMMAND_TIMEOUT_MS || '1000', 10),
      connectTimeoutMs: parseInt(process.env.REDIS_CONNECT_TIMEOUT_MS || '2000', 10),
    },
  };

  const result = configSchema.safeParse(raw);

  if (!result.success) {
    console.error('Configuration validation failed:');
    console.error(result.error.format());
    process.exit(1);
  }

  config = result.data;
  return config;
}

export function getConfig(): Config {
  if (!config) {
    throw new Error('Config not loaded. Call loadConfig() first.');
  }
  return config;
}
