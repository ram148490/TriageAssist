import 'dotenv/config';

import { ensureSchema, pool } from './db';

ensureSchema()
  .then(() => {
    console.log('Schema is up to date.');
    return pool.end();
  })
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
