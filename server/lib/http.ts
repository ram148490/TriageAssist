import type { NextFunction, Request, RequestHandler, Response } from 'express';

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
      console.error(`Unhandled error in ${req.method} ${req.originalUrl}:`, err);
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
  if (status === 500) console.error('Unhandled error:', err);
  return res.status(status).json({ success: false, error: message });
}
