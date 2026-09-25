/**
 * Shared plumbing for the live test suites (test:api, test:security, test:privacy,
 * test:failsafe): boots a private copy of the real server on its own port, creates a
 * throwaway staff account, and provides a cookie-aware HTTP client.
 *
 * The server is started with GEMINI_API_KEY blank by default, so these suites never
 * spend real AI quota and never send anything to Google.
 */
import 'dotenv/config';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { Pool } from 'pg';
import { generatePassword, hashPassword } from '../../server/lib/auth';

export const RUN_ID = Date.now().toString(36);

export interface Reply {
  status: number;
  text: string;
  json: any;
  headers: Headers;
}

export class Client {
  cookie = '';

  constructor(public base: string) {}

  async request(
    method: string,
    path: string,
    body?: unknown,
    opts: { raw?: string; headers?: Record<string, string>; anonymous?: boolean } = {},
  ): Promise<Reply> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...opts.headers };
    if (this.cookie && !opts.anonymous) headers.Cookie = this.cookie;
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers,
      body: opts.raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON body — leave json null
    }
    return { status: res.status, text, json, headers: res.headers };
  }

  /** Logs in and remembers the session cookie. Returns the raw reply. */
  async login(username: string, password: string): Promise<Reply> {
    const reply = await this.request('POST', '/api/auth/login', { username, password }, { anonymous: true });
    const setCookie = reply.headers.getSetCookie?.() ?? [];
    const session = setCookie.find((c) => c.startsWith('triage_sid='));
    if (reply.status === 200 && session) this.cookie = session.split(';')[0];
    return reply;
  }
}

export interface TestServer {
  base: string;
  /** Everything the server has written to stdout and stderr so far. */
  output(): string;
  stop(): Promise<void>;
}

function killTree(child: ChildProcess) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill('SIGKILL');
}

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const tsxFlag = nodeMajor > 20 || (nodeMajor === 20 && nodeMinor >= 6) ? ['--import', 'tsx'] : ['--loader', 'tsx'];

export async function startServer(port: number, env: Record<string, string> = {}): Promise<TestServer> {
  let buffer = '';
  const child = spawn(process.execPath, [...tsxFlag, 'server/index.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      GEMINI_API_KEY: '', // blank on purpose: no quota spent, nothing sent to Google
      INTAKE_RATE_LIMIT_PER_MINUTE: '100000',
      NODE_NO_WARNINGS: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => (buffer += d));
  child.stderr!.on('data', (d) => (buffer += d));

  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    killTree(child);
    await new Promise((r) => setTimeout(r, 400)); // let the port free up
  };

  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode}):\n${buffer}`);
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return { base, output: () => buffer, stop };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  await stop();
  throw new Error(`server on :${port} did not become healthy in 30s:\n${buffer}`);
}

export function openPool(): Pool {
  return new Pool({ connectionString: process.env.DATABASE_URL });
}

/** Creates a staff account with a known password. Removed again by dropTestUsers(). */
export async function createTestUser(pool: Pool, label: string): Promise<{ username: string; password: string }> {
  const username = `t-${label}-${RUN_ID}`.slice(0, 32).toLowerCase();
  const password = generatePassword();
  await pool.query('INSERT INTO staff_users (username, password_hash) VALUES ($1, $2)', [username, await hashPassword(password)]);
  return { username, password };
}

export async function dropTestUsers(pool: Pool): Promise<void> {
  await pool.query("DELETE FROM staff_users WHERE username LIKE 't-%-" + RUN_ID + "'");
}

// ---------------------------------------------------------------- tiny test runner

export type Kind = 'PASS' | 'FAIL' | 'SKIP';

export class Suite {
  results: { kind: Kind; name: string; detail?: string }[] = [];

  section(title: string) {
    console.log(`\n${title}`);
  }

  skip(why: string): never {
    throw new SkipError(why);
  }

  async check(name: string, fn: () => Promise<void> | void) {
    try {
      await fn();
      this.results.push({ kind: 'PASS', name });
      console.log(`  PASS  ${name}`);
    } catch (err) {
      if (err instanceof SkipError) {
        this.results.push({ kind: 'SKIP', name, detail: err.message });
        console.log(`  SKIP  ${name} — ${err.message}`);
        return;
      }
      const detail = err instanceof Error ? err.message : String(err);
      this.results.push({ kind: 'FAIL', name, detail });
      console.log(`  FAIL  ${name}\n          ${detail}`);
    }
  }

  summary(): number {
    const count = (k: Kind) => this.results.filter((r) => r.kind === k).length;
    console.log(`\n${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped`);
    return count('FAIL') > 0 ? 1 : 0;
  }
}

class SkipError extends Error {}

export function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

export function expectEqual<T>(actual: T, expected: T, what: string) {
  expect(actual === expected, `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
