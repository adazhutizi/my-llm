import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { getConfig } from '../config/index.js';
import * as schema from './schema.js';
import type { Schema } from './schema.js';

let pool: mysql.Pool | null = null;
let db: MySql2Database<Schema> | null = null;

export function initDatabase(): MySql2Database<Schema> {
  if (db) return db;

  const cfg = getConfig().db;

  pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: 10,
    enableKeepAlive: true,
    // Serialize raw Date params (sql-template placeholders) to UTC wall-clock.
    // Only affects `sql\`...\`` values bound as Date; drizzle's timestamp
    // mapToDriverValue already emits UTC literals, so this is belt-and-suspenders
    // for the sql-template path. Must match the UTC session below.
    timezone: '+00:00',
  });

  // Pin every connection's session to UTC. drizzle-orm's mysql2 typeCast forces
  // `field.string()` on all TIMESTAMP/DATETIME/DATE columns (raw server literal;
  // mysql2's timezone option never applies to reads), and mapFromDriverValue
  // parses that literal as UTC (`new Date(value + "+0000")`). So reads are only
  // correct when the server emits UTC literals — i.e. the session is UTC. This
  // also makes writes self-consistent: drizzle mapToDriverValue (toISOString,
  // UTC) and formatUtcDateTime (UTC wall-clock) both bind UTC literals that a
  // UTC session stores verbatim. Fully decoupled from the container/process TZ.
  pool.on('connection', (connection) => {
    // mysql2/promise types tag the 'connection' arg as the promise-style
    // PoolConnection (query() → Promise, no callback overload), but the event
    // actually emits the underlying callback-style connection. Cast to the
    // runtime callback signature so this type-checks without changing behavior.
    (
      connection as unknown as {
        query(sql: string, cb: (err: Error | null) => void): void;
      }
    ).query("SET SESSION time_zone = '+00:00'", (err) => {
      if (err) {
        console.error('[db] SET SESSION time_zone failed:', err.message);
      }
    });
  });

  db = drizzle(pool, { schema, mode: 'default' });
  return db;
}

export function getDb(): MySql2Database<Schema> {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}
