/**
 * API edge-case checks for TriageAssist. Unlike the other tests, this one needs
 * a RUNNING server + Postgres (`npm run dev`), and it WRITES rows to that database
 * (patient names are prefixed "EDGE-TEST" so they're easy to find and delete).
 * There is no delete endpoint, so don't point it at real data.
 *
 *   npm run test:api                          # against http://localhost:3000
 *   BASE_URL=http://localhost:4000 npm run test:api
 *   npm run test:api -- --strict              # treat GAPs as failures too
 *   npm run test:api -- --include-crash       # also send inputs that may crash the server
 *
 * Result kinds:
 *   PASS  behaved as intended
 *   FAIL  a hard expectation was broken (exit code 1)
 *   GAP   a suspected bug / design decision: the code currently appears to behave
 *         differently from what a reviewer would want. Reported, but only fails the
 *         run with --strict.
 *   SKIP  precondition not met (e.g. no Gemini key, so classification isn't deterministic)
 */
import { isReviewRequired, parseConfidenceThreshold } from '../shared/logic';
import { DEPARTMENTS, type IntakeDetail, type IntakeSubmission } from '../shared/types';

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const STRICT = process.argv.includes('--strict');
const INCLUDE_CRASH = process.argv.includes('--include-crash');

const RUN_ID = Date.now().toString(36);
const MARKER = `edge-marker-${RUN_ID}`; // unique text used to prove symptom text is never echoed back
const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000';

type Kind = 'PASS' | 'FAIL' | 'GAP' | 'SKIP';
const results: { kind: Kind; name: string; detail?: string }[] = [];

class Skip extends Error {}
const skip = (why: string): never => {
  throw new Skip(why);
};

async function check(name: string, fn: () => Promise<void> | void, opts: { gap?: boolean } = {}) {
  try {
    await fn();
    results.push({ kind: 'PASS', name });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    if (err instanceof Skip) {
      results.push({ kind: 'SKIP', name, detail: err.message });
      console.log(`  SKIP  ${name} — ${err.message}`);
      return;
    }
    const detail = err instanceof Error ? err.message : String(err);
    const kind: Kind = opts.gap ? 'GAP' : 'FAIL';
    results.push({ kind, name, detail });
    console.log(`  ${kind}  ${name}\n          ${detail}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function expectEqual<T>(actual: T, expected: T, what: string) {
  expect(actual === expected, `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

interface Reply {
  status: number;
  text: string;
  json: any;
}

async function call(method: string, path: string, body?: unknown, raw?: string): Promise<Reply> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON body (e.g. an HTML error page) — leave json null
  }
  return { status: res.status, text, json };
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
  overriddenBy: 'Edge Tester',
  ...over,
});

