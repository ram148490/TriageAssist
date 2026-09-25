import type { UrgencyLevel } from './types';

const RANK: Record<UrgencyLevel, number> = { high: 0, medium: 1, low: 2 };

/** Lower rank = seen sooner. Mirrors the ORDER BY CASE used in the queue SQL query. */
export function urgencyRank(level: UrgencyLevel): number {
  return RANK[level];
}

/**
 * A classification below the confidence threshold always requires human review.
 * Written as a negated `>=` so it fails safe: a NaN score or NaN threshold
 * (e.g. a mistyped CONFIDENCE_THRESHOLD) forces review instead of silently
 * disabling it, since every comparison against NaN is false.
 */
export function isReviewRequired(confidenceScore: number, threshold: number): boolean {
  return !(confidenceScore >= threshold);
}

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

/** Parses CONFIDENCE_THRESHOLD, throwing on anything that isn't a number in [0, 1]. */
export function parseConfidenceThreshold(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_CONFIDENCE_THRESHOLD;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid CONFIDENCE_THRESHOLD "${raw}": must be a number between 0 and 1.`);
  }
  return value;
}
