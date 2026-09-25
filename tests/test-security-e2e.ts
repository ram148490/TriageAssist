/**
 * Security end-to-end checks against real server processes started by this script
 * (ports 3103, 3113, 3123; override the base with E2E_PORT). Needs Postgres. Gemini is
 * disabled, so no AI quota is used.
 *
 *   npm run test:security
 *
 * Covers: authentication is actually enforced on every data endpoint (not just hidden
 * from the nav) and anonymous calls have no side effects; session lifecycle; login
 * hardening and lockout; identity can't be forged into the audit trail; cross-site
 * requests; input limits; response headers; network exposure; intake rate limiting.
 */
import os from 'os';
import {
  Client,
  createTestUser,
  dropTestUsers,
  expect,
  expectEqual,
  openPool,
  RUN_ID,
  startServer,
  Suite,
} from './helpers/harness';

const BASE_PORT = Number(process.env.E2E_PORT ?? 3103);
const suite = new Suite();
const { check, section } = { check: suite.check.bind(suite), section: suite.section.bind(suite) };

const validIntake = (label: string) => ({
  patientName: `SEC-TEST ${label} ${RUN_ID}`,
  symptomText: 'mild headache since this morning',
});
const validOverride = { newUrgencyLevel: 'low', newDepartment: 'Minor Illness', reason: 'security test' };
const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000';

