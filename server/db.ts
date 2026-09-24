import { Pool } from 'pg';
import { SCHEMA_SQL } from './schema';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and configure it.');
}

export const pool = new Pool({ connectionString });

// Idempotent: only ever CREATE TABLE/INDEX IF NOT EXISTS. Never mutates existing
// rows, so it is safe to run on every server start.
export async function ensureSchema(): Promise<void> {
  await pool.query(SCHEMA_SQL);
}
