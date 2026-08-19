import { loadConfig } from '../config/index.js';
import { initDatabase, closeDatabase } from './index.js';
import { createApiKey } from '../services/api-key.js';

async function main() {
  loadConfig();
  initDatabase();

  console.log('Creating admin API key...');
  const result = await createApiKey({
    mode: 'admin',
    name: 'Default Admin Key',
  });

  console.log('Admin API Key created:');
  console.log(`  ${result.plainText}`);
  console.log('');
  console.log('Copy this key and paste it in Settings > Admin API Key');

  await closeDatabase();
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
