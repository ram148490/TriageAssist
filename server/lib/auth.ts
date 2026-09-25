import crypto from 'crypto';
import { promisify } from 'util';

// ---------------------------------------------------------------------------
// Passwords: scrypt (memory-hard, built into Node — no extra dependency).
// Stored as  scrypt$N$r$p$salt$hash  so parameters can be raised later without
// invalidating existing hashes.
// ---------------------------------------------------------------------------

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, N, r, p, saltB64, keyB64] = stored.split('$');
    if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
    const expected = Buffer.from(keyB64, 'base64');
    const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    return false; // malformed hash or out-of-range parameters
  }
}

let dummyHash: Promise<string> | undefined;
/**
 * A real hash to verify against when the username doesn't exist, so a login for an
 * unknown user costs the same time as a wrong password (no user enumeration by timing).
 */
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(crypto.randomBytes(24).toString('base64'));
  return dummyHash;
}

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; // no look-alikes

export function generatePassword(length = 20): string {
  return Array.from({ length }, () => PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)]).join('');
}

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const isValidUsername = (value: string) => USERNAME.test(value);

// ---------------------------------------------------------------------------
// Sessions: server-side, in memory. The cookie holds an opaque random token; only
// its SHA-256 is kept in the map, so a memory/heap dump doesn't yield usable
// tokens. Sessions expire after inactivity (idle) and after a hard maximum age.
// Restarting the server signs everyone out — acceptable, and the safe default.
// ---------------------------------------------------------------------------

export interface SessionUser {
  id: string;
  username: string;
}

interface SessionRecord {
  user: SessionUser;
  createdAt: number;
  lastSeen: number;
}

export interface SessionOptions {
  idleMs: number;
  absoluteMs: number;
  now?: () => number;
}

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export class SessionStore {
  private sessions = new Map<string, SessionRecord>();
  private now: () => number;

  constructor(private opts: SessionOptions) {
    this.now = opts.now ?? Date.now;
  }

  create(user: SessionUser): string {
    this.purgeExpired();
    const token = crypto.randomBytes(32).toString('base64url');
    const t = this.now();
    this.sessions.set(sha256(token), { user, createdAt: t, lastSeen: t });
    return token;
  }

  /** Returns the session's user and refreshes its idle timer, or null if missing/expired. */
  get(token: string | undefined): SessionUser | null {
    if (!token) return null;
    const key = sha256(token);
    const record = this.sessions.get(key);
    if (!record) return null;
    const t = this.now();
    if (t - record.lastSeen > this.opts.idleMs || t - record.createdAt > this.opts.absoluteMs) {
      this.sessions.delete(key);
      return null;
    }
    record.lastSeen = t;
    return record.user;
  }

  destroy(token: string | undefined): void {
    if (token) this.sessions.delete(sha256(token));
  }

  purgeExpired(): void {
    const t = this.now();
    for (const [key, record] of this.sessions) {
      if (t - record.lastSeen > this.opts.idleMs || t - record.createdAt > this.opts.absoluteMs) {
        this.sessions.delete(key);
      }
    }
  }

  get size(): number {
    return this.sessions.size;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (name && !(name in out)) {
      try {
        out[name] = decodeURIComponent(value);
      } catch {
        out[name] = value;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rate limiting: sliding window, in memory. Used for login failures (lock out
// guessing) and for intake submissions (protect the AI quota).
// ---------------------------------------------------------------------------

export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    readonly max: number,
    readonly windowMs: number,
    private now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length) this.hits.set(key, recent);
    else this.hits.delete(key);
    return recent;
  }

  /** Milliseconds until another attempt is allowed, or 0 if the key isn't blocked. */
  blockedFor(key: string): number {
    const recent = this.recent(key);
    if (recent.length < this.max) return 0;
    return Math.max(1, recent[recent.length - this.max] + this.windowMs - this.now());
  }

  hit(key: string): void {
    // Keys can be attacker-chosen (e.g. many distinct usernames), so bound memory.
    if (this.hits.size > 10_000) this.purge();
    const recent = this.recent(key);
    recent.push(this.now());
    this.hits.set(key, recent);
  }

  purge(): void {
    for (const key of [...this.hits.keys()]) this.recent(key);
  }

  clear(key: string): void {
    this.hits.delete(key);
  }

  /** Records an event if allowed. Returns 0 when allowed, otherwise ms until the next slot. */
  consume(key: string): number {
    const wait = this.blockedFor(key);
    if (wait === 0) this.hit(key);
    return wait;
  }
}
