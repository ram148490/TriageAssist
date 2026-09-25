/**
 * API edge-case checks for TriageAssist, run against a private copy of the server that
 * this script boots itself (default port 3102) with a throwaway staff account and
 * Gemini disabled, so it spends no AI quota. Needs Postgres (DATABASE_URL from .env).
 *
 * It WRITES rows to that database (patient names are prefixed "EDGE-TEST") and removes
 * them again at the end. There is no delete endpoint, so it uses the database directly.
 *
 *   npm run test:api
 *   E2E_PORT=4102 npm run test:api
 */
import { PROMPT_VERSION } from '../server/lib/classifier';
import { isReviewRequired, parseConfidenceThreshold } from '../shared/logic';
import { DEPARTMENTS, type IntakeDetail, type IntakeSubmission } from '../shared/types';
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
  type Reply,
} from './helpers/harness';

const PORT = Number(process.env.E2E_PORT ?? 3102);

const suite = new Suite();
const check = suite.check.bind(suite);
const section = suite.section.bind(suite);
const skip = suite.skip.bind(suite);

const MARKER = `edge-marker-${RUN_ID}`; // unique text used to prove symptom text is never echoed back
const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000';

let client: Client;
let USERNAME = '';

async function call(method: string, path: string, body?: unknown, raw?: string): Promise<Reply> {
  return client.request(method, path, body, { raw });
}

async function createIntake(label: string, extra: Record<string, unknown> = {}): Promise<IntakeSubmission> {
  const r = await call('POST', '/api/intake', {
    patientName: `EDGE-TEST ${label} ${RUN_ID}`,
    symptomText: `Mild headache since this morning ${MARKER}`,
    ...extra,
  });
  expectEqual(r.status, 201, `setup intake "${label}" status (body: ${r.text.slice(0, 200)})`);
  return r.json.submission;
}

async function detailOf(id: string): Promise<IntakeDetail> {
  const r = await call('GET', `/api/queue/${id}`);
  expectEqual(r.status, 200, `detail status for ${id}`);
  return r.json.detail;
}

const validOverride = (over: Record<string, unknown> = {}) => ({
  newUrgencyLevel: 'medium',
  newDepartment: 'Minor Illness',
  reason: 'Edge-test override',
  ...over,
});

async function main() {
  const pool = openPool();
  const server = await startServer(PORT, { CONFIDENCE_THRESHOLD: '0.7' });
  let code = 1;
  try {
    console.log(`TriageAssist API edge cases → ${server.base}  (run ${RUN_ID})`);
    const user = await createTestUser(pool, 'api');
    USERNAME = user.username;
    client = new Client(server.base);
    const login = await client.login(user.username, user.password);
    expectEqual(login.status, 200, 'test-user login status');

    code = await run();
  } finally {
    await server.stop();
    const removed = await pool.query("DELETE FROM intake_submissions WHERE patient_name LIKE 'EDGE-TEST%'");
    await dropTestUsers(pool);
    await pool.end();
    console.log(`(cleaned up ${removed.rowCount} EDGE-TEST rows and the test account)`);
  }
  process.exit(code);
}

