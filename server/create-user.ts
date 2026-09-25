import 'dotenv/config';

import { ensureSchema, pool } from './db';
import { generatePassword, hashPassword, isValidUsername } from './lib/auth';

// Usage:
//   npm run create-user -- <username>            create a staff account
//   npm run create-user -- <username> --reset    issue a new password for an existing account
//   npm run create-user -- <username> --disable  block an account from signing in
//
// The password is generated for you and printed ONCE; only its scrypt hash is stored.
// Passwords are never accepted as command-line arguments (they would land in shell history).

const args = process.argv.slice(2);
const username = args.find((a) => !a.startsWith('--'))?.toLowerCase();
const reset = args.includes('--reset');
const disable = args.includes('--disable');

async function main() {
  if (!username || !isValidUsername(username)) {
    console.error('Usage: npm run create-user -- <username> [--reset | --disable]');
    console.error('Usernames are 3-32 characters: lowercase letters, digits, dot, dash or underscore, starting with a letter or digit.');
    return 1;
  }

  await ensureSchema();
  const existing = await pool.query('SELECT id FROM staff_users WHERE username = $1', [username]);

  if (disable) {
    if (existing.rowCount === 0) {
      console.error(`No such user: ${username}`);
      return 1;
    }
    await pool.query('UPDATE staff_users SET disabled = true WHERE username = $1', [username]);
    console.log(`Disabled ${username}. Restart the server to end any session they have open.`);
    return 0;
  }

  if (existing.rowCount && !reset) {
    console.error(`User "${username}" already exists. Use --reset to issue a new password.`);
    return 1;
  }

  const password = generatePassword();
  const hash = await hashPassword(password);
  if (existing.rowCount) {
    await pool.query(
      'UPDATE staff_users SET password_hash = $2, disabled = false, password_changed_at = now() WHERE username = $1',
      [username, hash],
    );
  } else {
    await pool.query('INSERT INTO staff_users (username, password_hash) VALUES ($1, $2)', [username, hash]);
  }

  console.log(`${existing.rowCount ? 'Password reset for' : 'Created user'}: ${username}`);
  console.log(`Password (shown once, store it securely): ${password}`);
  return 0;
}

main()
  .then((code) => pool.end().then(() => process.exit(code)))
  .catch(async (err) => {
    console.error('create-user failed:', err instanceof Error ? err.message : err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
