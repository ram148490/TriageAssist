import assert from 'assert';
import { isReviewRequired, parseConfidenceThreshold, urgencyRank } from '../shared/logic';

// urgencyRank orders high before medium before low.
assert.strictEqual(urgencyRank('high'), 0);
assert.strictEqual(urgencyRank('medium'), 1);
assert.strictEqual(urgencyRank('low'), 2);
assert.ok(urgencyRank('high') < urgencyRank('medium'));
assert.ok(urgencyRank('medium') < urgencyRank('low'));

// isReviewRequired: mandatory review below threshold, never above.
assert.strictEqual(isReviewRequired(0.5, 0.7), true);
assert.strictEqual(isReviewRequired(0.7, 0.7), false); // exactly at threshold is trusted
assert.strictEqual(isReviewRequired(0.9, 0.7), false);
assert.strictEqual(isReviewRequired(0, 0.7), true);

// Fail safe: NaN (a mistyped threshold or a garbage score) forces review rather than disabling it.
assert.strictEqual(isReviewRequired(0, NaN), true);
assert.strictEqual(isReviewRequired(NaN, 0.7), true);

// parseConfidenceThreshold: default when unset, strict validation otherwise.
assert.strictEqual(parseConfidenceThreshold(undefined), 0.7);
assert.strictEqual(parseConfidenceThreshold('  '), 0.7);
assert.strictEqual(parseConfidenceThreshold('0.5'), 0.5);
assert.strictEqual(parseConfidenceThreshold('0'), 0);
assert.strictEqual(parseConfidenceThreshold('1'), 1);
for (const bad of ['abc', '-0.1', '1.01', 'NaN', 'Infinity']) {
  assert.throws(() => parseConfidenceThreshold(bad), /CONFIDENCE_THRESHOLD/, `"${bad}" should be rejected`);
}

console.log('test-logic: all assertions passed.');