async function run(): Promise<number> {
  section('Health');
  await check('GET /api/health returns {status: "ok"}', async () => {
    const h = await call('GET', '/api/health');
    expectEqual(h.json?.status, 'ok', 'status field');
  });

  // ---------------------------------------------------------------- intake validation
  section('POST /api/intake — validation');
  const badIntakes: [string, unknown][] = [
    ['empty object', {}],
    ['missing patientName', { symptomText: 'cough for a week' }],
    ['whitespace-only patientName', { patientName: '   ', symptomText: 'cough for a week' }],
    ['missing symptomText', { patientName: 'EDGE-TEST x' }],
    ['symptomText shorter than 3 chars after trim', { patientName: 'EDGE-TEST x', symptomText: '  a ' }],
    ['symptomText of exactly 2 chars', { patientName: 'EDGE-TEST x', symptomText: 'ab' }],
  ];
  for (const [label, body] of badIntakes) {
    await check(`rejects ${label} with 400`, async () => {
      const r = await call('POST', '/api/intake', body);
      expectEqual(r.status, 400, 'status');
      expectEqual(r.json?.success, false, 'success flag');
      expect(typeof r.json?.error === 'string' && r.json.error.length > 0, 'error message present');
    });
  }

  await check('accepts symptomText of exactly 3 chars', async () => {
    const r = await call('POST', '/api/intake', { patientName: `EDGE-TEST min ${RUN_ID}`, symptomText: 'abc' });
    expectEqual(r.status, 201, 'status');
  });

  await check('malformed JSON body returns 400 (not 500)', async () => {
    const r = await call('POST', '/api/intake', undefined, '{"patientName": "EDGE-TEST", ');
    expectEqual(r.status, 400, 'status');
  });

  await check('body over the 1 MB limit is rejected with 413', async () => {
    const r = await call('POST', '/api/intake', { patientName: 'EDGE-TEST big', symptomText: 'x'.repeat(1_100_000) });
    expectEqual(r.status, 413, 'status');
  });

  await check('a body just over the 16 KB cap is rejected with 413', async () => {
    const r = await call('POST', '/api/intake', { patientName: 'EDGE-TEST big', symptomText: 'x'.repeat(17_000) });
    expectEqual(r.status, 413, 'status');
  });

  await check('413 response is JSON so the UI can show a readable error', async () => {
    const r = await call('POST', '/api/intake', { patientName: 'EDGE-TEST big', symptomText: 'x'.repeat(1_100_000) });
    expect(r.json !== null && typeof r.json.error === 'string', `body was not a JSON {error}: ${r.text.slice(0, 80)}…`);
  });

  // ---------------------------------------------------------------- intake behavior
  section('POST /api/intake — behavior and data minimization');
  let base: IntakeSubmission | undefined;
  await check('valid intake returns 201 with a well-formed submission', async () => {
    const r = await call('POST', '/api/intake', {
      patientName: `  EDGE-TEST base ${RUN_ID}  `,
      contactPhone: '  (555) 555-0100 ',
      symptomText: `Mild headache since this morning ${MARKER}`,
    });
    expectEqual(r.status, 201, 'status');
    expectEqual(r.json.success, true, 'success flag');
    const s: IntakeSubmission = r.json.submission;
    base = s;
    expectEqual(s.patientName, `EDGE-TEST base ${RUN_ID}`, 'patientName is trimmed');
    expectEqual(s.contactPhone, '(555) 555-0100', 'contactPhone is trimmed');
    expectEqual(s.reviewStatus, 'pending', 'reviewStatus starts pending');
    expectEqual(s.reviewedBy, null, 'reviewedBy starts null');
    expectEqual(s.finalUrgencyLevel, s.urgencyLevel, 'final urgency starts equal to AI urgency');
    expectEqual(s.finalDepartment, s.suggestedDepartment, 'final department starts equal to AI department');
    expect(s.confidenceScore >= 0 && s.confidenceScore <= 1, `confidence ${s.confidenceScore} outside 0–1`);
    expect((DEPARTMENTS as readonly string[]).includes(s.suggestedDepartment), 'department is a known value');
  });

  await check('blank contactPhone is stored as null', async () => {
    const s = await createIntake('nophone', { contactPhone: '   ' });
    expectEqual(s.contactPhone, null, 'contactPhone');
  });

  await check('needsHumanReview agrees with confidence < 0.7 (default threshold)', async () => {
    expect(base, 'no base submission');
    // Only valid when CONFIDENCE_THRESHOLD is left at its default on the server.
    expectEqual(base.needsHumanReview, isReviewRequired(base.confidenceScore, 0.7), 'needsHumanReview');
  });

  await check('response never echoes the raw symptom text', async () => {
    const r = await call('POST', '/api/intake', {
      patientName: `EDGE-TEST echo ${RUN_ID}`,
      symptomText: `secret symptom ${MARKER}-echo`,
    });
    expectEqual(r.status, 201, 'status');
    expect(!r.text.includes(`${MARKER}-echo`), 'symptom text found in intake response');
    expect(!('symptomText' in r.json.submission), 'submission object has a symptomText field');
  });

  await check('symptom text is absent from queue, detail and history responses', async () => {
    expect(base, 'no base submission');
    const queue = await call('GET', '/api/queue');
    const detail = await call('GET', `/api/queue/${base.id}`);
    expect(!queue.text.includes(MARKER), 'marker found in GET /api/queue');
    expect(!detail.text.includes(MARKER), 'marker found in GET /api/queue/:id');
  });

  await check('special characters / SQL-like text in patientName are stored verbatim', async () => {
    const name = `EDGE-TEST '); DROP TABLE intake_submissions;-- ✓ ${RUN_ID}`;
    const s = await createIntake('sqli', { patientName: name, symptomText: `<script>alert(1)</script> ${MARKER}` });
    expectEqual(s.patientName, name, 'patientName');
    const q = await call('GET', '/api/queue');
    expectEqual(q.status, 200, 'queue still works after hostile input');
  });

  await check('classification history: exactly one entry with model + prompt version', async () => {
    expect(base, 'no base submission');
    const d = await detailOf(base.id);
    expectEqual(d.classificationHistory.length, 1, 'classificationHistory length');
    const h = d.classificationHistory[0];
    expect(h.modelName.length > 0, 'modelName empty');
    expectEqual(h.promptVersion, PROMPT_VERSION, 'promptVersion');
    expectEqual(h.urgencyLevel, base.urgencyLevel, 'history urgency matches submission');
    expectEqual(h.confidenceScore, base.confidenceScore, 'history confidence matches submission');
  });

  await check('fail-safe: an unclassifiable intake is high urgency, 0 confidence, needs review', async () => {
    expect(base, 'no base submission');
    const d = await detailOf(base.id);
    if (d.classificationHistory[0].modelName !== 'unavailable-fallback') {
      skip('Gemini is configured, so classification is not deterministic — unset GEMINI_API_KEY to exercise this');
    }
    expectEqual(base.finalUrgencyLevel, 'high', 'urgency');
    expectEqual(base.confidenceScore, 0, 'confidence');
    expectEqual(base.needsHumanReview, true, 'needsHumanReview');
    expectEqual(base.finalDepartment, 'General Urgent Care', 'department');
  });

  // ---------------------------------------------------------------- queue
  section('GET /api/queue');
  await check('returns success + an array', async () => {
    const q = await call('GET', '/api/queue');
    expectEqual(q.status, 200, 'status');
    expect(Array.isArray(q.json.submissions), 'submissions is not an array');
  });

  await check('sorted high → medium → low, then oldest first within a level', async () => {
    // Make sure at least one non-high row exists so ordering is meaningful.
    const s = await createIntake('order-low');
    const o = await call('POST', `/api/queue/${s.id}/override`, validOverride({ newUrgencyLevel: 'low', newDepartment: 'Minor Illness' }));
    expectEqual(o.status, 200, 'setup override status');
    const q = await call('GET', '/api/queue');
    const list: IntakeSubmission[] = q.json.submissions;
    const rank = { high: 0, medium: 1, low: 2 } as const;
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1];
      const b = list[i];
      const ra = rank[a.finalUrgencyLevel];
      const rb = rank[b.finalUrgencyLevel];
      expect(ra <= rb, `row ${i - 1} (${a.finalUrgencyLevel}) is before row ${i} (${b.finalUrgencyLevel})`);
      if (ra === rb) {
        expect(
          new Date(a.submittedAt).getTime() <= new Date(b.submittedAt).getTime(),
          `same-urgency rows ${i - 1}/${i} are not oldest-first`,
        );
      }
    }
  });

  section('GET /api/queue/:id');
  await check('unknown (valid) UUID returns 404', async () => {
    const r = await call('GET', `/api/queue/${UNKNOWN_UUID}`);
    expectEqual(r.status, 404, 'status');
  });

  await check('malformed id returns 404, not 500', async () => {
    const r = await call('GET', '/api/queue/not-a-uuid');
    expectEqual(r.status, 404, 'status');
  });

  await check('detail has submission, classificationHistory and overrideLogs', async () => {
    expect(base, 'no base submission');
    const d = await detailOf(base.id);
    expectEqual(d.submission.id, base.id, 'submission id');
    expect(Array.isArray(d.classificationHistory), 'classificationHistory not an array');
    expect(Array.isArray(d.overrideLogs), 'overrideLogs not an array');
    expectEqual(d.overrideLogs.length, 0, 'fresh submission has no override logs');
  });

  // ---------------------------------------------------------------- confirm
  section('POST /api/queue/:id/confirm');
  await check('a reviewer name in the body is ignored: the signed-in user is recorded', async () => {
    const s = await createIntake('confirm-forged-name');
    const r = await call('POST', `/api/queue/${s.id}/confirm`, { confirmedBy: 'Dr. Forged' });
    expectEqual(r.status, 200, 'status');
    expectEqual(r.json.submission.reviewedBy, USERNAME, 'reviewedBy');
  });

  await check('unknown (valid) UUID returns 404', async () => {
    const r = await call('POST', `/api/queue/${UNKNOWN_UUID}/confirm`, {});
    expectEqual(r.status, 404, 'status');
  });

  await check('malformed id returns 404, not 500', async () => {
    const r = await call('POST', '/api/queue/not-a-uuid/confirm', {});
    expectEqual(r.status, 404, 'status');
  });

  let confirmed: IntakeSubmission | undefined;
  await check('valid confirm sets reviewed status and reviewer without changing the classification', async () => {
    const s = await createIntake('confirm-ok');
    const r = await call('POST', `/api/queue/${s.id}/confirm`, {});
    expectEqual(r.status, 200, 'status');
    const c: IntakeSubmission = r.json.submission;
    confirmed = c;
    expectEqual(c.reviewStatus, 'reviewed', 'reviewStatus');
    expectEqual(c.reviewedBy, USERNAME, 'reviewedBy is the signed-in user');
    expect(c.reviewedAt !== null, 'reviewedAt not set');
    expectEqual(c.finalUrgencyLevel, s.finalUrgencyLevel, 'final urgency unchanged');
    expectEqual(c.finalDepartment, s.finalDepartment, 'final department unchanged');
    const d = await detailOf(s.id);
    expectEqual(d.overrideLogs.length, 0, 'confirm should not create override logs');
  });

  await check('re-confirming an already-reviewed row does not overwrite the original reviewer', async () => {
    expect(confirmed, 'no confirmed submission');
    const r = await call('POST', `/api/queue/${confirmed.id}/confirm`, { confirmedBy: 'Someone Else' });
    expectEqual(r.status, 409, 'status');
    expect(typeof r.json?.error === 'string', 'error message present');
    const after = (await detailOf(confirmed.id)).submission;
    expectEqual(after.reviewedBy, USERNAME, 'reviewedBy after 2nd confirm');
  });

  await check('confirming an overridden row does not flip it back to "reviewed"', async () => {
    const s = await createIntake('confirm-after-override');
    const o = await call('POST', `/api/queue/${s.id}/override`, validOverride());
    expectEqual(o.status, 200, 'setup override status');
    const c = await call('POST', `/api/queue/${s.id}/confirm`, {});
    expectEqual(c.status, 409, 'status');
    const after = (await detailOf(s.id)).submission;
    expectEqual(after.reviewStatus, 'overridden', 'reviewStatus');
    expectEqual(after.reviewedBy, USERNAME, 'reviewedBy');
  });

  // ---------------------------------------------------------------- override validation
  section('POST /api/queue/:id/override — validation');
  const target = await createIntake('override-target');

  const badOverrides: [string, Record<string, unknown>][] = [
    ['missing newUrgencyLevel', { newUrgencyLevel: undefined }],
    ['unknown newUrgencyLevel', { newUrgencyLevel: 'critical' }],
    ['uppercase newUrgencyLevel', { newUrgencyLevel: 'HIGH' }],
    ['missing newDepartment', { newDepartment: undefined }],
    ['unknown newDepartment', { newDepartment: 'Cardiology' }],
    ['missing reason', { reason: undefined }],
    ['whitespace-only reason', { reason: '   \n ' }],
    ['reason over the length limit', { reason: 'x'.repeat(1001) }],
    ['reason with control characters', { reason: 'bad\u0000reason' }],
    ['numeric newUrgencyLevel', { newUrgencyLevel: 1 }],
    ['object newDepartment', { newDepartment: { a: 1 } }],
  ];
  for (const [label, patch] of badOverrides) {
    await check(`rejects ${label} with 400 and writes no audit row`, async () => {
      const before = (await detailOf(target.id)).overrideLogs.length;
      const r = await call('POST', `/api/queue/${target.id}/override`, validOverride(patch));
      expectEqual(r.status, 400, 'status');
      const after = await detailOf(target.id);
      expectEqual(after.overrideLogs.length, before, 'override log count');
      expectEqual(after.submission.reviewStatus, 'pending', 'reviewStatus untouched');
    });
  }

  await check('unknown (valid) UUID returns 404', async () => {
    const r = await call('POST', `/api/queue/${UNKNOWN_UUID}/override`, validOverride());
    expectEqual(r.status, 404, 'status');
  });

  await check('malformed id returns 404, not 500', async () => {
    const r = await call('POST', '/api/queue/not-a-uuid/override', validOverride());
    expectEqual(r.status, 404, 'status');
  });

  // ---------------------------------------------------------------- override behavior
  section('POST /api/queue/:id/override — behavior and audit trail');
  await check('override updates final_* only, sets overridden status, and logs previous → new', async () => {
    const s = await createIntake('override-ok');
    const r = await call('POST', `/api/queue/${s.id}/override`, validOverride({
      newUrgencyLevel: 'high',
      newDepartment: 'Refer to Emergency Room',
      reason: '  Vitals worse than intake text  ',
      overriddenBy: 'Dr. Forged', // must be ignored
    }));
    expectEqual(r.status, 200, 'status');
    const o: IntakeSubmission = r.json.submission;
    expectEqual(o.reviewStatus, 'overridden', 'reviewStatus');
    expectEqual(o.reviewedBy, USERNAME, 'reviewedBy is the signed-in user, not the name in the body');
    expectEqual(o.finalUrgencyLevel, 'high', 'finalUrgencyLevel');
    expectEqual(o.finalDepartment, 'Refer to Emergency Room', 'finalDepartment');
    // The original AI suggestion must be preserved for the audit trail.
    expectEqual(o.urgencyLevel, s.urgencyLevel, 'AI urgencyLevel preserved');
    expectEqual(o.suggestedDepartment, s.suggestedDepartment, 'AI suggestedDepartment preserved');
    expectEqual(o.confidenceScore, s.confidenceScore, 'AI confidenceScore preserved');

    const d = await detailOf(s.id);
    expectEqual(d.overrideLogs.length, 1, 'override log count');
    const log = d.overrideLogs[0];
    expectEqual(log.previousUrgencyLevel, s.finalUrgencyLevel, 'log previous urgency');
    expectEqual(log.previousDepartment, s.finalDepartment, 'log previous department');
    expectEqual(log.newUrgencyLevel, 'high', 'log new urgency');
    expectEqual(log.newDepartment, 'Refer to Emergency Room', 'log new department');
    expectEqual(log.reason, 'Vitals worse than intake text', 'log reason is trimmed');
    expectEqual(log.overriddenBy, USERNAME, 'audit log records the signed-in user, not the name in the body');
    expect(!!log.overriddenAt, 'log has no timestamp');
  });

  await check('chained overrides: each log\'s "previous" equals the prior log\'s "new"', async () => {
    const s = await createIntake('override-chain');
    const steps = [
      { newUrgencyLevel: 'low', newDepartment: 'Minor Illness' },
      { newUrgencyLevel: 'medium', newDepartment: 'Respiratory & ENT' },
      { newUrgencyLevel: 'high', newDepartment: 'Pediatric Care' },
    ];
    for (const [i, step] of steps.entries()) {
      const r = await call('POST', `/api/queue/${s.id}/override`, validOverride({ ...step, reason: `step ${i + 1}` }));
      expectEqual(r.status, 200, `step ${i + 1} status`);
    }
    const logs = (await detailOf(s.id)).overrideLogs;
    expectEqual(logs.length, 3, 'override log count');
    expectEqual(logs[0].previousUrgencyLevel, s.finalUrgencyLevel, 'first log previous urgency');
    for (let i = 1; i < logs.length; i++) {
      expectEqual(logs[i].previousUrgencyLevel, logs[i - 1].newUrgencyLevel, `log ${i} previous urgency`);
      expectEqual(logs[i].previousDepartment, logs[i - 1].newDepartment, `log ${i} previous department`);
    }
    expectEqual(logs.map((l) => l.reason).join('|'), 'step 1|step 2|step 3', 'logs are oldest-first');
  });

  await check('unicode, emoji, quotes and long reasons are stored intact', async () => {
    const s = await createIntake('override-unicode');
    const reason = `Pacientе dice "dolor" 胸痛 ✓ 🚑 ' OR 1=1 -- ${'x'.repeat(800)}`;
    const r = await call('POST', `/api/queue/${s.id}/override`, validOverride({ reason }));
    expectEqual(r.status, 200, 'status');
    expectEqual((await detailOf(s.id)).overrideLogs[0].reason, reason, 'stored reason');
  });

  await check('override moves the row in the queue (to low → after every non-low row)', async () => {
    const s = await createIntake('override-move');
    await call('POST', `/api/queue/${s.id}/override`, validOverride({ newUrgencyLevel: 'low' }));
    const list: IntakeSubmission[] = (await call('GET', '/api/queue')).json.submissions;
    const idx = list.findIndex((x) => x.id === s.id);
    expect(idx >= 0, 'row missing from queue');
    expect(list.slice(idx + 1).every((x) => x.finalUrgencyLevel === 'low'), 'a non-low row is sorted after a low row');
  });

  await check('override on a pending needs-review row clears "pending"', async () => {
    const s = await createIntake('override-clears-review');
    const r = await call('POST', `/api/queue/${s.id}/override`, validOverride());
    expectEqual(r.json.submission.reviewStatus, 'overridden', 'reviewStatus');
  });

  await check('a no-op override (same urgency + department) is rejected', async () => {
    const s = await createIntake('override-noop');
    const r = await call('POST', `/api/queue/${s.id}/override`, validOverride({
      newUrgencyLevel: s.finalUrgencyLevel,
      newDepartment: s.finalDepartment,
    }));
    expectEqual(r.status, 400, 'status');
  });

  await check('two concurrent overrides both succeed and the audit chain stays consistent', async () => {
    const s = await createIntake('override-race');
    const [a, b] = await Promise.all([
      call('POST', `/api/queue/${s.id}/override`, validOverride({ newUrgencyLevel: 'low', newDepartment: 'Minor Illness', reason: 'racer A' })),
      call('POST', `/api/queue/${s.id}/override`, validOverride({ newUrgencyLevel: 'high', newDepartment: 'Pediatric Care', reason: 'racer B' })),
    ]);
    expectEqual(a.status, 200, 'A status');
    expectEqual(b.status, 200, 'B status');
    const d = await detailOf(s.id);
    expectEqual(d.overrideLogs.length, 2, 'override log count');
    const [first, second] = d.overrideLogs;
    expectEqual(second.previousUrgencyLevel, first.newUrgencyLevel, 'second log previous urgency = first log new urgency');
    expectEqual(second.previousDepartment, first.newDepartment, 'second log previous department = first log new department');
    expectEqual(d.submission.finalUrgencyLevel, second.newUrgencyLevel, 'final urgency = last logged override');
    expectEqual(d.submission.finalDepartment, second.newDepartment, 'final department = last logged override');
  });

  // ---------------------------------------------------------------- config
  section('Configuration');
  await check('an invalid CONFIDENCE_THRESHOLD (NaN) still forces review of low-confidence cases', () => {
    expectEqual(isReviewRequired(0, Number('abc')), true, 'isReviewRequired(0, NaN)');
  });

  await check('CONFIDENCE_THRESHOLD parsing: default, valid values, and rejection of junk', () => {
    expectEqual(parseConfidenceThreshold(undefined), 0.7, 'unset');
    expectEqual(parseConfidenceThreshold(''), 0.7, 'empty');
    expectEqual(parseConfidenceThreshold('0.5'), 0.5, '0.5');
    for (const bad of ['abc', '-0.1', '1.5', 'NaN', 'Infinity']) {
      let threw = false;
      try {
        parseConfidenceThreshold(bad);
      } catch {
        threw = true;
      }
      expect(threw, `"${bad}" should be rejected`);
    }
  });

  // ---------------------------------------------------------------- wrong-typed fields
  section('Wrong-typed JSON fields (regression: these used to crash the server)');
  const wrongTypes: [string, (s: IntakeSubmission) => [string, unknown]][] = [
    ['intake with numeric patientName', () => ['/api/intake', { patientName: 123, symptomText: 'cough for a week' }]],
    ['intake with object symptomText', () => ['/api/intake', { patientName: 'EDGE-TEST x', symptomText: { a: 1 } }]],
    ['intake with array contactPhone', () => ['/api/intake', { patientName: 'EDGE-TEST x', symptomText: 'cough', contactPhone: ['1'] }]],
    ['override with numeric reason', (s) => [`/api/queue/${s.id}/override`, validOverride({ reason: 123 })]],
  ];
  const victim = await createIntake('wrong-types');
  for (const [label, build] of wrongTypes) {
    await check(`${label} returns 400 and the server stays up`, async () => {
      const [path, body] = build(victim);
      const r = await call('POST', path, body);
      expectEqual(r.status, 400, 'status');
      const alive = await call('GET', '/api/health').then((h) => h.status === 200, () => false);
      expect(alive, 'server is DOWN after this request');
    });
  }
  await check('confirm with a non-string body value is harmless (the body is ignored)', async () => {
    const r = await call('POST', `/api/queue/${victim.id}/confirm`, { confirmedBy: 123 });
    expectEqual(r.status, 200, 'status');
  });

  return suite.summary();
}

main().catch((err) => {
  console.error('Unexpected error in test runner:', err);
  process.exit(2);
});
