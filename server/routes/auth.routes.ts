import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { pool } from '../db';
import {
  getDummyHash,
  parseCookies,
  SessionStore,
  SlidingWindowLimiter,
  verifyPassword,
  type SessionUser,
} from '../lib/auth';
import { asyncHandler } from '../lib/http';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

export const SESSION_COOKIE = 'triage_sid';

const minutes = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return (Number.isFinite(n) && n > 0 ? n : fallback) * 60_000;
};

/** Sign staff out after this long without activity (auto-logoff), and after a hard maximum. */
export const sessions = new SessionStore({
  idleMs: minutes(process.env.SESSION_IDLE_MINUTES, 30),
  absoluteMs: minutes(process.env.SESSION_MAX_HOURS, 12) * 60,
});

// 5 failed attempts per (client, username) and 20 per client, per 15 minutes.
const perAccountFailures = new SlidingWindowLimiter(5, 15 * 60_000);
const perClientFailures = new SlidingWindowLimiter(20, 15 * 60_000);

/** Per-user cap on intake submissions: each one spends AI quota and writes a patient record. */
export const intakeLimiter = new SlidingWindowLimiter(Number(process.env.INTAKE_RATE_LIMIT_PER_MINUTE) || 30, 60_000);

const cookieSecure = () => (process.env.COOKIE_SECURE ?? String(process.env.NODE_ENV === 'production')) === 'true';

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // The queue view polls for new cases. Those requests are marked as background so they
  // don't reset the idle timer (a client that lies about this only shortens its own session).
  const background = req.headers['x-background-poll'] === '1';
  const user = sessions.get(parseCookies(req.headers.cookie)[SESSION_COOKIE], !background);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Authentication required.' });
  }
  req.user = user;
  next();
}

const router = Router();

router.post('/login', asyncHandler(async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  // Bound the work an unauthenticated caller can make us do (scrypt is deliberately slow).
  if (!username || !password || username.length > 64 || password.length > 256) {
    return res.status(400).json({ success: false, error: 'Username and password are required.' });
  }

  const client = req.ip ?? 'unknown';
  const accountKey = `${client}|${username}`;
  const wait = Math.max(perAccountFailures.blockedFor(accountKey), perClientFailures.blockedFor(client));
  if (wait > 0) {
    res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
    return res.status(429).json({ success: false, error: 'Too many failed sign-in attempts. Try again later.' });
  }

  const result = await pool.query('SELECT id, username, password_hash, disabled FROM staff_users WHERE username = $1', [username]);
  const row = result.rows[0];
  // Always run a full scrypt verification, even for unknown users.
  const passwordOk = await verifyPassword(password, row ? row.password_hash : await getDummyHash());

  if (!row || row.disabled || !passwordOk) {
    perAccountFailures.hit(accountKey);
    perClientFailures.hit(client);
    return res.status(401).json({ success: false, error: 'Invalid username or password.' });
  }

  perAccountFailures.clear(accountKey);
  // A new token on every login (no session fixation): drop any session presented with this request.
  sessions.destroy(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  const token = sessions.create({ id: row.id, username: row.username });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, // not readable from JavaScript, so XSS can't steal it
    sameSite: 'strict', // not sent on cross-site requests (CSRF)
    secure: cookieSecure(),
    path: '/',
    // no maxAge: a session cookie, discarded when the browser closes
  });
  return res.json({ success: true, user: { username: row.username } });
}));

router.post('/logout', (req, res) => {
  sessions.destroy(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure: cookieSecure(), path: '/' });
  return res.json({ success: true });
});

router.get('/me', requireAuth, (req, res) => {
  return res.json({ success: true, user: { username: req.user!.username } });
});

export default router;
