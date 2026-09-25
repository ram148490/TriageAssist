// Server logging that cannot leak patient data.
//
// Error objects are dangerous to log verbatim in this app:
//  - Postgres errors carry the offending row in `.detail` (patient name, phone).
//  - JSON.parse SyntaxErrors quote a snippet of the text they failed to parse
//    (a request body or the model's output, either of which can echo the
//    patient's symptom text).
//  - Body-parser errors carry the raw request body in `.body`.
// So we log a fixed, sanitized summary: error class, code, and message only where
// the message is known to be free of caller-supplied content.

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Strips control characters (log forging) and caps the length. */
export function clean(value: string, max = 300): string {
  return value.replace(CONTROL, ' ').slice(0, max);
}

export function safeErrorSummary(err: unknown): string {
  if (err instanceof SyntaxError) return 'SyntaxError (message withheld: it may quote the input)';
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return clean(`${err.name}${typeof code === 'string' ? ` [${code}]` : ''}: ${err.message}`);
  }
  return 'non-Error value thrown';
}

export function logError(context: string, err: unknown): void {
  console.error(`${context}: ${safeErrorSummary(err)}`);
}
