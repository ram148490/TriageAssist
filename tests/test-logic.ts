import assert from 'assert';
import { isReviewRequired, urgencyRank } from '../shared/logic';

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

console.log('test-logic: all assertions passed.');
