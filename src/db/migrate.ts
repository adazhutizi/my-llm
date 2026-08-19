import { migrate } from 'drizzle-orm/mysql2/migrator';
import { initDatabase, closeDatabase } from './index.js';
import { loadConfig } from '../config/index.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function main() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  loadConfig();

  console.log('Initializing database connection...');
  const db = initDatabase();

  const migrationsFolder = path.resolve(__dirname, 'migrations');
  console.log(`Running migrations from: ${migrationsFolder}`);

  await migrate(db, { migrationsFolder });

  console.log('Migrations complete.');
  await closeDatabase();
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
