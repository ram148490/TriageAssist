import { Pool } from 'pg';
import { logError } from './lib/log';
import { SCHEMA_SQL } from './schema';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and configure it.');
}

export const pool = new Pool({
  connectionString,
  // Set DATABASE_SSL=true for any database that isn't on this machine: patient names and phone
  // numbers must not cross a network unencrypted.
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
  // Without these, an unreachable database makes every request wait forever.
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
});

// An idle client that loses its connection (e.g. Postgres restarts) emits 'error'
// on the pool; with no listener Node treats that as fatal and kills the process.
// Log it and carry on: the pool discards the dead client and reconnects on demand.
pool.on('error', (err) => {
  logError('Unexpected error on idle database client', err);
});

// Idempotent: only ever CREATE TABLE/INDEX IF NOT EXISTS. Never mutates existing
// rows, so it is safe to run on every server start.
export async function ensureSchema(): Promise<void> {
  await pool.query(SCHEMA_SQL);
}
