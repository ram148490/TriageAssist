/**
 * End-to-end proof of the core safety behavior: when the Gemini API fails or
 * hangs, an intake submitted to the REAL server still comes back promptly as a
 * High-urgency, 0%-confidence, mandatory-review case, flagged as "AI unavailable",
 * and it sorts to the top of the triage queue.
 *
 * Boots its own server (default port 3101, override with E2E_PORT) pointed at a
 * local fake Gemini endpoint, and signs in with a throwaway staff account. Needs
 * Postgres (DATABASE_URL from .env) but no API key and no network. Rows it creates
 * are named "FAILSAFE-TEST …" and are deleted at the end.
 *
 *   npm run test:failsafe
 */
import assert from 'assert';
import http from 'http';
import { FALLBACK_MODEL_NAME } from '../shared/types';
import { Client, createTestUser, dropTestUsers, openPool, RUN_ID, startServer } from './helpers/harness';

const PORT = Number(process.env.E2E_PORT ?? 3101);
const GEMINI_TIMEOUT_MS = 2000;

const fakeGeminiModes: Record<string, http.RequestListener> = {
  'Gemini hangs (never answers)': () => {},
  'Gemini returns HTTP 429 (quota)': (_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end('{"error":{"code":429,"message":"quota exceeded"}}');
  },
  'Gemini returns HTTP 503 (overloaded)': (_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{"error":{"code":503,"message":"high demand","status":"UNAVAILABLE"}}');
  },
  'Gemini returns HTTP 401 (bad key)': (_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"code":401,"message":"invalid credentials","status":"UNAUTHENTICATED"}}');
  },
  'Gemini returns garbage': (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>not json</html>');
  },
};

async function runMode(label: string, listener: http.RequestListener, user: { username: string; password: string }) {
  const fake = http.createServer((req, res) => {
    req.resume();
    listener(req, res);
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const fakePort = (fake.address() as { port: number }).port;

  const server = await startServer(PORT, {
    GEMINI_API_KEY: 'fake-key-for-e2e',
    GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${fakePort}`,
    GEMINI_TIMEOUT_MS: String(GEMINI_TIMEOUT_MS),
    CONFIDENCE_THRESHOLD: '0.7',
  });

  try {
    const client = new Client(server.base);
    assert.strictEqual((await client.login(user.username, user.password)).status, 200, `${label}: login`);

    const started = Date.now();
    const res = await client.request('POST', '/api/intake', {
      patientName: `FAILSAFE-TEST ${RUN_ID} ${label}`,
      symptomText: 'chest pain and trouble breathing',
    });
    const elapsed = Date.now() - started;
    const body = res.json;

    assert.strictEqual(res.status, 201, `${label}: intake must still succeed (got ${res.status}: ${res.text})`);
    assert.ok(elapsed < GEMINI_TIMEOUT_MS + 3000, `${label}: took ${elapsed}ms; must give up by ~${GEMINI_TIMEOUT_MS}ms`);
    assert.strictEqual(body.classificationUnavailable, true, `${label}: response must say the AI was unavailable`);

    const s = body.submission;
    assert.strictEqual(s.finalUrgencyLevel, 'high', `${label}: urgency`);
    assert.strictEqual(s.confidenceScore, 0, `${label}: confidence`);
    assert.strictEqual(s.needsHumanReview, true, `${label}: needsHumanReview`);
    assert.strictEqual(s.reviewStatus, 'pending', `${label}: reviewStatus`);
    assert.strictEqual(s.finalDepartment, 'General Urgent Care', `${label}: department`);

    // What staff see in the queue: the case is present and sorted ahead of anything not high.
    const list: any[] = (await client.request('GET', '/api/queue')).json.submissions;
    const idx = list.findIndex((x) => x.id === s.id);
    assert.ok(idx >= 0, `${label}: case missing from the queue`);
    assert.ok(
      list.slice(0, idx).every((x) => x.finalUrgencyLevel === 'high'),
      `${label}: a non-high case is sorted ahead of the fail-safe case`,
    );

    // The audit trail records that the fail-safe (not the model) produced this result.
    const detail = (await client.request('GET', `/api/queue/${s.id}`)).json.detail;
    assert.strictEqual(detail.classificationHistory.length, 1, `${label}: history rows`);
    assert.strictEqual(detail.classificationHistory[0].modelName, FALLBACK_MODEL_NAME, `${label}: history modelName`);

    // ...and the server is still healthy afterwards.
    assert.strictEqual((await client.request('GET', '/api/health')).status, 200, `${label}: server must survive the failure`);

    console.log(`  ok  ${label} → 201 in ${elapsed}ms: High, 0% confidence, review required, "AI unavailable"`);
  } finally {
    await server.stop();
    fake.closeAllConnections();
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  }
}

const pool = openPool();
let failed = false;
try {
  console.log(`Fail-safe end-to-end (server on :${PORT}, Gemini deadline ${GEMINI_TIMEOUT_MS}ms)`);
  const user = await createTestUser(pool, 'fs');
  for (const [label, listener] of Object.entries(fakeGeminiModes)) {
    await runMode(label, listener, user);
  }
  console.log('test-failsafe-e2e: all assertions passed.');
} catch (err) {
  failed = true;
  console.error('test-failsafe-e2e FAILED:', err instanceof Error ? err.message : err);
} finally {
  const { rowCount } = await pool.query(`DELETE FROM intake_submissions WHERE patient_name LIKE 'FAILSAFE-TEST%'`);
  await dropTestUsers(pool);
  console.log(`(cleaned up ${rowCount} test rows and the test account)`);
  await pool.end();
}
process.exit(failed ? 1 : 0);
