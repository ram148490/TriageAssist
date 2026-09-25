/**
 * Proves the raw symptom text is never persisted or logged on ANY path, not just the
 * main insert. A unique canary string is placed in the symptom text and pushed through
 * the real server while a fake Gemini endpoint misbehaves in every way it can; then we
 * search for the canary in: the server's stdout/stderr, every API response, and every
 * row of every table in the database (which includes the audit tables). Also checks
 * exactly what is (and isn't) sent to Gemini, and the paid-tier gate for production.
 *
 *   npm run test:privacy
 *
 * Needs Postgres. Uses its own server (ports 3104, 3114, 3124) and a fake Gemini, so it
 * sends nothing to Google and spends no quota.
 */
import http from 'http';
import { spawnSync } from 'child_process';
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

const BASE_PORT = Number(process.env.E2E_PORT ?? 3104);
const suite = new Suite();
const { check, section } = { check: suite.check.bind(suite), section: suite.section.bind(suite) };

const CANARY = `ZQXCANARY${RUN_ID}`;
const SYMPTOMS = `${CANARY} patient says they have HIV and sharp chest pain`;
const FRAGMENTS = [CANARY, 'ZQXCANARY', 'has HIV', 'sharp chest pain'];
const API_KEY = `fake-gemini-key-${RUN_ID}`;