async function main() {
  const pool = openPool();
  const servers: Awaited<ReturnType<typeof startServer>>[] = [];
  let code = 1;
  try {
    const main = await startServer(BASE_PORT, {});
    servers.push(main);
    console.log(`TriageAssist security checks → ${main.base}  (run ${RUN_ID})`);

    const alice = await createTestUser(pool, 'alice');
    const bob = await createTestUser(pool, 'bob');
    const victim = await createTestUser(pool, 'lockme');
    const c = new Client(main.base); // signed in as alice
    expectEqual((await c.login(alice.username, alice.password)).status, 200, 'setup login');

    // A patient record for the anonymous attacker to go after.
    // Inserted straight into the database (not through the API) so these checks don't depend on
    // the API being correctly protected in order to set up.
    const target = (
      await pool.query(
        `INSERT INTO intake_submissions
           (patient_name, urgency_level, suggested_department, confidence_score, needs_human_review, final_urgency_level, final_department)
         VALUES ($1, 'high', 'General Urgent Care', 0, true, 'high', 'General Urgent Care')
         RETURNING id`,
        [`SEC-TEST target ${RUN_ID}`],
      )
    ).rows[0] as { id: string };
    const anon = new Client(main.base); // never logged in

    // ------------------------------------------------------------------ authentication is enforced
    section('Authentication is enforced on every data endpoint (anonymous = no cookie at all)');
    const endpoints: [string, string, unknown?][] = [
      ['GET', '/api/queue'],
      ['GET', `/api/queue/${target.id}`],
      ['GET', `/api/queue/${UNKNOWN_UUID}`],
      ['GET', '/api/queue/not-a-uuid'],
      ['POST', '/api/intake', validIntake('anon')],
      ['POST', `/api/queue/${target.id}/confirm`, {}],
      ['POST', `/api/queue/${target.id}/override`, validOverride],
      ['POST', `/api/queue/${UNKNOWN_UUID}/override`, validOverride],
      ['GET', '/api/auth/me'],
      ['GET', '/api/does-not-exist'],
      ['PUT', `/api/queue/${target.id}`, {}],
      ['DELETE', `/api/queue/${target.id}`],
    ];
    for (const [method, path, body] of endpoints) {
      await check(`${method} ${path.replace(target.id, ':id')} → 401 with no data`, async () => {
        const r = await anon.request(method, path, body);
        expectEqual(r.status, 401, 'status');
        expectEqual(r.json?.success, false, 'success flag');
        expect(!/patientName|contactPhone|SEC-TEST/.test(r.text), 'a 401 body must not contain patient data');
      });
    }

    await check('anonymous calls had no side effects (record untouched, nothing created)', async () => {
      const detail = (await c.request('GET', `/api/queue/${target.id}`)).json.detail;
      expectEqual(detail.submission.reviewStatus, 'pending', 'reviewStatus');
      expectEqual(detail.submission.finalUrgencyLevel, detail.submission.urgencyLevel, 'urgency unchanged');
      expectEqual(detail.overrideLogs.length, 0, 'override logs');
      const n = await pool.query("SELECT count(*)::int AS n FROM intake_submissions WHERE patient_name LIKE $1", [`SEC-TEST anon %${RUN_ID}`]);
      expectEqual(n.rows[0].n, 0, 'rows created by the anonymous POST /api/intake');
    });

    section('Credentials that are not a valid session are rejected');
    const bad: [string, Record<string, string>][] = [
      ['random session cookie', { Cookie: 'triage_sid=' + 'A'.repeat(43) }],
      ['empty session cookie', { Cookie: 'triage_sid=' }],
      ['another cookie name', { Cookie: 'session=' + c.cookie.split('=')[1] }],
      ['Authorization: Bearer <session token>', { Authorization: 'Bearer ' + c.cookie.split('=')[1] }],
      ['Authorization: Basic', { Authorization: 'Basic ' + Buffer.from('admin:admin').toString('base64') }],
      ['X-User / X-Forwarded-User / X-Role headers', { 'X-User': 'admin', 'X-Forwarded-User': 'admin', 'X-Role': 'admin' }],
      ['SQL in the cookie', { Cookie: "triage_sid=' OR '1'='1" }],
    ];
    for (const [label, headers] of bad) {
      await check(`${label} → 401`, async () => {
        const r = await anon.request('GET', '/api/queue', undefined, { headers });
        expectEqual(r.status, 401, 'status');
      });
    }
    await check('a valid session works (control)', async () => {
      expectEqual((await c.request('GET', '/api/queue')).status, 200, 'status');
    });

    await check('the app shell is public but contains no patient data; /api/health is minimal', async () => {
      const page = await anon.request('GET', '/');
      expect(!/SEC-TEST|patientName/.test(page.text), 'page must not embed patient data');
      const h = await anon.request('GET', '/api/health');
      expectEqual(h.status, 200, 'health status');
      expectEqual(JSON.stringify(h.json), '{"status":"ok"}', 'health body reveals nothing else');
    });

    // ------------------------------------------------------------------ login
    section('Login');
    const cookieHeader = async (client: Client, u: { username: string; password: string }) => {
      const r = await client.request('POST', '/api/auth/login', { username: u.username, password: u.password }, { anonymous: true });
      return { r, setCookie: (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('triage_sid=')) ?? '' };
    };

    await check('session cookie is HttpOnly, SameSite=Strict, Path=/, and not persistent', async () => {
      const { r, setCookie } = await cookieHeader(new Client(main.base), bob);
      expectEqual(r.status, 200, 'status');
      expect(/;\s*HttpOnly/i.test(setCookie), `HttpOnly missing: ${setCookie.replace(/=[^;]+/, '=<token>')}`);
      expect(/;\s*SameSite=Strict/i.test(setCookie), 'SameSite=Strict missing');
      expect(/;\s*Path=\//i.test(setCookie), 'Path=/ missing');
      expect(!/;\s*(Max-Age|Expires)=/i.test(setCookie), 'must be a session cookie (no Max-Age/Expires)');
      expect(!r.text.includes(setCookie.split(';')[0].split('=')[1]), 'the token must not appear in the response body');
      expectEqual(JSON.stringify(r.json.user), JSON.stringify({ username: bob.username }), 'response reveals only the username');
      expect(!/password|hash/i.test(r.text), 'no password/hash material in the response');
    });

    await check('wrong password and unknown user get the same generic 401', async () => {
      const wrong = await new Client(main.base).login(alice.username, 'not-the-password');
      const unknown = await new Client(main.base).login(`nobody-${RUN_ID}`, 'not-the-password');
      expectEqual(wrong.status, 401, 'wrong-password status');
      expectEqual(unknown.status, 401, 'unknown-user status');
      expectEqual(wrong.text, unknown.text, 'response bodies must be identical (no user enumeration)');
    });

    for (const [label, body] of [
      ['missing fields', {}],
      ['non-string username', { username: 123, password: 'x' }],
      ['non-string password', { username: 'alice', password: { $ne: null } }],
      ['array username', { username: ['a'], password: 'x' }],
      ['300-character password (bounds scrypt work)', { username: 'alice', password: 'p'.repeat(300) }],
      ['100-character username', { username: 'u'.repeat(100), password: 'x' }],
    ] as [string, unknown][]) {
      await check(`login with ${label} → 400, no crash`, async () => {
        const r = await anon.request('POST', '/api/auth/login', body);
        expectEqual(r.status, 400, 'status');
      });
    }

    await check("SQL injection in the username doesn't log in", async () => {
      for (const u of ["' OR '1'='1", "admin'--", "alice' OR username='alice", '" OR ""="']) {
        const r = await anon.request('POST', '/api/auth/login', { username: u, password: "' OR '1'='1" });
        expect(r.status === 401 || r.status === 400, `"${u}" got ${r.status}`);
        expect(!r.headers.getSetCookie?.().some((x) => x.startsWith('triage_sid=')), 'no session may be issued');
      }
      expectEqual((await c.request('GET', '/api/queue')).status, 200, 'server and data still fine');
    });

    section('Session lifecycle');
    await check('logging in again issues a new token and retires the presented one (no fixation)', async () => {
      const a = new Client(main.base);
      await a.login(bob.username, bob.password);
      const oldCookie = a.cookie;
      const relogin = await a.request('POST', '/api/auth/login', { username: bob.username, password: bob.password });
      expectEqual(relogin.status, 200, 're-login status');
      const newCookie = relogin.headers.getSetCookie().find((x) => x.startsWith('triage_sid='))!.split(';')[0];
      expect(newCookie !== oldCookie, 'token must change on login');
      const stale = new Client(main.base);
      stale.cookie = oldCookie;
      expectEqual((await stale.request('GET', '/api/auth/me')).status, 401, 'the old token');
    });

    await check('logout ends the session server-side and clears the cookie', async () => {
      const a = new Client(main.base);
      await a.login(bob.username, bob.password);
      expectEqual((await a.request('GET', '/api/queue')).status, 200, 'before logout');
      const saved = a.cookie;
      const out = await a.request('POST', '/api/auth/logout', {});
      expectEqual(out.status, 200, 'logout status');
      expect(/triage_sid=;/.test(out.headers.getSetCookie().join('\n')), 'cookie should be cleared');
      const replay = new Client(main.base);
      replay.cookie = saved; // an attacker replaying the captured token after logout
      expectEqual((await replay.request('GET', '/api/queue')).status, 401, 'replayed token after logout');
    });

    await check('sessions are independent per user', async () => {
      const a = new Client(main.base);
      const b = new Client(main.base);
      await a.login(alice.username, alice.password);
      await b.login(bob.username, bob.password);
      expectEqual((await a.request('GET', '/api/auth/me')).json.user.username, alice.username, 'alice');
      expectEqual((await b.request('GET', '/api/auth/me')).json.user.username, bob.username, 'bob');
    });

    // ------------------------------------------------------------------ identity
    section('The audit trail cannot be forged');
    await check('reviewer/overrider names in the request body are ignored', async () => {
      const s = (await c.request('POST', '/api/intake', validIntake('forge'))).json.submission;
      const o = await c.request('POST', `/api/queue/${s.id}/override`, {
        ...validOverride,
        overriddenBy: 'Dr. Sarah Chen, MD',
        confirmedBy: 'Dr. Sarah Chen, MD',
        reviewedBy: 'Dr. Sarah Chen, MD',
        username: 'Dr. Sarah Chen, MD',
        user: { username: 'Dr. Sarah Chen, MD' },
      });
      expectEqual(o.status, 200, 'status');
      const d = (await c.request('GET', `/api/queue/${s.id}`)).json.detail;
      expectEqual(d.overrideLogs[0].overriddenBy, alice.username, 'audit log identity');
      expectEqual(d.submission.reviewedBy, alice.username, 'reviewedBy');
      expect(!JSON.stringify(d).includes('Sarah Chen'), 'the forged name appears nowhere');
    });

    // ------------------------------------------------------------------ cross-site
    section('Cross-site requests (CSRF), even with a valid session cookie');
    const forged: [string, string, Record<string, string>, unknown?][] = [
      ['confirm from another origin', `/api/queue/${target.id}/confirm`, { Origin: 'https://evil.example' }, {}],
      ['override from another origin', `/api/queue/${target.id}/override`, { Origin: 'https://evil.example' }, validOverride],
      ['intake from another origin', '/api/intake', { Origin: 'https://evil.example' }, validIntake('csrf')],
      ['a text/plain "simple request" from another origin', `/api/queue/${target.id}/confirm`, { Origin: 'https://evil.example', 'Content-Type': 'text/plain' }, {}],
      ['a sandboxed-iframe (Origin: null) request', `/api/queue/${target.id}/confirm`, { Origin: 'null' }, {}],
      ['a request the browser marks Sec-Fetch-Site: cross-site', `/api/queue/${target.id}/confirm`, { 'Sec-Fetch-Site': 'cross-site' }, {}],
      ['login from another origin (login CSRF)', '/api/auth/login', { Origin: 'https://evil.example' }, { username: bob.username, password: bob.password }],
    ];
    for (const [label, path, headers, body] of forged) {
      await check(`${label} → 403`, async () => {
        const r = await c.request('POST', path, body, { headers });
        expectEqual(r.status, 403, 'status');
      });
    }
    await check('the forged requests changed nothing', async () => {
      const d = (await c.request('GET', `/api/queue/${target.id}`)).json.detail;
      expectEqual(d.submission.reviewStatus, 'pending', 'reviewStatus');
      expectEqual(d.overrideLogs.length, 0, 'override logs');
    });
    await check('a same-origin request is accepted (control)', async () => {
      const r = await c.request('POST', '/api/intake', validIntake('same-origin'), { headers: { Origin: main.base } });
      expectEqual(r.status, 201, 'status');
    });
    await check('no CORS: responses never grant another origin access', async () => {
      const get = await c.request('GET', '/api/queue', undefined, { headers: { Origin: 'https://evil.example' } });
      expect(!get.headers.get('access-control-allow-origin'), 'Access-Control-Allow-Origin must be absent');
      const pre = await anon.request('OPTIONS', '/api/queue', undefined, { headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
      expect(!pre.headers.get('access-control-allow-origin'), 'preflight must not be approved');
    });

    // ------------------------------------------------------------------ input limits
    section('Input limits');
    const limits: [string, Record<string, unknown>][] = [
      ['patientName of 101 characters', { patientName: 'n'.repeat(101), symptomText: 'headache' }],
      ['symptomText of 2001 characters', { patientName: 'x', symptomText: 's'.repeat(2001) }],
      ['contactPhone that is not a phone number', { patientName: 'x', symptomText: 'headache', contactPhone: 'DROP TABLE' }],
      ['NUL byte in the name', { patientName: 'a\u0000b', symptomText: 'headache' }],
      ['newline in the name', { patientName: 'a\nb', symptomText: 'headache' }],
    ];
    for (const [label, body] of limits) {
      await check(`${label} → 400`, async () => {
        expectEqual((await c.request('POST', '/api/intake', body)).status, 400, 'status');
      });
    }
    await check('a body over 16 KB → 413 as JSON, without reading it into the app', async () => {
      const r = await c.request('POST', '/api/intake', { patientName: 'x', symptomText: 'y'.repeat(20_000) });
      expectEqual(r.status, 413, 'status');
      expect(r.json?.error, 'JSON error body');
    });

    // ------------------------------------------------------------------ headers
    section('Response headers and error hygiene');
    await check('security headers are present and X-Powered-By is gone', async () => {
      const r = await c.request('GET', '/api/queue');
      expectEqual(r.headers.get('x-content-type-options'), 'nosniff', 'X-Content-Type-Options');
      expectEqual(r.headers.get('x-frame-options'), 'DENY', 'X-Frame-Options');
      expectEqual(r.headers.get('referrer-policy'), 'no-referrer', 'Referrer-Policy');
      expect(!r.headers.get('x-powered-by'), 'X-Powered-By must be removed');
    });
    await check('API responses (including 401s) are never cached: they contain patient data', async () => {
      for (const r of [await c.request('GET', '/api/queue'), await anon.request('GET', '/api/queue'), await c.request('GET', `/api/queue/${target.id}`)]) {
        expect(/no-store/.test(r.headers.get('cache-control') ?? ''), `Cache-Control was "${r.headers.get('cache-control')}"`);
      }
    });
    await check('errors are JSON and leak no stack traces, paths or SQL', async () => {
      const replies = [
        await c.request('GET', '/api/nope'),
        await c.request('POST', '/api/intake', undefined, { raw: '{"broken":' }),
        await c.request('GET', '/api/queue/not-a-uuid'),
        await c.request('POST', '/api/intake', { patientName: 5 }),
      ];
      for (const r of replies) {
        expect(r.json?.success === false, `not a JSON error: ${r.text.slice(0, 80)}`);
        expect(!/\bat [\w.<>]+ \(|node_modules|\.ts:\d+|SELECT |INSERT |pg_|ECONN|C:\\|\/Users\//.test(r.text), `leaks internals: ${r.text.slice(0, 160)}`);
      }
    });

    // ------------------------------------------------------------------ network exposure
    section('Network exposure');
    await check('the server listens on loopback only (unreachable via the LAN address)', async () => {
      const lan = Object.values(os.networkInterfaces())
        .flat()
        .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
      if (!lan) suite.skip('no non-loopback IPv4 address on this machine');
      let reached = false;
      try {
        const r = await fetch(`http://${lan}:${BASE_PORT}/api/health`, { signal: AbortSignal.timeout(3000) });
        reached = r.ok;
      } catch {
        // refused / timed out: what we want
      }
      expect(!reached, `server answered on ${lan}:${BASE_PORT} — it must bind to 127.0.0.1 by default`);
    });

    // ------------------------------------------------------------------ rate limiting + secure cookie
    section('Intake rate limit and Secure cookie (server started with limit 3/min, COOKIE_SECURE=true)');
    const limited = await startServer(BASE_PORT + 10, { INTAKE_RATE_LIMIT_PER_MINUTE: '3', COOKIE_SECURE: 'true' });
    servers.push(limited);
    await check('the 4th intake within a minute is refused with 429 + Retry-After; other users are unaffected', async () => {
      const a = new Client(limited.base);
      const b = new Client(limited.base);
      const loginA = await a.request('POST', '/api/auth/login', { username: alice.username, password: alice.password }, { anonymous: true });
      expect(/;\s*Secure/i.test(loginA.headers.getSetCookie().join(';')), 'COOKIE_SECURE=true must add the Secure attribute');
      a.cookie = loginA.headers.getSetCookie().find((x) => x.startsWith('triage_sid='))!.split(';')[0];
      await b.login(bob.username, bob.password);
      for (let i = 1; i <= 3; i++) expectEqual((await a.request('POST', '/api/intake', validIntake(`rl${i}`))).status, 201, `intake ${i}`);
      const blocked = await a.request('POST', '/api/intake', validIntake('rl4'));
      expectEqual(blocked.status, 429, 'status');
      expect(Number(blocked.headers.get('retry-after')) > 0, 'Retry-After header');
      expectEqual((await b.request('POST', '/api/intake', validIntake('rl-bob'))).status, 201, "another user's quota");
    });

    section('Production mode (NODE_ENV=production)');
    const prod = await startServer(BASE_PORT + 20, { NODE_ENV: 'production' });
    servers.push(prod);
    await check('CSP is enforced, cookies are Secure by default, and the API still requires auth', async () => {
      const p = new Client(prod.base);
      const h = await p.request('GET', '/api/health');
      const csp = h.headers.get('content-security-policy') ?? '';
      for (const directive of ["default-src 'self'", "script-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'"]) {
        expect(csp.includes(directive), `CSP is missing ${directive}: ${csp}`);
      }
      expect(!/script-src[^;]*unsafe-inline/.test(csp) && !/unsafe-eval/.test(csp), 'script-src must not allow inline or eval');
      const login = await p.request('POST', '/api/auth/login', { username: bob.username, password: bob.password });
      expect(/;\s*Secure/i.test(login.headers.getSetCookie().join(';')), 'production cookies must be Secure by default');
      expectEqual((await p.request('GET', '/api/queue', undefined, { anonymous: true })).status, 401, 'anonymous queue in production');
    });

    // ------------------------------------------------------------------ lockout (last: it blocks this client)
    section('Brute-force protection (last, because it locks this client out for 15 minutes)');
    await check('5 wrong passwords lock the account for this client, even against the right password', async () => {
      const l = new Client(main.base);
      for (let i = 1; i <= 5; i++) expectEqual((await l.login(victim.username, `wrong-${i}`)).status, 401, `attempt ${i}`);
      const locked = await l.login(victim.username, victim.password);
      expectEqual(locked.status, 429, 'correct password while locked out');
      expect(Number(locked.headers.get('retry-after')) > 0, 'Retry-After header');
      expectEqual(l.cookie, '', 'no session may be issued while locked out');
    });
    await check('20 failures from one client (many usernames) lock that client out entirely', async () => {
      const l = new Client(main.base);
      let last = 0;
      for (let i = 0; i < 25; i++) last = (await l.login(`guess-${i}-${RUN_ID}`, 'password')).status;
      expectEqual(last, 429, 'after 20 failures');
      expectEqual((await new Client(main.base).login(alice.username, alice.password)).status, 429, 'a valid login from the same client is also refused');
    });

    code = suite.summary();
  } finally {
    for (const s of servers) await s.stop();
    const removed = await pool.query("DELETE FROM intake_submissions WHERE patient_name LIKE 'SEC-TEST%'");
    await dropTestUsers(pool);
    await pool.end();
    console.log(`(cleaned up ${removed.rowCount} SEC-TEST rows and the test accounts)`);
  }
  process.exit(code);
}

main().catch((err) => {
  console.error('Unexpected error in test runner:', err);
  process.exit(2);
});
