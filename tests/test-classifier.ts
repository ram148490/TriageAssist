import assert from 'assert';

// Run with no GEMINI_API_KEY so classifySymptoms takes the unavailable-fallback path.
delete process.env.GEMINI_API_KEY;

const { classifySymptoms, PROMPT_VERSION } = await import('../server/lib/classifier');
const { FALLBACK_MODEL_NAME } = await import('../shared/types');
const { isReviewRequired } = await import('../shared/logic');

const result = await classifySymptoms('patient reports a headache');

// Safety property: when classification is not trustworthy (no API key configured
// here), confidence must be pinned low enough to force mandatory human review —
// the app must never silently auto-route a case it failed to classify.
assert.strictEqual(result.confidenceScore, 0);
assert.strictEqual(isReviewRequired(result.confidenceScore, 0.7), true);
assert.strictEqual(result.promptVersion, PROMPT_VERSION);

// The fallback must default to "high", not a middle-ground guess: the queue
// sorts by urgency, so anything less than "high" here would let an
// unclassifiable case sort behind cases the system actually did classify.
assert.strictEqual(result.urgencyLevel, 'high');

// ---------------------------------------------------------------------------
// Failure injection. The fail-safe must hold for EVERY way the AI call can go
// wrong, and the call must never hang or throw. Each case below injects a fake
// Gemini client and expects the identical fail-safe result.
// ---------------------------------------------------------------------------
const unhandled: unknown[] = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

const SHORT_TIMEOUT_MS = 150;
const okText = (o: unknown) => JSON.stringify(o);
const goodPayload = { urgencyLevel: 'low', suggestedDepartment: 'Minor Illness', confidenceScore: 0.9 };
const fakeClient = (generateContent: (params: any) => Promise<{ text?: string }>) => ({ models: { generateContent } });

function assertFailSafe(r: Awaited<ReturnType<typeof classifySymptoms>>, label: string) {
  assert.strictEqual(r.urgencyLevel, 'high', `${label}: urgency`);
  assert.strictEqual(r.confidenceScore, 0, `${label}: confidence`);
  assert.strictEqual(r.modelName, FALLBACK_MODEL_NAME, `${label}: modelName`);
  assert.strictEqual(isReviewRequired(r.confidenceScore, 0.7), true, `${label}: review required`);
}

const failureCases: [string, () => Promise<{ text?: string }>][] = [
  ['rejects (network/HTTP error)', () => Promise.reject(new Error('503 UNAVAILABLE'))],
  ['throws synchronously', () => { throw new Error('boom'); }],
  ['rejects with a non-Error value', () => Promise.reject('string rejection')],
  ['returns undefined', () => Promise.resolve(undefined as any)],
  ['returns no text', () => Promise.resolve({})],
  ['returns empty text', () => Promise.resolve({ text: '' })],
  ['returns non-JSON text', () => Promise.resolve({ text: 'Sorry, I cannot help with that.' })],
  ['returns markdown-fenced JSON', () => Promise.resolve({ text: '```json\n' + okText(goodPayload) + '\n```' })],
  ['returns JSON null', () => Promise.resolve({ text: 'null' })],
  ['returns a JSON array', () => Promise.resolve({ text: '[]' })],
  ['returns a JSON string', () => Promise.resolve({ text: '"low"' })],
  ['returns {}', () => Promise.resolve({ text: '{}' })],
  ['returns an unknown urgency', () => Promise.resolve({ text: okText({ ...goodPayload, urgencyLevel: 'critical' }) })],
  ['returns an unknown department', () => Promise.resolve({ text: okText({ ...goodPayload, suggestedDepartment: 'Cardiology' }) })],
  ['returns a string confidence', () => Promise.resolve({ text: okText({ ...goodPayload, confidenceScore: '0.9' }) })],
  ['returns a null confidence', () => Promise.resolve({ text: okText({ ...goodPayload, confidenceScore: null }) })],
  ['never responds (hang)', () => new Promise<{ text?: string }>(() => {})],
  // The abort/late rejection that arrives after the deadline must not become an unhandled rejection.
  ['rejects late, after the deadline', () => new Promise<{ text?: string }>((_, rej) => setTimeout(() => rej(new Error('late')), SHORT_TIMEOUT_MS * 3))],
];

for (const [label, generate] of failureCases) {
  const started = Date.now();
  const r = await classifySymptoms('chest pain, trouble breathing', fakeClient(generate), SHORT_TIMEOUT_MS);
  const elapsed = Date.now() - started;
  assertFailSafe(r, label);
  assert.ok(elapsed < SHORT_TIMEOUT_MS * 4, `${label}: took ${elapsed}ms, expected to give up by ~${SHORT_TIMEOUT_MS}ms`);
}

// A hung call is cancelled, not just abandoned: the abort signal must fire.
{
  let sawAbort = false;
  await classifySymptoms(
    'x',
    fakeClient((params) => {
      params.config.abortSignal.addEventListener('abort', () => { sawAbort = true; });
      return new Promise(() => {});
    }),
    SHORT_TIMEOUT_MS,
  );
  assert.ok(sawAbort, 'the abort signal should fire when the deadline passes');
}

// Happy path is untouched by the deadline logic, and out-of-range confidence is clamped, not rejected.
{
  const ok = await classifySymptoms('mild headache', fakeClient(() => Promise.resolve({ text: okText(goodPayload) })), SHORT_TIMEOUT_MS);
  assert.strictEqual(ok.urgencyLevel, 'low');
  assert.strictEqual(ok.suggestedDepartment, 'Minor Illness');
  assert.strictEqual(ok.confidenceScore, 0.9);
  assert.notStrictEqual(ok.modelName, FALLBACK_MODEL_NAME);

  const high = await classifySymptoms('x', fakeClient(() => Promise.resolve({ text: okText({ ...goodPayload, confidenceScore: 7 }) })), SHORT_TIMEOUT_MS);
  assert.strictEqual(high.confidenceScore, 1);
  const neg = await classifySymptoms('x', fakeClient(() => Promise.resolve({ text: okText({ ...goodPayload, confidenceScore: -3 }) })), SHORT_TIMEOUT_MS);
  assert.strictEqual(neg.confidenceScore, 0);
}

// Let any late rejections from the cases above surface, then make sure none escaped.
await new Promise((r) => setTimeout(r, SHORT_TIMEOUT_MS * 4));
assert.deepStrictEqual(unhandled, [], 'no unhandled rejections may escape the classifier');

console.log('test-classifier: all assertions passed.');
