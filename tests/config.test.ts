import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('Config', () => {
  beforeEach(() => {
    // Reset module cache to allow re-importing config
    vi.resetModules();
    process.env.DB_PASSWORD = 'test';
    process.env.JWT_SECRET = 'a'.repeat(16);
  });

  it('should load valid config', async () => {
    const { loadConfig } = await import('../src/config/index.js');
    const config = loadConfig();
    expect(config.port).toBe(3000);
    expect(config.db.host).toBe('localhost');
    expect(config.redis.url).toBe('redis://localhost:6379');
    expect(config.redis.keyPrefix).toBe('llmgw:');
  });

  it('should use custom port from env', async () => {
    process.env.PORT = '8080';
    const { loadConfig } = await import('../src/config/index.js');
    const config = loadConfig();
    expect(config.port).toBe(8080);
  });

});
