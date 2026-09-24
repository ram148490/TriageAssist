import type { UrgencyLevel } from './types';

const RANK: Record<UrgencyLevel, number> = { high: 0, medium: 1, low: 2 };

/** Lower rank = seen sooner. Mirrors the ORDER BY CASE used in the queue SQL query. */
export function urgencyRank(level: UrgencyLevel): number {
  return RANK[level];
}

/** A classification below the confidence threshold always requires human review. */
export function isReviewRequired(confidenceScore: number, threshold: number): boolean {
  return confidenceScore < threshold;
}