async function main() {
  console.log(`TriageAssist API edge cases → ${BASE_URL}  (run ${RUN_ID}${STRICT ? ', strict' : ''})`);

  // ---------------------------------------------------------------- health
  section('Health');
  try {
    const h = await call('GET', '/api/health');
    expectEqual(h.status, 200, 'health status');
  } catch (err) {
    console.error(`\nCannot reach ${BASE_URL}/api/health — is "npm run dev" running with Postgres up?\n${err}`);
    process.exit(2);
  }
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
    expectEqual(h.promptVersion, 'triage-classify-v1', 'promptVersion');
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
  await check('missing confirmedBy returns 400', async () => {
    const s = await createIntake('confirm-missing');
    const r = await call('POST', `/api/queue/${s.id}/confirm`, {});
    expectEqual(r.status, 400, 'status');
  });

  await check('whitespace-only confirmedBy returns 400', async () => {
    const s = await createIntake('confirm-blank');
    const r = await call('POST', `/api/queue/${s.id}/confirm`, { confirmedBy: '   ' });
    expectEqual(r.status, 400, 'status');
  });

  await check('unknown (valid) UUID returns 404', async () => {
    const r = await call('POST', `/api/queue/${UNKNOWN_UUID}/confirm`, { confirmedBy: 'Edge Tester' });
    expectEqual(r.status, 404, 'status');
  });

  await check('malformed id returns 404, not 500', async () => {
    const r = await call('POST', '/api/queue/not-a-uuid/confirm', { confirmedBy: 'Edge Tester' });
    expectEqual(r.status, 404, 'status');
  });

  let confirmed: IntakeSubmission | undefined;
  await check('valid confirm sets reviewed status and reviewer without changing the classification', async () => {
    const s = await createIntake('confirm-ok');
    const r = await call('POST', `/api/queue/${s.id}/confirm`, { confirmedBy: '  Nurse A  ' });
    expectEqual(r.status, 200, 'status');
    const c: IntakeSubmission = r.json.submission;
    confirmed = c;
    expectEqual(c.reviewStatus, 'reviewed', 'reviewStatus');
    expectEqual(c.reviewedBy, 'Nurse A', 'reviewedBy is trimmed');
    expect(c.reviewedAt !== null, 'reviewedAt not set');
    expectEqual(c.finalUrgencyLevel, s.finalUrgencyLevel, 'final urgency unchanged');
    expectEqual(c.finalDepartment, s.finalDepartment, 'final department unchanged');
    const d = await detailOf(s.id);
    expectEqual(d.overrideLogs.length, 0, 'confirm should not create override logs');
  });

  await check('re-confirming an already-reviewed row does not overwrite the original reviewer', async () => {
    expect(confirmed, 'no confirmed submission');
    const r = await call('POST', `/api/queue/${confirmed.id}/confirm`, { confirmedBy: 'Nurse B' });
    expectEqual(r.status, 409, 'status');
    expect(typeof r.json?.error === 'string', 'error message present');
    const after = (await detailOf(confirmed.id)).submission;
    expectEqual(after.reviewedBy, 'Nurse A', 'reviewedBy after 2nd confirm');
  });

  await check('confirming an overridden row does not flip it back to "reviewed"', async () => {
    const s = await createIntake('confirm-after-override');
    const o = await call('POST', `/api/queue/${s.id}/override`, validOverride());
    expectEqual(o.status, 200, 'setup override status');
    const c = await call('POST', `/api/queue/${s.id}/confirm`, { confirmedBy: 'Nurse C' });
    expectEqual(c.status, 409, 'status');
    const after = (await detailOf(s.id)).submission;
    expectEqual(after.reviewStatus, 'overridden', 'reviewStatus');
    expectEqual(after.reviewedBy, 'Edge Tester', 'reviewedBy');
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
    ['missing overriddenBy', { overriddenBy: undefined }],
    ['whitespace-only overriddenBy', { overriddenBy: '  ' }],
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
      overriddenBy: '  Dr. Edge  ',
    }));
    expectEqual(r.status, 200, 'status');
    const o: IntakeSubmission = r.json.submission;
    expectEqual(o.reviewStatus, 'overridden', 'reviewStatus');
    expectEqual(o.reviewedBy, 'Dr. Edge', 'reviewedBy');
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
    expectEqual(log.overriddenBy, 'Dr. Edge', 'log overriddenBy is trimmed');
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
    const reason = `Pacientе dice "dolor" 胸痛 ✓ 🚑 ' OR 1=1 -- ${'x'.repeat(5000)}`;
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
    // intake.routes.ts does Number(process.env.CONFIDENCE_THRESHOLD ?? 0.7); a typo like "abc"
    // becomes NaN, and `confidence < NaN` is always false, so NOTHING would be flagged for review.
    const threshold = Number('abc');
    expectEqual(isReviewRequired(0, threshold), true, 'isReviewRequired(0, NaN)');
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

  // ---------------------------------------------------------------- crash-prone inputs
  section('Wrong-typed JSON fields (regression: used to crash the server — needs --include-crash)');
  if (!INCLUDE_CRASH) {
    console.log('  SKIP  not run. Non-string fields hit .trim() outside the try/catch in an async Express 4 handler;');
    console.log('        pass --include-crash to test whether one bad request can take the whole server down.');
    results.push({ kind: 'SKIP', name: 'wrong-typed JSON fields', detail: 'needs --include-crash' });
  } else {
    const wrongTypes: [string, string, unknown, (s: IntakeSubmission) => string][] = [
      ['intake with numeric patientName', '/api/intake', { patientName: 123, symptomText: 'cough for a week' }, () => '/api/intake'],
      ['intake with object symptomText', '/api/intake', { patientName: 'EDGE-TEST x', symptomText: { a: 1 } }, () => '/api/intake'],
      ['confirm with numeric confirmedBy', '', { confirmedBy: 123 }, (s) => `/api/queue/${s.id}/confirm`],
      ['override with numeric reason', '', validOverride({ reason: 123 }), (s) => `/api/queue/${s.id}/override`],
    ];
    const victim = await createIntake('wrong-types');
    for (const [label, fixedPath, body, pathFor] of wrongTypes) {
      await check(`${label} returns 400 and the server stays up`, async () => {
        const path = fixedPath || pathFor(victim);
        let status = 0;
        try {
          status = (await call('POST', path, body)).status;
        } catch (err) {
          // Connection reset / timeout: the request died without a response.
          throw new Error(`no response (${err instanceof Error ? err.message : err}) — server may have crashed`);
        }
        const alive = await call('GET', '/api/health').then((h) => h.status === 200, () => false);
        expect(alive, `server is DOWN after this request (status was ${status}) — restart "npm run dev"`);
        expectEqual(status, 400, 'status');
      });
    }
  }

  // ---------------------------------------------------------------- summary
  const count = (k: Kind) => results.filter((r) => r.kind === k).length;
  console.log(`\n${count('PASS')} passed, ${count('FAIL')} failed, ${count('GAP')} gaps, ${count('SKIP')} skipped`);
  const gaps = results.filter((r) => r.kind === 'GAP');
  if (gaps.length) {
    console.log('\nGaps (suspected bugs / decisions to make):');
    for (const g of gaps) console.log(`  - ${g.name}`);
  }
  console.log(`\nTest rows are named "EDGE-TEST … ${RUN_ID}" — delete with: DELETE FROM intake_submissions WHERE patient_name LIKE 'EDGE-TEST%';`);

  const failed = count('FAIL') > 0 || (STRICT && gaps.length > 0);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('Unexpected error in test runner:', err);
  process.exit(2);
});
