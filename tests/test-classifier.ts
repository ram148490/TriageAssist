import assert from 'assert';

// Run with no GEMINI_API_KEY so classifySymptoms takes the unavailable-fallback path.
delete process.env.GEMINI_API_KEY;

const { classifySymptoms, PROMPT_VERSION } = await import('../server/lib/classifier');
const { isReviewRequired } = await import('../shared/logic');

const result = await classifySymptoms('patient reports a headache');

// Safety property: when classification is not trustworthy (no API key configured
// here), confidence must be pinned low enough to force mandatory human review —
// the app must never silently auto-route a case it failed to classify.
assert.strictEqual(result.confidenceScore, 0);
assert.strictEqual(isReviewRequired(result.confidenceScore, 0.7), true);
assert.strictEqual(result.promptVersion, PROMPT_VERSION);
assert.ok(['high', 'medium', 'low'].includes(result.urgencyLevel));

console.log('test-classifier: all assertions passed.');