interface Received {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const goodPayload = { urgencyLevel: 'low', suggestedDepartment: 'Minor Illness', confidenceScore: 0.9 };

async function main() {
  const pool = openPool();

  // ---------------------------------------------------------------- fake Gemini
  let mode = 'ok';
  const received: Received[] = [];
  const modes: Record<string, (res: http.ServerResponse) => void> = {
    ok: (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // The "model" also echoes the patient's text in an extra field: it must not be stored.
      res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify({ ...goodPayload, note: SYMPTOMS }) }] } }] }));
    },
    'echoes text as invalid JSON': (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: `${SYMPTOMS} — I cannot classify this.` }] } }] }));
    },
    'echoes text inside truncated JSON': (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: `{"urgencyLevel":"low","note":"${SYMPTOMS}` }] } }] }));
    },
    'HTTP 400 that quotes the request': (res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: `Invalid value at contents[0].parts[0].text: ${SYMPTOMS}` } }));
    },
    'HTTP 500 that quotes the request': (res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 500, status: 'INTERNAL', message: `internal error processing ${SYMPTOMS}` } }));
    },
    'HTTP 200 non-JSON body quoting the request': (res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html>gateway error for: ${SYMPTOMS}</html>`);
    },
    'HTTP 429 quota': (res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota' } }));
    },
    hang: () => {},
  };
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      received.push({ url: req.url ?? '', headers: req.headers, body });
      modes[mode](res);
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;

  const servers: Awaited<ReturnType<typeof startServer>>[] = [];
  let code = 1;
  try {
    const app = await startServer(BASE_PORT, {
      GEMINI_API_KEY: API_KEY,
      GOOGLE_GEMINI_BASE_URL: fakeUrl,
      GEMINI_TIMEOUT_MS: '1500',
    });
    servers.push(app);
    console.log(`TriageAssist privacy checks → ${app.base}  (canary ${CANARY})`);

    const user = await createTestUser(pool, 'priv');
    const c = new Client(app.base);
    expectEqual((await c.login(user.username, user.password)).status, 200, 'setup login');

    const allResponses: string[] = [];
    const submit = async (label: string, extra: Record<string, unknown> = {}) => {
      const r = await c.request('POST', '/api/intake', {
        patientName: `PRIV-TEST ${label} ${RUN_ID}`,
        contactPhone: '555-0142',
        symptomText: SYMPTOMS,
        ...extra,
      });
      allResponses.push(r.text);
      return r;
    };

    // ------------------------------------------------------------ what Gemini receives
    section('What is sent to Gemini');
    await check('only the delimited symptom text goes out: no name, no phone, key in a header not the URL', async () => {
      mode = 'ok';
      received.length = 0;
      const r = await submit('sent');
      expectEqual(r.status, 201, 'status');
      expectEqual(received.length, 1, 'requests to Gemini');
      const req = received[0];
      const sent = JSON.parse(req.body);
      const contents = JSON.stringify(sent.contents);
      expect(contents.includes(SYMPTOMS), 'the symptom text is what gets classified');
      expect(contents.includes('<patient_intake>') && contents.includes('</patient_intake>'), 'text is wrapped in the untrusted-data delimiters');
      expect(!req.body.includes(`PRIV-TEST`), 'the patient name must not be sent to Gemini');
      expect(!req.body.includes('555-0142'), 'the phone number must not be sent to Gemini');
      expect(!req.url.includes(API_KEY), 'the API key must not be in the URL');
      expectEqual(req.headers['x-goog-api-key'], API_KEY, 'key travels in the x-goog-api-key header');
      const system = JSON.stringify(sent.systemInstruction);
      expect(/untrusted/i.test(system) && system.includes('patient_intake'), 'the system prompt tells the model to treat the text as data');
    });

    // ------------------------------------------------------------ every failure path
    section('Every AI failure path (canary is echoed by the fake model/API where possible)');
    for (const m of Object.keys(modes)) {
      await check(`Gemini: ${m}`, async () => {
        mode = m;
        const r = await submit(m);
        expectEqual(r.status, 201, 'intake still succeeds');
        if (m !== 'ok') expectEqual(r.json.classificationUnavailable, true, 'falls back to the fail-safe');
      });
    }

    // ------------------------------------------------------------ non-AI paths
    section('Rejected and malformed requests that contain the canary');
    const badRequests: [string, () => Promise<{ status: number; text: string }>][] = [
      ['invalid JSON body', () => c.request('POST', '/api/intake', undefined, { raw: `{"symptomText":"${SYMPTOMS}", ` })],
      ['oversized body (>16 KB)', () => c.request('POST', '/api/intake', { patientName: 'x', symptomText: SYMPTOMS + 'x'.repeat(20_000) })],
      ['symptomText over the 2000-character limit', () => c.request('POST', '/api/intake', { patientName: 'x', symptomText: SYMPTOMS + 'x'.repeat(2100) })],
      ['symptomText of the wrong type', () => c.request('POST', '/api/intake', { patientName: 'x', symptomText: { nested: SYMPTOMS } })],
      ['control characters in the text', () => c.request('POST', '/api/intake', { patientName: 'x', symptomText: `${SYMPTOMS}\u0000` })],
      ['missing patient name', () => c.request('POST', '/api/intake', { symptomText: SYMPTOMS })],
      ['canary in unrelated fields of an override', async () => {
        const s = (await submit('override-target')).json.submission;
        return c.request('POST', `/api/queue/${s.id}/override`, { newUrgencyLevel: 'low', newDepartment: 'Minor Illness', reason: 'ok', note: SYMPTOMS, symptomText: SYMPTOMS });
      }],
      ['canary in a confirm body', async () => {
        const s = (await submit('confirm-target')).json.submission;
        return c.request('POST', `/api/queue/${s.id}/confirm`, { symptomText: SYMPTOMS });
      }],
      ['canary in a login attempt', () => c.request('POST', '/api/auth/login', { username: SYMPTOMS, password: SYMPTOMS }, { anonymous: true })],
      ['canary in the URL path and query', () => c.request('GET', `/api/queue/${SYMPTOMS.replace(/ /g, '%20')}?q=${CANARY}`)],
    ];
    for (const [label, send] of badRequests) {
      await check(`${label}: not echoed back`, async () => {
        const r = await send();
        allResponses.push(r.text);
        expect(r.status >= 200 && r.status < 500, `unexpected status ${r.status}`);
        for (const f of FRAGMENTS) expect(!r.text.includes(f), `response echoes "${f}"`);
      });
    }

    // ------------------------------------------------------------ the searches
    section('Searching everywhere for the canary');
    await check('the server log (stdout + stderr) contains no part of the symptom text', async () => {
      await new Promise((r) => setTimeout(r, 500));
      const out = app.output();
      expect(out.length > 0 && out.includes('running'), 'sanity: the server log is being captured');
      for (const f of FRAGMENTS) expect(!out.includes(f), `server log contains "${f}":\n${out.split('\n').filter((l) => l.includes(f)).join('\n').slice(0, 400)}`);
    });

    await check('the server log still tells an operator what went wrong (auth/quota/timeout are diagnosable)', () => {
      const out = app.output();
      expect(/HTTP 429 RESOURCE_EXHAUSTED: You exceeded your current quota/.test(out), '429 detail missing from the log');
      expect(/timed out after 1500ms/.test(out), 'timeout missing from the log');
      expect(/HTTP 400 INVALID_ARGUMENT \(message withheld\)/.test(out), '400 should be logged as withheld');
      expect(/HTTP 500 INTERNAL/.test(out), '500 missing from the log');
    });

    await check('no API response contained any part of the symptom text', () => {
      for (const f of FRAGMENTS) expect(!allResponses.some((t) => t.includes(f)), `a response contains "${f}"`);
    });

    await check('the queue and every submission detail (incl. audit tables) never expose it', async () => {
      const list = (await c.request('GET', '/api/queue')).json.submissions as { id: string; patientName: string }[];
      const text = JSON.stringify(list);
      for (const f of FRAGMENTS) expect(!text.includes(f), `queue contains "${f}"`);
      for (const s of list.filter((x) => x.patientName.startsWith('PRIV-TEST'))) {
        const d = (await c.request('GET', `/api/queue/${s.id}`)).text;
        for (const f of FRAGMENTS) expect(!d.includes(f), `detail of ${s.id} contains "${f}"`);
      }
    });

    await check('no row of any table in the database contains it (every table, every column)', async () => {
      const tables = (await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")).rows.map((r) => r.table_name as string);
      expect(tables.includes('intake_submissions') && tables.includes('classification_history') && tables.includes('override_logs'), `expected tables missing: ${tables}`);
      let scanned = 0;
      for (const t of tables) {
        for (const f of FRAGMENTS) {
          const r = await pool.query(`SELECT count(*)::int AS n FROM "${t}" x WHERE x::text ILIKE $1`, [`%${f}%`]);
          expectEqual(r.rows[0].n, 0, `rows in "${t}" containing "${f}"`);
        }
        scanned += (await pool.query(`SELECT count(*)::int AS n FROM "${t}"`)).rows[0].n;
      }
      expect(scanned > 0, 'sanity: tables were not empty');
      const own = await pool.query("SELECT count(*)::int AS n FROM intake_submissions WHERE patient_name LIKE 'PRIV-TEST%'");
      expect(own.rows[0].n >= 8, `sanity: this run's intakes are in the database (${own.rows[0].n})`);
    });

    await check('no column in the schema could hold free-form symptom text', async () => {
      const cols = (await pool.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('intake_submissions','classification_history','override_logs')")).rows;
      const suspicious = cols.filter((r) => /symptom|complaint|narrative|transcript|prompt(?!_version)|note|raw|input|text|description/i.test(r.column_name));
      // override_logs.reason is deliberate, staff-authored, and length-limited; nothing else may look like free text.
      expect(suspicious.every((r) => r.table_name === 'override_logs' && r.column_name === 'reason'), `unexpected free-text columns: ${JSON.stringify(suspicious)}`);
    });

    await check('the database server log does not contain it either', () => {
      const r = spawnSync('docker', ['compose', 'logs', 'db', '--no-color'], { encoding: 'utf8', cwd: process.cwd() });
      if (r.status !== 0 || r.error) suite.skip('docker compose logs is not available here');
      const logs = `${r.stdout}${r.stderr}`;
      expect(logs.length > 0, 'sanity: got database logs');
      for (const f of FRAGMENTS) expect(!logs.includes(f), `Postgres log contains "${f}"`);
    });

    // ------------------------------------------------------------ paid-tier gate
    section('Patient text is only sent to Gemini on a confirmed paid tier in production');
    await check('development: works, but warns that free-tier text may be used to improve Google products', () => {
      const out = app.output();
      expect(/\[privacy\] Symptom text is sent to Google Gemini/.test(out), 'startup privacy warning missing');
      expect(/may use it to improve/.test(out), 'warning should say why');
    });

    const prodGated = await startServer(BASE_PORT + 10, { NODE_ENV: 'production', GEMINI_API_KEY: API_KEY, GOOGLE_GEMINI_BASE_URL: fakeUrl, GEMINI_TIMEOUT_MS: '1500' });
    servers.push(prodGated);
    await check('production WITHOUT GEMINI_PAID_TIER_CONFIRMED: nothing is sent to Gemini; the fail-safe is used', async () => {
      const p = new Client(prodGated.base);
      expectEqual((await p.login(user.username, user.password)).status, 200, 'login');
      mode = 'ok';
      received.length = 0;
      const r = await p.request('POST', '/api/intake', { patientName: `PRIV-TEST gated ${RUN_ID}`, symptomText: SYMPTOMS });
      expectEqual(r.status, 201, 'status');
      expectEqual(received.length, 0, 'requests that reached Gemini');
      expectEqual(r.json.classificationUnavailable, true, 'classificationUnavailable');
      expectEqual(r.json.submission.finalUrgencyLevel, 'high', 'fail-safe urgency');
      expect(/AI classification is DISABLED in production/.test(prodGated.output()), 'startup warning missing');
    });

    const prodPaid = await startServer(BASE_PORT + 20, { NODE_ENV: 'production', GEMINI_API_KEY: API_KEY, GEMINI_PAID_TIER_CONFIRMED: 'true', GOOGLE_GEMINI_BASE_URL: fakeUrl, GEMINI_TIMEOUT_MS: '1500' });
    servers.push(prodPaid);
    await check('production WITH GEMINI_PAID_TIER_CONFIRMED=true: classification runs', async () => {
      const p = new Client(prodPaid.base);
      expectEqual((await p.login(user.username, user.password)).status, 200, 'login');
      mode = 'ok';
      received.length = 0;
      const r = await p.request('POST', '/api/intake', { patientName: `PRIV-TEST paid ${RUN_ID}`, symptomText: SYMPTOMS });
      expectEqual(r.status, 201, 'status');
      expectEqual(received.length, 1, 'requests that reached Gemini');
      expectEqual(r.json.classificationUnavailable, false, 'classificationUnavailable');
      expect(!/DISABLED/.test(prodPaid.output()), 'no disabled warning when confirmed');
    });

    // Final sweep including the extra servers' logs and the rows they wrote.
    await check('none of the servers (incl. production) logged, and the database never stored, the canary', async () => {
      for (const s of servers) for (const f of FRAGMENTS) expect(!s.output().includes(f), `a server log contains "${f}"`);
      const r = await pool.query("SELECT count(*)::int AS n FROM intake_submissions x WHERE x::text ILIKE '%ZQXCANARY%'");
      expectEqual(r.rows[0].n, 0, 'rows containing the canary');
    });

    code = suite.summary();
  } finally {
    for (const s of servers) await s.stop();
    fake.closeAllConnections();
    fake.close();
    const removed = await pool.query("DELETE FROM intake_submissions WHERE patient_name LIKE 'PRIV-TEST%'");
    await dropTestUsers(pool);
    await pool.end();
    console.log(`(cleaned up ${removed.rowCount} PRIV-TEST rows and the test account)`);
  }
  process.exit(code);
}

main().catch((err) => {
  console.error('Unexpected error in test runner:', err);
  process.exit(2);
});
