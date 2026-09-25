import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { clean, logError } from './log';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Returns the trimmed string, or undefined when the value is missing or not a
 * string. Request bodies are untyped JSON, so a field like `{"patientName": 123}`
 * must be treated as "not provided" instead of blowing up on `.trim()`.
 */
export function trimmedString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

/**
 * Express 4 does not catch rejected promises from async handlers, and Node
 * terminates the process on an unhandled rejection. Wrapping every async route
 * turns any unexpected throw into a JSON 500 instead of taking the server down.
 */
export function asyncHandler(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch((err) => {
      // req.path only: the query string is caller-controlled. logError withholds
      // anything that could quote patient data (see log.ts).
      logError(`Unhandled error in ${req.method} ${clean(req.path, 120)}`, err);
      if (res.headersSent) return next(err);
      res.status(500).json({ success: false, error: 'Internal server error.' });
    });
  };
}

/** Turns body-parser failures (malformed / oversized JSON) into JSON errors the UI can display. */
export function jsonErrorHandler(err: any, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);
  const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500;
  const message =
    err?.type === 'entity.too.large'
      ? 'Request body is too large.'
      : err?.type === 'entity.parse.failed'
        ? 'Request body is not valid JSON.'
        : status === 500
          ? 'Internal server error.'
          : 'Bad request.';
  // Never log the error object itself: body-parser errors carry the raw request body.
  if (status === 500) logError('Unhandled error', err);
  return res.status(status).json({ success: false, error: message });
}

/** Always JSON for unknown API routes (instead of Express's HTML 404 page). */
export function apiNotFound(_req: Request, res: Response) {
  res.status(404).json({ success: false, error: 'Not found.' });
}

const isProduction = () => process.env.NODE_ENV === 'production';

/**
 * Baseline hardening headers. The CSP is enforced in production only: the Vite dev
 * server relies on inline scripts and a websocket for hot reload.
 */
export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (isProduction()) {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        // 'unsafe-inline' for styles only: the app has no HTML-injection sinks, and
        // component libraries commonly set inline style attributes.
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
  }
  // API responses contain patient data: keep them out of browser and proxy caches.
  if (req.path.startsWith('/api')) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
}

/**
 * Cross-site request guard for state-changing requests, on top of the SameSite=Strict
 * session cookie: refuse anything a browser says came from another site.
 */
export function crossSiteGuard(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') {
    return res.status(403).json({ success: false, error: 'Cross-site requests are not allowed.' });
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      // unparseable Origin: treated as a mismatch below
    }
    if (originHost !== req.headers.host) {
      return res.status(403).json({ success: false, error: 'Cross-site requests are not allowed.' });
    }
  }
  next();
}
